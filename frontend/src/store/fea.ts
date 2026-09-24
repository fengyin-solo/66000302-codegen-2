import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { FEAModel, FEAResult, Load } from '../types';
import type { CaseModelSnapshot } from '../types/case';
import {
  solve as feaSolve,
  presetCantileverBeam,
  presetBridgeTruss,
  presetSimpleFrame,
  jetColormap,
} from '../utils/fea-solver';

export const useFEAStore = defineStore('fea', () => {
  const model = ref<FEAModel>({ nodes: [], elements: [], loads: [] });
  const result = ref<FEAResult | null>(null);
  const selectedPreset = ref<string>('cantilever');
  const showDeformed = ref(false);
  const deformationScale = ref(10);
  const selectedElement = ref<number | null>(null);
  const heatmapMode = ref<'stress' | 'strain' | 'force'>('stress');

  // ─── Actions ──────────────────────────────────────────────────────────────
  function loadPreset(name: string) {
    selectedPreset.value = name;
    result.value = null;
    selectedElement.value = null;
    switch (name) {
      case 'cantilever':
        model.value = presetCantileverBeam();
        break;
      case 'bridge':
        model.value = presetBridgeTruss();
        break;
      case 'frame':
        model.value = presetSimpleFrame();
        break;
      default:
        model.value = presetCantileverBeam();
    }
  }

  function solve() {
    result.value = feaSolve(model.value);
  }

  function toggleDeformed() {
    showDeformed.value = !showDeformed.value;
  }

  function selectElement(id: number | null) {
    selectedElement.value = id;
  }

  function setHeatmapMode(mode: 'stress' | 'strain' | 'force') {
    heatmapMode.value = mode;
  }

  function addLoad(nodeId: number, fx: number, fy: number) {
    model.value.loads.push({ nodeId, fx, fy });
  }

  function toggleFixed(nodeId: number) {
    const node = model.value.nodes.find((n) => n.id === nodeId);
    if (node) node.fixed = !node.fixed;
  }

  /**
   * 从算例归档恢复模型 / 载荷 / 结果。
   * 各部分独立存在：有什么恢复什么；恢复结果时把应力、应变、轴力
   * 回填到构件与节点上，保证画布热力图与详情面板立即可用。
   * 已归档算例不再属于任何内置预设。
   */
  function loadCaseSnapshot(payload: {
    model?: CaseModelSnapshot;
    loads?: Load[];
    result?: FEAResult;
  }): { restoredModel: boolean; restoredLoads: boolean; restoredResults: boolean } {
    let restoredModel = false;
    let restoredLoads = false;
    let restoredResults = false;

    if (payload.model) {
      model.value = {
        nodes: JSON.parse(JSON.stringify(payload.model.nodes)),
        elements: JSON.parse(JSON.stringify(payload.model.elements)),
        loads: [],
      };
      restoredModel = true;
      selectedPreset.value = 'custom';
    }

    if (payload.loads && restoredModel) {
      model.value.loads = JSON.parse(JSON.stringify(payload.loads));
      restoredLoads = true;
    }

    if (payload.result && restoredModel) {
      const r: FEAResult = JSON.parse(JSON.stringify(payload.result));
      result.value = r;
      // 回填构件结果字段（轴力 = 应力 × 截面积）
      for (let i = 0; i < model.value.elements.length; i++) {
        const el = model.value.elements[i];
        el.stress = r.stresses[i] ?? 0;
        el.strain = r.strains[i] ?? 0;
        el.force = el.stress * el.area;
      }
      // 回填节点位移
      const dofU = r.displacements;
      model.value.nodes.forEach((n, idx) => {
        n.displacementX = dofU[idx * 2] ?? 0;
        n.displacementY = dofU[idx * 2 + 1] ?? 0;
      });
      restoredResults = true;
    } else {
      result.value = null;
    }

    selectedElement.value = null;
    return { restoredModel, restoredLoads, restoredResults };
  }

  // ─── Computed ─────────────────────────────────────────────────────────────
  const maxStress = computed(() => {
    if (!result.value) return 0;
    return result.value.maxStress;
  });

  const maxDisplacement = computed(() => {
    if (!result.value) return 0;
    return result.value.maxDisplacement;
  });

  const elementColors = computed(() => {
    const colors = new Map<number, string>();
    if (!result.value || model.value.elements.length === 0) {
      for (const el of model.value.elements) {
        colors.set(el.id, '#6b7280');
      }
      return colors;
    }

    let values: number[];
    switch (heatmapMode.value) {
      case 'stress':
        values = result.value.stresses.map(Math.abs);
        break;
      case 'strain':
        values = result.value.strains.map(Math.abs);
        break;
      case 'force':
        values = model.value.elements.map((e) => Math.abs(e.force));
        break;
      default:
        values = result.value.stresses.map(Math.abs);
    }

    const min = Math.min(...values);
    const max = Math.max(...values);

    for (let i = 0; i < model.value.elements.length; i++) {
      colors.set(
        model.value.elements[i].id,
        jetColormap(values[i], min, max)
      );
    }
    return colors;
  });

  return {
    model,
    result,
    selectedPreset,
    showDeformed,
    deformationScale,
    selectedElement,
    heatmapMode,
    maxStress,
    maxDisplacement,
    elementColors,
    loadPreset,
    solve,
    toggleDeformed,
    selectElement,
    setHeatmapMode,
    addLoad,
    toggleFixed,
    loadCaseSnapshot,
  };
});
