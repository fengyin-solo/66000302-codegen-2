import type { FEAModel, FEAResult } from './index';

// ─── 算例导出与归档 ──────────────────────────────────────────────────────────

/** 导出对话框中用户勾选的内容 */
export interface CaseExportSelection {
  /** 模型（节点 + 构件） */
  model: boolean;
  /** 载荷（依附于模型，未勾选模型时不可选） */
  loads: boolean;
  /** 计算结果（位移/应力/应变/反力，无结果时不可选） */
  result: boolean;
  /** 同时下载 .json 离线留存文件 */
  download: boolean;
}

/** 导出前预览信息 */
export interface CaseExportPreview {
  nodeCount: number;
  elementCount: number;
  loadCount: number;
  /** 极值读数，无结果时为 null */
  maxStress: number | null;
  maxDisplacement: number | null;
  maxAxialForce: number | null;
  /** 按当前勾选估算的导出文件体积（字节） */
  estimatedBytes: number;
}

/** 归档元数据（保存在本地索引中） */
export interface CaseMeta {
  id: string;
  name: string;
  /** 归档时间戳（ms） */
  createdAt: number;
  /** 归档日期键 YYYY-MM-DD，用于按日期归拢 */
  dateKey: string;
  nodeCount: number;
  /** 构件数：与导出时画布上实际渲染的构件数量一致 */
  elementCount: number;
  loadCount: number;
  hasModel: boolean;
  hasLoads: boolean;
  hasResult: boolean;
  maxStress: number | null;
  maxDisplacement: number | null;
  /** 算例包实际占用的字节数 */
  sizeBytes: number;
}

/** 算例包设置（随包保存，载入时还原视图） */
export interface CaseSettings {
  preset: string;
  heatmapMode: 'stress' | 'strain' | 'force';
  showDeformed: boolean;
  deformationScale: number;
}

/** 算例包内容（按勾选裁剪） */
export interface CaseContent {
  model: FEAModel | null;
  result: FEAResult | null;
  settings: CaseSettings;
}

/** 完整算例包（写入本地存储 / 下载为文件） */
export interface CaseBundle {
  format: 'fea-case';
  version: 1;
  meta: CaseMeta;
  content: CaseContent;
}

/** 本地归档索引 */
export interface CaseArchiveIndex {
  version: 1;
  retentionDays: number;
  cases: CaseMeta[];
}

/** 导出阶段 */
export type ExportStageId = 'bundle' | 'archive' | 'download';

export type ExportStageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface ExportStageState {
  id: ExportStageId;
  label: string;
  status: ExportStageStatus;
  /** 失败时的说明 */
  error?: string;
}

/** 一次导出的进行状态 */
export interface ExportRunState {
  running: boolean;
  finished: boolean;
  /** 是否有阶段失败（可重试） */
  hasFailure: boolean;
  stages: ExportStageState[];
  /** 本次产生的归档条目 id（成功写入归档后） */
  caseId: string | null;
}
