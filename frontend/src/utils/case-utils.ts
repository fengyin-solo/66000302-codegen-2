import type { FEAModel } from '../types';

// ─── 通用小工具 ──────────────────────────────────────────────────────────────

/** 字节数 → 人类可读文本 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** 时间戳 → 本地日期键 YYYY-MM-DD（用于按日期归拢归档） */
export function dateKeyOf(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 时间戳 → HH:MM:SS */
export function timeOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 画布上实际渲染的构件数。
 * 与 FEACanvas 的绘制逻辑一致：两端节点都存在的构件才会被画出。
 * 归档列表里显示的构件数以它为准，保证和画布上看到的一致。
 */
export function countRenderableElements(model: FEAModel): number {
  const ids = new Set(model.nodes.map((n) => n.id));
  return model.elements.reduce(
    (acc, el) => (ids.has(el.nodeIds[0]) && ids.has(el.nodeIds[1]) ? acc + 1 : acc),
    0
  );
}

/** 触发浏览器下载一个文本文件（离线留存用） */
export function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 深拷贝（优先 structuredClone，回退 JSON） */
export function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
