import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type {
  CaseArchiveIndex,
  CaseBundle,
  CaseContent,
  CaseExportPreview,
  CaseExportSelection,
  CaseMeta,
  CaseSettings,
  ExportRunState,
  ExportStageId,
  ExportStageState,
} from '../types/case-archive';
import type { FEAModel, FEAResult } from '../types';
import {
  countRenderableElements,
  dateKeyOf,
  deepClone,
  downloadTextFile,
  formatBytes,
} from '../utils/case-utils';

const INDEX_KEY = 'fea-archive-index-v1';
const CASE_KEY_PREFIX = 'fea-archive-case-v1:';
const DEFAULT_RETENTION_DAYS = 30;

const STAGE_LABELS: Record<ExportStageId, string> = {
  bundle: '组装算例包',
  archive: '写入本地归档',
  download: '下载离线文件',
};

/** 一次导出请求的入参（失败重试时复用同一份快照） */
interface ExportRequest {
  name: string;
  selection: CaseExportSelection;
  model: FEAModel;
  result: FEAResult | null;
  settings: CaseSettings;
}

function emptyRunState(): ExportRunState {
  return { running: false, finished: false, hasFailure: false, stages: [], caseId: null };
}

export const useCaseArchiveStore = defineStore('case-archive', () => {
  // ─── 状态 ──────────────────────────────────────────────────────────────────
  const index = ref<CaseArchiveIndex>({ version: 1, retentionDays: DEFAULT_RETENTION_DAYS, cases: [] });
  const loaded = ref(false);

  const runState = ref<ExportRunState>(emptyRunState());
  const showExportDialog = ref(false);
  /** 非 null 表示清理确认对话框打开，数组为待删条目 */
  const cleanupCandidates = ref<CaseMeta[] | null>(null);
  const notice = ref<string | null>(null);

  /** 最近一次导出的请求与产物，用于失败重试 */
  let lastRequest: ExportRequest | null = null;
  let builtBundle: CaseBundle | null = null;
  let builtJson: string | null = null;
  /** 故障注入：在指定阶段失败一次（重试时自动失效） */
  let pendingFailure: ExportStageId | null = null;

  // ─── 本地存储 ──────────────────────────────────────────────────────────────
  function persistIndex() {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index.value));
  }

  function writeCaseEntry(bundle: CaseBundle) {
    localStorage.setItem(CASE_KEY_PREFIX + bundle.meta.id, JSON.stringify(bundle));
  }

  function readCaseEntry(id: string): CaseBundle | null {
    const raw = localStorage.getItem(CASE_KEY_PREFIX + id);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CaseBundle;
    } catch {
      return null;
    }
  }

  function removeCaseEntry(id: string) {
    localStorage.removeItem(CASE_KEY_PREFIX + id);
  }

  /** 启动时载入索引，并让元数据与算例包内容保持一致（构件数等） */
  function init() {
    if (loaded.value) return;
    loaded.value = true;

    let stored: CaseArchiveIndex | null = null;
    try {
      const raw = localStorage.getItem(INDEX_KEY);
      if (raw) stored = JSON.parse(raw) as CaseArchiveIndex;
    } catch {
      stored = null;
    }

    const validMetas: CaseMeta[] = [];
    if (stored && Array.isArray(stored.cases)) {
      index.value.retentionDays = stored.retentionDays || DEFAULT_RETENTION_DAYS;
      for (const meta of stored.cases) {
        const bundle = readCaseEntry(meta.id);
        if (!bundle) continue; // 算例包缺失的孤儿索引直接丢弃
        // 以算例包内容为准校正元数据，保证列表数量与内容一致
        const fixed = reconcileMeta(meta, bundle);
        validMetas.push(fixed);
      }
    }
    index.value.cases = validMetas;
    persistIndex();
  }

  function reconcileMeta(meta: CaseMeta, bundle: CaseBundle): CaseMeta {
    const next = { ...meta };
    if (bundle.content.model) {
      next.nodeCount = bundle.content.model.nodes.length;
      next.elementCount = countRenderableElements(bundle.content.model);
      next.loadCount = bundle.content.model.loads.length;
      next.hasModel = true;
      next.hasLoads = bundle.content.model.loads.length > 0;
    }
    next.hasResult = !!bundle.content.result;
    next.sizeBytes = JSON.stringify(bundle).length;
    return next;
  }

  // ─── 计算属性 ──────────────────────────────────────────────────────────────
  const cases = computed(() =>
    [...index.value.cases].sort((a, b) => b.createdAt - a.createdAt)
  );

  /** 按日期归拢：dateKey → 当日条目（倒序） */
  const casesByDate = computed(() => {
    const groups = new Map<string, CaseMeta[]>();
    for (const c of cases.value) {
      const list = groups.get(c.dateKey) || [];
      list.push(c);
      groups.set(c.dateKey, list);
    }
    return [...groups.entries()].map(([dateKey, list]) => ({
      dateKey,
      list: list.sort((a, b) => b.createdAt - a.createdAt),
    }));
  });

  const totalBytes = computed(() =>
    index.value.cases.reduce((sum, c) => sum + c.sizeBytes, 0)
  );

  /** 超过保留期的条目 */
  const expiredCases = computed(() => {
    const cutoff = Date.now() - index.value.retentionDays * 86400_000;
    return cases.value.filter((c) => c.createdAt < cutoff);
  });

  // ─── 算例包组装 ────────────────────────────────────────────────────────────
  /** 按勾选裁剪出算例内容快照 */
  function snapshotContent(req: ExportRequest): CaseContent {
    const model: FEAModel = deepClone(req.model);

    // 应力/应变/位移是求解后写回模型的结果量；不收结果时清零，避免随模型泄出
    if (!req.selection.result) {
      for (const n of model.nodes) {
        n.displacementX = 0;
        n.displacementY = 0;
      }
      for (const el of model.elements) {
        el.stress = 0;
        el.strain = 0;
        el.force = 0;
      }
    }

    if (!req.selection.loads) model.loads = [];

    return {
      model: req.selection.model ? model : null,
      result: req.selection.result ? deepClone(req.result) : null,
      settings: deepClone(req.settings),
    };
  }

  function buildBundle(req: ExportRequest): CaseBundle {
    const now = Date.now();
    const content = snapshotContent(req);
    const renderableCount = req.selection.model
      ? countRenderableElements(content.model!)
      : 0;
    const meta: CaseMeta = {
      id: `case-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name: req.name.trim() || `算例 ${dateKeyOf(now)}`,
      createdAt: now,
      dateKey: dateKeyOf(now),
      nodeCount: content.model ? content.model.nodes.length : 0,
      elementCount: renderableCount,
      loadCount: content.model ? content.model.loads.length : 0,
      hasModel: !!content.model,
      hasLoads: !!content.model && content.model.loads.length > 0,
      hasResult: !!content.result,
      maxStress: content.result ? content.result.maxStress : null,
      maxDisplacement: content.result ? content.result.maxDisplacement : null,
      sizeBytes: 0,
    };
    const bundle: CaseBundle = { format: 'fea-case', version: 1, meta, content };
    meta.sizeBytes = JSON.stringify(bundle).length;
    return bundle;
  }

  /** 导出前预览：节点数 / 构件数 / 极值读数 / 文件体积 */
  function buildPreview(
    source: { model: FEAModel; result: FEAResult | null },
    selection: CaseExportSelection
  ): CaseExportPreview {
    const req: ExportRequest = {
      name: 'preview',
      selection,
      model: source.model,
      result: source.result,
      settings: {
        preset: '',
        heatmapMode: 'stress',
        showDeformed: false,
        deformationScale: 1,
      },
    };
    const bundle = buildBundle(req);
    const result = bundle.content.result;
    let maxAxialForce: number | null = null;
    if (bundle.content.model) {
      const forces = bundle.content.model.elements.map((e) => Math.abs(e.force));
      if (forces.length && forces.some((f) => f !== 0)) maxAxialForce = Math.max(...forces);
    }
    return {
      nodeCount: bundle.meta.nodeCount,
      elementCount: bundle.meta.elementCount,
      loadCount: bundle.meta.loadCount,
      maxStress: result ? result.maxStress : null,
      maxDisplacement: result ? result.maxDisplacement : null,
      maxAxialForce,
      estimatedBytes: JSON.stringify(bundle).length,
    };
  }

  // ─── 导出（分阶段、防重复提交、失败可重试）────────────────────────────────
  function setStage(id: ExportStageId, patch: Partial<ExportStageState>) {
    const stage = runState.value.stages.find((s) => s.id === id);
    if (stage) Object.assign(stage, patch);
  }

  function describeStorageError(e: unknown): string {
    if (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')) {
      return '本地存储空间不足，算例未写入（可清理旧算例后重试）';
    }
    return e instanceof Error ? e.message : String(e);
  }

  function openExportDialog() {
    if (runState.value.running) return;
    showExportDialog.value = true;
    runState.value = emptyRunState();
    lastRequest = null;
    builtBundle = null;
    builtJson = null;
    pendingFailure = null;
  }

  function closeExportDialog() {
    if (runState.value.running) return;
    showExportDialog.value = false;
  }

  /**
   * 开始导出。导出过程中重复调用会被直接挡住。
   * @param failStage 测试用：让指定阶段失败一次（重试时自动失效）
   */
  async function exportCase(params: {
    name: string;
    selection: CaseExportSelection;
    source: { model: FEAModel; result: FEAResult | null };
    settings: CaseSettings;
    failStage?: ExportStageId | null;
  }) {
    // ── 挡住重复提交 ──
    if (runState.value.running) return;

    const req: ExportRequest = {
      name: params.name,
      selection: params.selection,
      model: params.source.model,
      result: params.source.result,
      settings: params.settings,
    };
    lastRequest = req;
    builtBundle = null;
    builtJson = null;
    pendingFailure = params.failStage ?? null;

    const stages: ExportStageState[] = [
      { id: 'bundle', label: STAGE_LABELS.bundle, status: 'pending' },
      { id: 'archive', label: STAGE_LABELS.archive, status: 'pending' },
      { id: 'download', label: STAGE_LABELS.download, status: params.selection.download ? 'pending' : 'skipped' },
    ];
    runState.value = {
      running: true,
      finished: false,
      hasFailure: false,
      stages,
      caseId: null,
    };

    await tick();

    // 阶段 1：组装算例包
    setStage('bundle', { status: 'running' });
    await tick();
    if (consumeFailure('bundle')) {
      setStage('bundle', { status: 'failed', error: '算例内容组装失败，未生成任何文件' });
    } else {
      try {
        builtBundle = buildBundle(req);
        builtJson = JSON.stringify(builtBundle, null, 2);
        setStage('bundle', { status: 'done' });
      } catch (e) {
        setStage('bundle', { status: 'failed', error: describeStorageError(e) });
      }
    }

    // 阶段 2：写入本地归档（bundle 成功才执行）
    if (builtBundle && builtJson) {
      setStage('archive', { status: 'running' });
      await tick();
      if (consumeFailure('archive')) {
        setStage('archive', { status: 'failed', error: '归档写入被中断，本地列表中没有这条算例' });
      } else {
        try {
          writeArchiveOrRollback(builtBundle);
          runState.value.caseId = builtBundle.meta.id;
          setStage('archive', { status: 'done' });
        } catch (e) {
          setStage('archive', { status: 'failed', error: describeStorageError(e) });
        }
      }
    } else {
      setStage('archive', { status: 'skipped' });
    }

    // 阶段 3：下载离线文件（仅前两步成功且勾选了下载时执行）
    const archiveOk = runState.value.stages.find((s) => s.id === 'archive')!.status === 'done';
    if (builtBundle && builtJson && archiveOk && req.selection.download) {
      setStage('download', { status: 'running' });
      await tick();
      if (consumeFailure('download')) {
        setStage('download', { status: 'failed', error: '离线文件没有下载成功（归档已保存，可重试下载）' });
      } else {
        try {
          downloadTextFile(filenameFor(builtBundle.meta), builtJson);
          setStage('download', { status: 'done' });
        } catch (e) {
          setStage('download', { status: 'failed', error: `下载未完成：${describeStorageError(e)}` });
        }
      }
    } else if (runState.value.stages.find((s) => s.id === 'download')!.status !== 'skipped') {
      setStage('download', { status: 'skipped' });
    }

    runState.value.running = false;
    runState.value.finished = true;
    runState.value.hasFailure = runState.value.stages.some((s) => s.status === 'failed');
  }

  /** 失败后重试：只重跑未完成的阶段 */
  async function retryExport() {
    if (runState.value.running || !lastRequest) return;

    const previous = runState.value.stages;
    runState.value.running = true;
    runState.value.finished = false;
    runState.value.hasFailure = false;
    for (const s of previous) {
      if (s.status === 'failed') s.status = 'pending';
    }
    await tick();

    const bundleStage = previous.find((s) => s.id === 'bundle')!;
    if (bundleStage.status === 'pending') {
      bundleStage.status = 'running';
      await tick();
      if (consumeFailure('bundle')) {
        bundleStage.status = 'failed';
        bundleStage.error = '算例内容组装失败，未生成任何文件';
      } else {
        try {
          builtBundle = buildBundle(lastRequest);
          builtJson = JSON.stringify(builtBundle, null, 2);
          bundleStage.status = 'done';
        } catch (e) {
          bundleStage.status = 'failed';
          bundleStage.error = describeStorageError(e);
        }
      }
    }

    const archiveStage = previous.find((s) => s.id === 'archive')!;
    if (archiveStage.status === 'pending' && builtBundle && builtJson) {
      archiveStage.status = 'running';
      await tick();
      if (consumeFailure('archive')) {
        archiveStage.status = 'failed';
        archiveStage.error = '归档写入被中断，本地列表中没有这条算例';
      } else {
        try {
          writeArchiveOrRollback(builtBundle);
          runState.value.caseId = builtBundle.meta.id;
          archiveStage.status = 'done';
        } catch (e) {
          archiveStage.status = 'failed';
          archiveStage.error = describeStorageError(e);
        }
      }
    }

    const downloadStage = previous.find((s) => s.id === 'download')!;
    const archiveOk = archiveStage.status === 'done';
    if (downloadStage.status === 'pending' && builtBundle && builtJson && archiveOk) {
      downloadStage.status = 'running';
      await tick();
      if (consumeFailure('download')) {
        downloadStage.status = 'failed';
        downloadStage.error = '离线文件没有下载成功（归档已保存，可重试下载）';
      } else {
        try {
          downloadTextFile(filenameFor(builtBundle.meta), builtJson);
          downloadStage.status = 'done';
        } catch (e) {
          downloadStage.status = 'failed';
          downloadStage.error = `下载未完成：${describeStorageError(e)}`;
        }
      }
    }

    runState.value.running = false;
    runState.value.finished = true;
    runState.value.hasFailure = previous.some((s) => s.status === 'failed');
  }

  /** 写算例包再更新索引；索引写失败则回滚算例包，保证不留半截条目 */
  function writeArchiveOrRollback(bundle: CaseBundle) {
    writeCaseEntry(bundle);
    try {
      index.value.cases = [...index.value.cases.filter((c) => c.id !== bundle.meta.id), bundle.meta];
      persistIndex();
    } catch (e) {
      removeCaseEntry(bundle.meta.id);
      index.value.cases = index.value.cases.filter((c) => c.id !== bundle.meta.id);
      throw e;
    }
  }

  function consumeFailure(stage: ExportStageId): boolean {
    if (pendingFailure === stage) {
      pendingFailure = null; // 只失败一次，重试即可通过
      return true;
    }
    return false;
  }

  function tick() {
    return new Promise((resolve) => setTimeout(resolve, 30));
  }

  function filenameFor(meta: CaseMeta): string {
    const safe = meta.name.replace(/[\\/:*?"<>|\s]+/g, '_');
    return `${safe}_${meta.dateKey}.json`;
  }

  // ─── 保留期清理（必须用户确认）────────────────────────────────────────────
  function requestCleanup() {
    if (runState.value.running) return;
    const list = expiredCases.value;
    if (list.length === 0) {
      notice.value = `没有超过 ${index.value.retentionDays} 天保留期的算例`;
      return;
    }
    cleanupCandidates.value = list;
  }

  /** 用户确认：删除列出的条目 */
  function confirmCleanup() {
    if (!cleanupCandidates.value) return;
    for (const meta of cleanupCandidates.value) {
      removeCaseEntry(meta.id);
    }
    const doomed = new Set(cleanupCandidates.value.map((c) => c.id));
    index.value.cases = index.value.cases.filter((c) => !doomed.has(c.id));
    persistIndex();
    notice.value = `已删除 ${doomed.size} 条过期算例`;
    cleanupCandidates.value = null;
  }

  /** 用户取消：一条都不删，原算例仍然可读 */
  function cancelCleanup() {
    cleanupCandidates.value = null;
  }

  function deleteCase(id: string) {
    if (runState.value.running) return;
    removeCaseEntry(id);
    index.value.cases = index.value.cases.filter((c) => c.id !== id);
    persistIndex();
  }

  function setRetentionDays(days: number) {
    const n = Math.max(1, Math.min(3650, Math.floor(days) || DEFAULT_RETENTION_DAYS));
    index.value.retentionDays = n;
    persistIndex();
  }

  // ─── 读取 / 导入 ──────────────────────────────────────────────────────────
  function readCase(id: string): CaseBundle | null {
    return readCaseEntry(id);
  }

  /** 从离线文件文本导入算例（不写入归档，只还原到画布） */
  function parseBundle(text: string): CaseBundle {
    const data = JSON.parse(text) as CaseBundle;
    if (!data || data.format !== 'fea-case' || !data.content) {
      throw new Error('文件不是有效的 FEA 算例包');
    }
    return data;
  }

  function dismissNotice() {
    notice.value = null;
  }

  return {
    // state
    index,
    loaded,
    cases,
    casesByDate,
    totalBytes,
    expiredCases,
    runState,
    showExportDialog,
    cleanupCandidates,
    notice,
    formatBytes,
    // export
    openExportDialog,
    closeExportDialog,
    buildPreview,
    exportCase,
    retryExport,
    // cleanup
    requestCleanup,
    confirmCleanup,
    cancelCleanup,
    deleteCase,
    setRetentionDays,
    // read
    init,
    readCase,
    parseBundle,
    dismissNotice,
  };
});
