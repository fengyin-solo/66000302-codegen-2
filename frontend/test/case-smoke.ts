/* 冒烟测试：算例导出 / 归档核心流程（Node + 内存 localStorage） */
import { createPinia, setActivePinia } from 'pinia';
import { useFEAStore } from '../src/store/fea';
import { useCaseStore } from '../src/store/case';

// ─── 浏览器环境桩 ──────────────────────────────────────────────────────────
const memStore = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => {
    memStore.set(k, String(v));
  },
  removeItem: (k: string) => {
    memStore.delete(k);
  },
  clear: () => memStore.clear(),
};
(globalThis as any).localStorage = localStorageStub;
(globalThis as any).document = {
  createElement: () => ({ click() {}, style: {} as any }),
  body: { appendChild() {}, removeChild() {} },
};
(globalThis as any).URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
(globalThis as any).Blob = class {
  constructor(public parts: any[], public opts: any) {}
};

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error('❌', msg);
  } else {
    console.log('✅', msg);
  }
}

async function main() {
  setActivePinia(createPinia());
  const fea = useFEAStore();
  const cases = useCaseStore();

  fea.loadPreset('cantilever');
  fea.solve();
  const expectedNodes = fea.model.nodes.length;
  const expectedElements = fea.model.elements.length;
  assert(expectedElements > 0 && expectedNodes > 0, '预设模型可求解');

  cases.refreshCases();
  assert(cases.cases.length === 0, '初始归档为空');

  // ── 1. 故障导出：结果段失败，模型/载荷已落盘 ──
  const r1 = await cases.exportCase('失败用例', { model: true, loads: true, results: true }, 'results-fail');
  assert(!r1.ok, '结果段失败时导出返回失败');
  assert(cases.lastFailure !== null, '记录了失败草稿');
  assert(cases.cases.length === 1, '失败草稿仍进入算例列表');
  const draft = cases.cases[0];
  assert(draft.status === 'partial', '草稿标记为不完整');
  assert(draft.missingSections?.join() === 'results', '缺失部分报告为：结果');
  assert(draft.stats.elementCount === expectedElements, '列表构件数与画布一致');
  assert(draft.stats.nodeCount === expectedNodes, '列表节点数与画布一致');
  assert(draft.stats.loadCount === fea.model.loads.length, '载荷数正确');
  assert(!memStore.has(`fea-case:v1:case:${draft.id}:results`), '结果键确实未写入');
  assert(memStore.has(`fea-case:v1:case:${draft.id}:model`), '模型键已写入');
  assert(memStore.has(`fea-case:v1:case:${draft.id}:loads`), '载荷键已写入');

  // ── 2. 重复提交拦截 ──
  setActivePinia(createPinia());
  const fea2 = useFEAStore();
  const cases2 = useCaseStore();
  fea2.loadPreset('bridge');
  fea2.solve();
  const p1 = cases2.exportCase('并发A', { model: true, loads: true, results: true }, 'none');
  const r2 = await cases2.exportCase('并发B', { model: true, loads: true, results: true }, 'none');
  assert(!r2.ok && /正在导出/.test(r2.error || ''), '导出进行中拦截重复提交');
  const ra = await p1;
  assert(ra.ok, '第一个导出最终成功');

  // ── 3. 重试补齐 ──
  const r3 = await cases.retryExport('none');
  assert(r3.ok, '重试成功');
  cases.refreshCases();
  const fixed = cases.cases.find((c) => c.id === draft.id)!;
  assert(fixed.status === 'complete', '重试后算例完整');
  assert(cases.lastFailure === null, '失败状态清除');
  assert(memStore.has(`fea-case:v1:case:${draft.id}:results`), '结果键已补写');

  // ── 4. 放弃草稿（通过新故障）──
  await cases.exportCase('待放弃', { model: true, results: true }, 'results-fail');
  assert(cases.lastFailure !== null, '产生第二个失败草稿');
  const dropId = cases.lastFailure!.id;
  cases.discardFailure();
  assert(cases.lastFailure === null, '放弃后失败状态清除');
  cases.refreshCases();
  assert(!cases.cases.some((c) => c.id === dropId), '草稿从列表移除');
  assert(!memStore.has(`fea-case:v1:case:${dropId}:model`), '草稿段落数据已删除');
  // 之前的算例仍可读
  assert(cases.cases.some((c) => c.id === draft.id), '其他算例不受影响、仍可读');

  // ── 5. 载入画布 ──
  const loadRes = cases.loadToCanvas(fixed);
  assert(loadRes.restoredModel && loadRes.restoredLoads && loadRes.restoredResults, '载入恢复模型/载荷/结果');
  assert(fea.model.elements.length === expectedElements, '载入后画布构件数一致');
  assert(fea.result !== null && fea.model.elements[0].stress === fea.result.stresses[0], '构件应力已回填');

  // ── 6. 只选模型导出（无载荷无结果）──
  const r6 = await cases.exportCase('仅模型', { model: true, loads: false, results: false }, 'none');
  assert(r6.ok, '只勾选模型也能导出');
  cases.refreshCases();
  const only = cases.cases.find((c) => c.name === '仅模型')!;
  assert(only.stats.elementCount === expectedElements, '仅模型算例构件数与画布一致');
  assert(only.stats.loadCount === 0, '未收录载荷则载荷数为 0');
  assert(only.stats.extreme.maxStress === null, '未收录结果则极值读数为空');

  // ── 7. 未求解时收录结果应被拒 ──
  setActivePinia(createPinia());
  const fea3 = useFEAStore();
  const cases3 = useCaseStore();
  fea3.loadPreset('frame');
  const r7 = await cases3.exportCase('无结果', { model: true, results: true }, 'none');
  assert(!r7.ok && /尚未求解/.test(r7.error || ''), '未求解时拒绝收录结果');
  assert(cases3.cases.length === 0, '拒绝后不产生任何算例数据');

  // ── 8. 保留期清理：过期列出 → 未确认前不动 → 确认后删除 ──
  cases3.refreshCases();
  // 构造 40 天前的过期条目（含真实段落键）
  setActivePinia(createPinia());
  const fea4 = useFEAStore();
  const cases4 = useCaseStore();
  fea4.loadPreset('frame');
  fea4.solve();
  await cases4.exportCase('新算例', { model: true }, 'none');
  const oldId = 'old0000000000';
  memStore.set(`fea-case:v1:case:${oldId}:model`, JSON.stringify({ data: { nodes: [], elements: [] } }));
  const oldMeta = {
    id: oldId,
    name: '过期算例',
    createdAt: new Date(Date.now() - 40 * 86400000).toISOString(),
    createdDate: '2026-08-01',
    preset: 'custom',
    sections: { model: true, loads: false, results: false },
    stats: { nodeCount: 0, elementCount: 0, loadCount: 0, extreme: { maxStress: null, maxDisplacement: null, maxLoadMagnitude: 0 } },
    sectionBytes: { model: 10, loads: 0, results: 0 },
    totalBytes: 10,
    status: 'complete' as const,
  };
  const idx = JSON.parse(memStore.get('fea-case:v1:index')!);
  idx.push(oldMeta);
  memStore.set('fea-case:v1:index', JSON.stringify(idx));
  cases4.refreshCases();
  assert(cases4.expiredCases.length === 1, '恰好列出 1 份过期算例');
  assert(cases4.expiredCases[0].name === '过期算例', '过期条目名称正确');
  // 模拟取消：不调用 cleanup，数据仍在
  assert(memStore.has(`fea-case:v1:case:${oldId}:model`), '取消清理：原算例仍然可读（数据键存在）');
  assert(cases4.cases.length >= 2, '取消清理：列表条目不变');
  // 模拟确认
  const { deleted } = cases4.cleanupExpired();
  assert(deleted.length === 1, '确认后删除 1 份');
  assert(!memStore.has(`fea-case:v1:case:${oldId}:model`), '过期段落键已删除');
  assert(!cases4.cases.some((c) => c.id === oldId), '过期条目移出列表');
  assert(cases4.expiredCases.length === 0, '清理后无过期项');

  // ── 9. 体积预估随勾选变化且为正数 ──
  const bAll = cases4.estimateBytes({ model: true, loads: true, results: true });
  const bModel = cases4.estimateBytes({ model: true, loads: false, results: false });
  assert(bAll > bModel && bModel > 0, '勾选越多预估体积越大');

  console.log(failures === 0 ? '\n全部通过 🎉' : `\n${failures} 项失败`);
  if (failures > 0) process.exit(1);
}

main();
