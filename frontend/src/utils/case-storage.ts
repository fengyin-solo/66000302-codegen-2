import type {
  CaseMeta,
  CaseModelSnapshot,
  CasePackage,
  CaseSectionId,
} from '../types/case';
import type { Load, FEAResult } from '../types';
import { SectionWriteError } from '../types/case';

// ─── 本地存储布局（localStorage）─────────────────────────────────────────────
// fea-case:v1:index                     -> CaseMeta[]（算例列表，单独保存）
// fea-case:v1:case:<id>:model          -> 模型段落
// fea-case:v1:case:<id>:loads          -> 载荷段落
// fea-case:v1:case:<id>:results        -> 结果段落
//
// 每个勾选段落使用独立键、独立写入：任何一段失败都不会抹掉已写入的段落，
// 因而可以精确报告“哪些部分没写进去”，并允许事后重试补齐。

const PREFIX = 'fea-case:v1';
const INDEX_KEY = `${PREFIX}:index`;

/** 故障注入模式：none 正常；results-fail 结果段必失败；quota 模拟配额耗尽 */
export type FaultMode = 'none' | 'results-fail' | 'quota';

function sectionKey(id: string, section: CaseSectionId): string {
  return `${PREFIX}:case:${id}:${section}`;
}

// ─── 列表（算例列表本地保存）────────────────────────────────────────────────
export function loadCaseIndex(): CaseMeta[] {
  const raw = localStorage.getItem(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CaseMeta[]) : [];
  } catch {
    // 列表文件损坏不应阻断应用：条目本体仍在独立键中可读
    return [];
  }
}

export function saveCaseIndex(list: CaseMeta[]): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
  } catch (e) {
    if (isQuotaError(e)) {
      throw new SectionWriteError('model', 'quota');
    }
    throw e;
  }
}

// ─── 段落读写 ───────────────────────────────────────────────────────────────
export function hasSection(id: string, section: CaseSectionId): boolean {
  return localStorage.getItem(sectionKey(id, section)) !== null;
}

export function readSection<T>(id: string, section: CaseSectionId): T | null {
  const raw = localStorage.getItem(sectionKey(id, section));
  if (raw === null) return null;
  const wrapped = JSON.parse(raw) as { data: T };
  return wrapped.data;
}

export function readModel(id: string): CaseModelSnapshot | null {
  return readSection<CaseModelSnapshot>(id, 'model');
}

export function readLoads(id: string): Load[] | null {
  return readSection<Load[]>(id, 'loads');
}

export function readResults(id: string): FEAResult | null {
  return readSection<FEAResult>(id, 'results');
}

/**
 * 写入单个段落。
 * @param fault 故障注入（导出面板里的测试开关），一次性由调用方控制
 */
export function writeSection(
  id: string,
  section: CaseSectionId,
  data: unknown,
  fault: FaultMode = 'none'
): number {
  // 模拟中途失败
  if (fault === 'results-fail' && section === 'results') {
    throw new SectionWriteError(section, 'fault');
  }
  if (fault === 'quota') {
    throw new SectionWriteError(section, 'quota');
  }

  const payload = JSON.stringify({ data });
  try {
    localStorage.setItem(sectionKey(id, section), payload);
  } catch (e) {
    if (isQuotaError(e)) throw new SectionWriteError(section, 'quota');
    throw new SectionWriteError(section, 'fault');
  }
  return utf8Bytes(payload);
}

export function removeSection(id: string, section: CaseSectionId): void {
  localStorage.removeItem(sectionKey(id, section));
}

export function removeCaseSections(id: string): void {
  (['model', 'loads', 'results'] as CaseSectionId[]).forEach((s) =>
    removeSection(id, s)
  );
}

// ─── 字节体积 ───────────────────────────────────────────────────────────────
const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** 预估某段落 JSON 写入后的字节数（与 writeSection 的封装格式一致） */
export function measureSectionBytes(data: unknown): number {
  return utf8Bytes(JSON.stringify({ data }));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ─── 离线文件下载 ───────────────────────────────────────────────────────────
export function downloadCaseFile(pkg: CasePackage): void {
  const json = JSON.stringify(pkg, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = buildFileName(pkg);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 释放延后到点击事件处理完之后
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildFileName(pkg: CasePackage): string {
  const safeName =
    pkg.meta.name
      .replace(/[\\/:*?"<>|\s]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'fea-case';
  return `${safeName}_${pkg.meta.createdDate}_${pkg.meta.id.slice(0, 8)}.json`;
}

// ─── 日期工具 ───────────────────────────────────────────────────────────────
export function formatLocalDate(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatLocalDateTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${formatLocalDate(d)} ${hh}:${mm}`;
}

export function ageInDays(iso: string, now = new Date()): number {
  const created = new Date(iso);
  return Math.floor((now.getTime() - created.getTime()) / 86_400_000);
}

function isQuotaError(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === 'QuotaExceededError' ||
      e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      e.code === 22)
  );
}
