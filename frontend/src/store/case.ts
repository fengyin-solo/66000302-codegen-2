import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useFEAStore } from './fea';
import type {
  CaseMeta,
  CasePackage,
  CaseSectionId,
  CaseSectionSelection,
  CaseStats,
} from '../types/case';
import { CASE_SECTION_LABELS, CASE_SECTION_ORDER } from '../types/case';
import {
  ageInDays,
  downloadCaseFile,
  formatLocalDate,
  hasSection,
  loadCaseIndex,
  measureSectionBytes,
  readLoads,
  readModel,
  readResults,
  removeCaseSections,
  saveCaseIndex,
  utf8Bytes,
  writeSection,
  type FaultMode,
} from '../utils/case-storage';
import { snapshotLoads, snapshotModel, snapshotResult } from '../types/case';

const RETENTION_KEY = 'fea-case:v1:retentionDays';
const DEFAULT_RETENTION_DAYS = 30;

function emptyStats(): CaseStats {
  return {
    nodeCount: 0,
    elementCount: 0,
    loadCount: 0,
    extreme: { maxStress: null, maxDisplacement: null, maxLoadMagnitude: 0 },
  };
}

function zeroSectionBytes(): Record<CaseSectionId, number> {
  return { model: 0, loads: 0, results: 0 };
}

