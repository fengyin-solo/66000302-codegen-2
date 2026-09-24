<script setup lang="ts">
import { computed, ref } from 'vue';
import { useFEAStore } from '../store/fea';
import { useCaseStore } from '../store/case';
import { formatBytes } from '../utils/case-storage';
import {
  CASE_SECTION_LABELS,
  type CaseSectionId,
} from '../types/case';

const fea = useFEAStore();
const caseStore = useCaseStore();

// ─── 名称与勾选 ──────────────────────────────────────────────────────────────
const defaultName = computed(
  () =>
    `${presetName(fea.selectedPreset)}_${new Date()
      .toISOString()
      .slice(0, 10)}_${String(caseStore.cases.length + 1).padStart(2, '0')}`
);
const name = ref('');
const effectiveName = computed(() => name.value.trim() || defaultName.value);

const selection = ref({ model: true, loads: true, results: true });
const resultDisabled = computed(() => !fea.result);

const selectedCount = computed(
  () =>
    Number(selection.value.model) +
    Number(selection.value.loads) +
    Number(selection.value.results && !resultDisabled.value)
);

// ─── 导出前预览 ──────────────────────────────────────────────────────────────
const stats = computed(() => caseStore.previewStats);
const estimatedBytes = computed(() =>
  caseStore.estimateBytes({
    model: selection.value.model,
    loads: selection.value.loads,
    results: selection.value.results && !resultDisabled.value,
  })
);

// ─── 故障注入（演示“中途失败”用）──────────────────────────────────────────────
const faultMode = ref<'none' | 'results-fail' | 'quota'>('none');
const faultLabels = {
  none: '正常',
  'results-fail': '模拟：结果段写入失败',
  quota: '模拟：存储空间不足',
} as const;

// ─── 结果提示 ────────────────────────────────────────────────────────────────
const notice = ref<{ kind: 'ok' | 'err'; text: string } | null>(null);

async function handleExport() {
  notice.value = null;
  const res = await caseStore.exportCase(
    effectiveName.value,
    {
      model: selection.value.model,
      loads: selection.value.loads,
      results: selection.value.results && !resultDisabled.value,
    },
    faultMode.value
  );
  if (res.ok) {
    notice.value = {
      kind: 'ok',
      text: res.error
        ? `已归档；${res.error}`
        : `算例「${effectiveName.value}」已归档并下载离线文件`,
    };
    name.value = '';
  } else {
    notice.value = { kind: 'err', text: res.error || '导出失败' };
  }
}

async function handleRetry() {
  notice.value = null;
  const res = await caseStore.retryExport(faultMode.value);
  if (res.ok) {
    notice.value = {
      kind: 'ok',
      text: res.error ? `已补全；${res.error}` : '算例已补全并重新下载离线文件',
    };
  } else {
    notice.value = { kind: 'err', text: res.error || '重试失败' };
  }
}

function handleDiscard() {
  caseStore.discardFailure();
  notice.value = null;
}

const sectionOptions: { id: CaseSectionId; hint: string }[] = [
  { id: 'model', hint: '节点与构件' },
  { id: 'loads', hint: '施加的载荷' },
  { id: 'results', hint: '位移 / 应力 / 应变 / 反力' },
];

function presetName(p: string): string {
  return (
    { cantilever: '悬臂梁', bridge: '桥梁桁架', frame: '简单框架', custom: '自定义模型' }[
      p
    ] || 'FEA算例'
  );
}
</script>

