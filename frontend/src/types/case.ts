import type { FEAModel, FEAResult, Load, Node, Element } from './index';

// ─── 算例导出 / 归档类型 ──────────────────────────────────────────────────────

/** 算例包内可勾选收录的三个部分 */
export type CaseSectionId = 'model' | 'loads' | 'results';

export const CASE_SECTION_ORDER: CaseSectionId[] = ['model', 'loads', 'results'];

export const CASE_SECTION_LABELS: Record<CaseSectionId, string> = {
  model: '模型',
  loads: '载荷',
  results: '结果',
};

/** 用户勾选状态 */
export interface CaseSectionSelection {
  model: boolean;
  loads: boolean;
  results: boolean;
}

/** 极值读数（结果未求解时为 null） */
export interface CaseExtremeReadings {
  maxStress: number | null; // Pa
  maxDisplacement: number | null; // m
  maxLoadMagnitude: number; // N
}

export interface CaseStats {
  nodeCount: number;
  elementCount: number;
  loadCount: number;
  extreme: CaseExtremeReadings;
}

/** 算例元信息（即本地保存的算例列表条目） */
export interface CaseMeta {
  id: string;
  name: string;
  createdAt: string; // ISO 时间戳
  createdDate: string; // YYYY-MM-DD（按日期归档归拢用）
  preset: string;
  /** 用户当时勾选了哪些部分 */
  sections: CaseSectionSelection;
  stats: CaseStats;
  /** 每段实际写入的 UTF-8 字节数（未收录为 0） */
  sectionBytes: Record<CaseSectionId, number>;
  totalBytes: number;
  /** complete = 全部勾选段落落盘；partial = 中途失败，仍可重试 */
  status: 'complete' | 'partial';
  missingSections?: CaseSectionId[];
  lastError?: string;
}

/** 模型快照：只含节点与构件，载荷单独存放 */
export interface CaseModelSnapshot {
  nodes: Node[];
  elements: Element[];
}

/** 离线算例包：一个自包含 JSON 文件 */
export interface CasePackage {
  format: 'fea-case/v1';
  meta: CaseMeta;
  model?: CaseModelSnapshot;
  loads?: Load[];
  results?: FEAResult;
}

/** 导出过程中某一段写入失败 */
export class SectionWriteError extends Error {
  section: CaseSectionId;
  kind: 'fault' | 'quota';
  constructor(section: CaseSectionId, kind: 'fault' | 'quota') {
    const reason = kind === 'quota' ? '存储空间不足（QuotaExceededError）' : '写入失败';
    super(`算例部分「${CASE_SECTION_LABELS[section]}」${reason}`);
    this.name = 'SectionWriteError';
    this.section = section;
    this.kind = kind;
  }
}

/** 供 storage / store 共用的序列化助手 */
export function snapshotModel(model: FEAModel): CaseModelSnapshot {
  return {
    nodes: JSON.parse(JSON.stringify(model.nodes)) as Node[],
    elements: JSON.parse(JSON.stringify(model.elements)) as Element[],
  };
}

export function snapshotLoads(model: FEAModel): Load[] {
  return JSON.parse(JSON.stringify(model.loads)) as Load[];
}

export function snapshotResult(result: FEAResult): FEAResult {
  return JSON.parse(JSON.stringify(result)) as FEAResult;
}