export const useCaseStore = defineStore('case-archive', () => {
  const fea = useFEAStore();

  // ─── 列表 ─────────────────────────────────────────────────────────────────
  const cases = ref<CaseMeta[]>([]);
  const casesLoaded = ref(false);

  // ─── 导出过程状态（挡住重复提交）────────────────────────────────────────────
  const isExporting = ref(false);
  const exportingId = ref<string | null>(null);
  const exportStatus = ref<string>('');
  /** 最近一次导出失败：保存草稿信息，供“重试 / 放弃”使用 */
  const lastFailure = ref<{
    id: string;
    name: string;
    missing: CaseSectionId[];
    message: string;
  } | null>(null);

  // ─── 保留期与清理 ─────────────────────────────────────────────────────────
  const retentionDays = ref<number>(loadRetention());

  function loadRetention(): number {
    const raw = localStorage.getItem(RETENTION_KEY);
    const n = raw === null ? DEFAULT_RETENTION_DAYS : Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_RETENTION_DAYS;
  }

  function setRetentionDays(days: number) {
    retentionDays.value = days;
    localStorage.setItem(RETENTION_KEY, String(days));
  }

  const expiredCases = computed(() =>
    cases.value.filter((c) => ageInDays(c.createdAt) > retentionDays.value)
  );

  // ─── 预览统计（导出前展示：节点数、构件数、极值读数、文件体积）─────────────────
  const previewStats = computed<CaseStats>(() => {
    const m = fea.model;
    let maxLoadMagnitude = 0;
    for (const l of m.loads) {
      maxLoadMagnitude = Math.max(
        maxLoadMagnitude,
        Math.sqrt(l.fx * l.fx + l.fy * l.fy)
      );
    }
    return {
      nodeCount: m.nodes.length,
      elementCount: m.elements.length,
      loadCount: m.loads.length,
      extreme: {
        maxStress: fea.result ? fea.result.maxStress : null,
        maxDisplacement: fea.result ? fea.result.maxDisplacement : null,
        maxLoadMagnitude,
      },
    };
  });

  /** 按勾选内容估算导出文件体积（含元信息封装开销） */
  function estimateBytes(selection: CaseSectionSelection): number {
    let bytes = 0;
    if (selection.model) bytes += measureSectionBytes(snapshotModel(fea.model));
    if (selection.loads) bytes += measureSectionBytes(snapshotLoads(fea.model));
    if (selection.results && fea.result)
      bytes += measureSectionBytes(snapshotResult(fea.result));
    // meta 部分开销（按实际结构占位估算）
    const metaStub = {
      format: 'fea-case/v1',
      meta: {
        id: 'xxxxxxxxxxxx',
        name: 'x'.repeat(20),
        createdAt: new Date().toISOString(),
        createdDate: formatLocalDate(),
        preset: 'custom',
        sections: { ...selection },
        stats: previewStats.value,
        sectionBytes: { model: bytes, loads: 0, results: 0 },
        totalBytes: 0,
        status: 'complete' as const,
      },
    };
    // 离线文件是 JSON.stringify(pkg, null, 2)，缩进会增加体积，按 12% 上浮估算
    return Math.round((bytes + utf8Bytes(JSON.stringify(metaStub))) * 1.12);
  }

  // ─── 列表读取 / 校正 ───────────────────────────────────────────────────────
  function refreshCases() {
    const list = loadCaseIndex();
    // 逐条对账：列表显示的节点数 / 构件数以段落里实际存下的数据为准，
    // 段落缺失则不把它算进去 —— 列表与画布载入后所见始终一致。
    cases.value = list.map((meta) => reconcileMeta(meta));
    casesLoaded.value = true;
  }

  function reconcileMeta(meta: CaseMeta): CaseMeta {
    const sections = { ...meta.sections };
    const sectionBytes = { ...zeroSectionBytes(), ...meta.sectionBytes };
    const stats = emptyStats();
    let hasModelData = false;

    if (sections.model && hasSection(meta.id, 'model')) {
      const snap = readModel(meta.id);
      if (snap) {
        stats.nodeCount = snap.nodes.length;
        stats.elementCount = snap.elements.length;
        hasModelData = true;
      }
    }
    if (hasModelData && sections.loads && hasSection(meta.id, 'loads')) {
      const loads = readLoads(meta.id);
      if (loads) {
        stats.loadCount = loads.length;
        stats.extreme.maxLoadMagnitude = loads.reduce(
          (mx, l) => Math.max(mx, Math.sqrt(l.fx * l.fx + l.fy * l.fy)),
          0
        );
      }
    }
    if (sections.results && hasSection(meta.id, 'results')) {
      const r = readResults(meta.id);
      if (r) {
        stats.extreme.maxStress = r.maxStress;
        stats.extreme.maxDisplacement = r.maxDisplacement;
      }
    }
    if (!hasModelData) {
      stats.extreme.maxStress = null;
      stats.extreme.maxDisplacement = null;
    }

    const missing: CaseSectionId[] = [];
    for (const s of CASE_SECTION_ORDER) {
      if (sections[s] && !hasSection(meta.id, s)) missing.push(s);
    }

    return {
      ...meta,
      stats,
      sectionBytes,
      status: missing.length > 0 ? 'partial' : 'complete',
      missingSections: missing.length > 0 ? missing : undefined,
    };
  }

  function persistMeta(meta: CaseMeta) {
    const list = loadCaseIndex();
    const idx = list.findIndex((m) => m.id === meta.id);
    if (idx >= 0) list[idx] = meta;
    else list.unshift(meta);
    saveCaseIndex(list);
    refreshCases();
  }

  // ─── 导出：首次 ───────────────────────────────────────────────────────────
  async function exportCase(
    name: string,
    selection: CaseSectionSelection,
    fault: FaultMode = 'none'
  ): Promise<{ ok: boolean; error?: string }> {
    // 挡住重复提交
    if (isExporting.value) {
      return { ok: false, error: '正在导出中，请等待当前算例写完' };
    }
    if (!selection.model && !selection.loads && !selection.results) {
      return { ok: false, error: '请至少勾选一项要收进算例的内容' };
    }
    if (selection.results && !fea.result) {
      return { ok: false, error: '结果尚未求解，无法收录结果部分' };
    }

    const id = genId();
    const now = new Date();
    const wanted: CaseSectionId[] = CASE_SECTION_ORDER.filter((s) => selection[s]);

    isExporting.value = true;
    exportingId.value = id;
    lastFailure.value = null;

    const written = new Set<CaseSectionId>();
    const sectionBytes = zeroSectionBytes();

    // 按 模型 → 载荷 → 结果 顺序逐段落盘
    for (const section of wanted) {
      exportStatus.value = `正在写入${CASE_SECTION_LABELS[section]}…`;
      let data: unknown;
      if (section === 'model') data = snapshotModel(fea.model);
      else if (section === 'loads') data = snapshotLoads(fea.model);
      else data = snapshotResult(fea.result!);

      // 让出事件循环，使“导出中”状态可以渲染
      await tick();
      try {
        sectionBytes[section] = writeSection(id, section, data, fault);
        written.add(section);
      } catch (e) {
        // 中途失败：已写入的段落原样保留，后面说明缺了什么并允许重来
        const message = e instanceof Error ? e.message : String(e);
        const missing = wanted.filter((s) => !written.has(s));
        const meta = buildMeta({
          id,
          name,
          now,
          selection,
          sectionBytes,
          status: 'partial',
          lastError: message,
        });
        persistMeta(meta);
        lastFailure.value = { id, name, missing, message };
        isExporting.value = false;
        exportingId.value = null;
        exportStatus.value = '';
        return { ok: false, error: message };
      }
    }

    // 全部段落写完后再登记列表，然后打包离线文件
    const meta = buildMeta({
      id,
      name,
      now,
      selection,
      sectionBytes,
      status: 'complete',
    });
    persistMeta(meta);

    exportStatus.value = '正在生成离线文件…';
    await tick();
    try {
      downloadCaseFile(assemblePackage(meta));
    } catch (e) {
      // 文件下载失败不影响本地归档
      exportStatus.value = '';
      isExporting.value = false;
      exportingId.value = null;
      return {
        ok: true,
        error: `算例已保存到本地归档，但离线文件下载失败：${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }

    isExporting.value = false;
    exportingId.value = null;
    exportStatus.value = '';
    return { ok: true };
  }

  // ─── 导出：失败后重试（只补写缺失段落，原算例保持同一条）──────────────────────
  async function retryExport(fault: FaultMode = 'none'): Promise<{ ok: boolean; error?: string }> {
    const failure = lastFailure.value;
    if (!failure) return { ok: false, error: '没有待重试的导出' };
    if (isExporting.value) {
      return { ok: false, error: '正在导出中，请等待当前算例写完' };
    }

    const metaStored = loadCaseIndex().find((m) => m.id === failure.id);
    if (!metaStored) {
      lastFailure.value = null;
      return { ok: false, error: '原算例记录已不存在，请重新导出' };
    }

    isExporting.value = true;
    exportingId.value = failure.id;

    const meta = reconcileMeta(metaStored);
    const sectionBytes = { ...zeroSectionBytes(), ...meta.sectionBytes };

    for (const section of meta.missingSections ?? []) {
      exportStatus.value = `正在补写${CASE_SECTION_LABELS[section]}…`;
      let data: unknown;
      if (section === 'model') data = snapshotModel(fea.model);
      else if (section === 'loads') data = snapshotLoads(fea.model);
      else data = snapshotResult(fea.result!);

      if (section === 'results' && !fea.result) {
        isExporting.value = false;
        exportingId.value = null;
        exportStatus.value = '';
        return { ok: false, error: '结果尚未求解，无法补写结果部分' };
      }

      await tick();
      try {
        sectionBytes[section] = writeSection(failure.id, section, data, fault);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const updated = reconcileMeta({
          ...meta,
          sectionBytes,
          lastError: message,
        });
        persistMeta(updated);
        lastFailure.value = {
          id: failure.id,
          name: failure.name,
          missing: updated.missingSections ?? [],
          message,
        };
        isExporting.value = false;
        exportingId.value = null;
        exportStatus.value = '';
        return { ok: false, error: message };
      }
    }

    const completed = reconcileMeta({
      ...meta,
      sectionBytes,
      status: 'complete',
      lastError: undefined,
    });
    persistMeta(completed);

    exportStatus.value = '正在生成离线文件…';
    await tick();
    try {
      downloadCaseFile(assemblePackage(completed));
    } catch (e) {
      lastFailure.value = null;
      isExporting.value = false;
      exportingId.value = null;
      exportStatus.value = '';
      return {
        ok: true,
        error: `算例已补全并保存，但离线文件下载失败：${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }

    lastFailure.value = null;
    isExporting.value = false;
    exportingId.value = null;
    exportStatus.value = '';
    return { ok: true };
  }

  /** 放弃失败草稿：删掉不完整算例及其段落，画布与其他归档不受影响 */
  function discardFailure() {
    const failure = lastFailure.value;
    if (!failure) return;
    const list = loadCaseIndex().filter((m) => m.id !== failure.id);
    saveCaseIndex(list);
    removeCaseSections(failure.id);
    lastFailure.value = null;
    refreshCases();
  }

  // ─── 载入 / 下载 / 删除 ───────────────────────────────────────────────────
  /** 把归档算例恢复到画布；返回实际恢复了哪些部分 */
  function loadToCanvas(meta: CaseMeta): {
    restoredModel: boolean;
    restoredLoads: boolean;
    restoredResults: boolean;
  } {
    const modelSnap = meta.sections.model ? readModel(meta.id) : null;
    const loads = meta.sections.loads ? readLoads(meta.id) : null;
    const result = meta.sections.results ? readResults(meta.id) : null;
    return fea.loadCaseSnapshot({
      model: modelSnap ?? undefined,
      loads: loads ?? undefined,
      result: result ?? undefined,
    });
  }

  function downloadArchived(meta: CaseMeta): void {
    downloadCaseFile(assemblePackage(reconcileMeta(meta)));
  }

  function deleteCase(id: string) {
    const list = loadCaseIndex().filter((m) => m.id !== id);
    saveCaseIndex(list);
    removeCaseSections(id);
    if (lastFailure.value?.id === id) lastFailure.value = null;
    refreshCases();
  }

  /** 清理超过保留期的算例。调用方须先经用户确认（条目已由 expiredCases 列出） */
  function cleanupExpired(): { deleted: CaseMeta[] } {
    const ids = new Set(expiredCases.value.map((c) => c.id));
    const deleted = cases.value.filter((c) => ids.has(c.id));
    const list = loadCaseIndex().filter((m) => !ids.has(m.id));
    saveCaseIndex(list);
    for (const id of ids) removeCaseSections(id);
    if (lastFailure.value && ids.has(lastFailure.value.id)) {
      lastFailure.value = null;
    }
    refreshCases();
    return { deleted };
  }

  // ─── 内部助手 ─────────────────────────────────────────────────────────────
  function buildMeta(args: {
    id: string;
    name: string;
    now: Date;
    selection: CaseSectionSelection;
    sectionBytes: Record<CaseSectionId, number>;
    status: 'complete' | 'partial';
    lastError?: string;
  }): CaseMeta {
    const m = reconcileMeta({
      id: args.id,
      name: args.name,
      createdAt: args.now.toISOString(),
      createdDate: formatLocalDate(args.now),
      preset: fea.selectedPreset,
      sections: { ...args.selection },
      stats: emptyStats(),
      sectionBytes: { ...args.sectionBytes },
      totalBytes: 0,
      status: args.status,
      lastError: args.lastError,
    });
    m.totalBytes =
      m.sectionBytes.model + m.sectionBytes.loads + m.sectionBytes.results;
    return m;
  }

  function assemblePackage(meta: CaseMeta): CasePackage {
    const pkg: CasePackage = { format: 'fea-case/v1', meta: reconcileMeta(meta) };
    if (meta.sections.model && hasSection(meta.id, 'model')) {
      pkg.model = readModel(meta.id) ?? undefined;
    }
    if (meta.sections.loads && hasSection(meta.id, 'loads')) {
      pkg.loads = readLoads(meta.id) ?? undefined;
    }
    if (meta.sections.results && hasSection(meta.id, 'results')) {
      pkg.results = readResults(meta.id) ?? undefined;
    }
    return pkg;
  }

  function genId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 30));
  }

  return {
    cases,
    casesLoaded,
    isExporting,
    exportingId,
    exportStatus,
    lastFailure,
    retentionDays,
    expiredCases,
    previewStats,
    estimateBytes,
    setRetentionDays,
    refreshCases,
    exportCase,
    retryExport,
    discardFailure,
    loadToCanvas,
    downloadArchived,
    deleteCase,
    cleanupExpired,
  };
});