<template>
  <div class="bg-slate-800 rounded-lg p-4 space-y-3">
    <h3 class="text-sm font-bold text-slate-200 border-b border-slate-700 pb-2">
      📦 导出算例
    </h3>

    <!-- 名称 -->
    <div>
      <div class="text-xs text-slate-400 mb-1">算例名称</div>
      <input
        v-model="name"
        type="text"
        :placeholder="defaultName"
        :disabled="caseStore.isExporting"
        class="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:border-sky-600 outline-none disabled:opacity-50"
      />
    </div>

    <!-- 勾选收录内容 -->
    <div>
      <div class="text-xs text-slate-400 mb-1">收录内容</div>
      <div class="space-y-1">
        <label
          v-for="opt in sectionOptions"
          :key="opt.id"
          class="flex items-center gap-2 cursor-pointer"
          :class="{ 'opacity-40 cursor-not-allowed': opt.id === 'results' && resultDisabled }"
        >
          <input
            v-model="selection[opt.id]"
            type="checkbox"
            class="accent-sky-500"
            :disabled="(opt.id === 'results' && resultDisabled) || caseStore.isExporting"
          />
          <span class="text-xs text-slate-300">{{ CASE_SECTION_LABELS[opt.id] }}</span>
          <span class="text-[10px] text-slate-500">{{ opt.hint }}</span>
          <span
            v-if="opt.id === 'results' && resultDisabled"
            class="ml-auto text-[10px] text-amber-500"
          >
            未求解
          </span>
        </label>
      </div>
    </div>

    <!-- 导出前读数预览 -->
    <div class="bg-slate-900 rounded p-2.5 space-y-1.5">
      <div class="text-[10px] text-slate-500 uppercase tracking-wide">导出前检查</div>
      <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <span class="text-slate-400">节点数</span>
        <span class="text-slate-200 text-right font-mono">{{ stats.nodeCount }}</span>
        <span class="text-slate-400">构件数</span>
        <span class="text-slate-200 text-right font-mono">{{ stats.elementCount }}</span>
        <span class="text-slate-400">载荷数</span>
        <span class="text-slate-200 text-right font-mono">{{ stats.loadCount }}</span>
        <span class="text-slate-400">最大应力</span>
        <span class="text-red-400 text-right font-mono">
          {{ stats.extreme.maxStress !== null ? (stats.extreme.maxStress / 1e6).toFixed(2) + ' MPa' : '—' }}
        </span>
        <span class="text-slate-400">最大位移</span>
        <span class="text-amber-400 text-right font-mono">
          {{ stats.extreme.maxDisplacement !== null ? (stats.extreme.maxDisplacement * 1000).toFixed(3) + ' mm' : '—' }}
        </span>
        <span class="text-slate-400">最大载荷</span>
        <span class="text-slate-200 text-right font-mono">
          {{ stats.extreme.maxLoadMagnitude > 0 ? (stats.extreme.maxLoadMagnitude / 1000).toFixed(2) + ' kN' : '—' }}
        </span>
      </div>
      <div class="border-t border-slate-800 pt-1.5 flex items-center justify-between text-xs">
        <span class="text-slate-400">预计文件体积</span>
        <span class="text-sky-400 font-mono font-bold">
          {{ selectedCount > 0 ? formatBytes(estimatedBytes) : '—' }}
        </span>
      </div>
    </div>

    <!-- 导出按钮（导出中禁用，挡住重复提交） -->
    <button
      @click="handleExport"
      :disabled="caseStore.isExporting || selectedCount === 0"
      class="w-full py-2 rounded text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-50"
      :class="caseStore.isExporting
        ? 'bg-slate-700 text-slate-400'
        : 'bg-sky-700 text-white hover:bg-sky-600'"
    >
      <span v-if="caseStore.isExporting">
        ⏳ {{ caseStore.exportStatus || '写入中…' }}
      </span>
      <span v-else>⬇ 导出并归档（同时下载离线文件）</span>
    </button>

    <!-- 失败提示：说明哪些部分没写进去，提供重试 / 放弃 -->
    <div
      v-if="caseStore.lastFailure"
      class="rounded border border-red-900 bg-red-950/40 p-2.5 space-y-2"
    >
      <div class="text-xs text-red-300 font-bold">上次导出未完成</div>
      <div class="text-[11px] text-red-200/80">
        算例「{{ caseStore.lastFailure.name }}」中以下部分没有写进去：
      </div>
      <div class="flex flex-wrap gap-1">
        <span
          v-for="s in caseStore.lastFailure.missing"
          :key="s"
          class="px-1.5 py-0.5 rounded bg-red-900/60 text-red-200 text-[10px] font-medium"
        >
          {{ CASE_SECTION_LABELS[s as CaseSectionId] }}
        </span>
        <span v-if="caseStore.lastFailure.missing.length === 0" class="text-[10px] text-slate-400">
          （段落已补齐，可重试生成离线文件）
        </span>
      </div>
      <div class="text-[10px] text-red-300/70">{{ caseStore.lastFailure.message }}</div>
      <div class="flex gap-2">
        <button
          @click="handleRetry"
          :disabled="caseStore.isExporting"
          class="flex-1 py-1.5 rounded text-[11px] font-bold bg-red-700 text-white hover:bg-red-600 transition disabled:opacity-50"
        >
          重新写入缺失部分
        </button>
        <button
          @click="handleDiscard"
          :disabled="caseStore.isExporting"
          class="px-3 py-1.5 rounded text-[11px] bg-slate-700 text-slate-300 hover:bg-slate-600 transition disabled:opacity-50"
        >
          放弃草稿
        </button>
      </div>
    </div>

    <!-- 普通结果通知 -->
    <div
      v-if="notice && !caseStore.lastFailure"
      class="text-[11px] rounded p-2"
      :class="notice.kind === 'ok'
        ? 'bg-green-950/40 border border-green-900 text-green-300'
        : 'bg-red-950/40 border border-red-900 text-red-300'"
    >
      {{ notice.text }}
    </div>

    <!-- 故障注入：演示中途失败 -->
    <details class="text-[10px] text-slate-500">
      <summary class="cursor-pointer select-none hover:text-slate-400">
        导出异常模拟（测试用）
      </summary>
      <select
        v-model="faultMode"
        :disabled="caseStore.isExporting"
        class="mt-1 w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[10px] text-slate-300 disabled:opacity-50"
      >
        <option v-for="(label, key) in faultLabels" :key="key" :value="key">
          {{ label }}
        </option>
      </select>
    </details>
  </div>
</template>
