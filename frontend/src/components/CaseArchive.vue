<script setup lang="ts">
import { computed, ref } from 'vue';
import { useCaseStore } from '../store/case';
import {
  ageInDays,
  formatBytes,
  formatLocalDateTime,
} from '../utils/case-storage';
import {
  CASE_SECTION_LABELS,
  type CaseMeta,
  type CaseSectionId,
} from '../types/case';

const caseStore = useCaseStore();

// ─── 按日期归拢（新日期在前）─────────────────────────────────────────────────
interface DayGroup {
  date: string;
  items: CaseMeta[];
}

const groupedCases = computed<DayGroup[]>(() => {
  const map = new Map<string, CaseMeta[]>();
  for (const c of caseStore.cases) {
    const arr = map.get(c.createdDate) ?? [];
    arr.push(c);
    map.set(c.createdDate, arr);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, items]) => ({
      date,
      items: items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    }));
});

// ─── 清理确认对话框 ─────────────────────────────────────────────────────────
const showCleanupDialog = ref(false);
const cleanupCancelled = ref(false);

function askCleanup() {
  cleanupCancelled.value = false;
  showCleanupDialog.value = true;
}

function cancelCleanup() {
  // 取消后不删除任何条目，原算例仍然可读
  showCleanupDialog.value = false;
  cleanupCancelled.value = true;
  setTimeout(() => (cleanupCancelled.value = false), 4000);
}

function confirmCleanup() {
  caseStore.cleanupExpired();
  showCleanupDialog.value = false;
}

function onRetentionChange(e: Event) {
  const n = Number((e.target as HTMLInputElement).value);
  if (Number.isFinite(n) && n >= 1) caseStore.setRetentionDays(Math.floor(n));
}

// ─── 单条操作 ───────────────────────────────────────────────────────────────
const loadNotice = ref<string | null>(null);

function loadCase(c: CaseMeta) {
  const r = caseStore.loadToCanvas(c);
  const parts: string[] = [];
  if (r.restoredModel) parts.push('模型');
  if (r.restoredLoads) parts.push('载荷');
  if (r.restoredResults) parts.push('结果');
  loadNotice.value = parts.length
    ? `已载入算例「${c.name}」：${parts.join('、')}，画布已更新`
    : `算例「${c.name}」中没有可载入的模型数据`;
  setTimeout(() => (loadNotice.value = null), 4000);
}

function deleteCase(c: CaseMeta) {
  if (window.confirm(`确定删除算例「${c.name}」？删除后本地归档与段落数据都会移除。`)) {
    caseStore.deleteCase(c.id);
  }
}

function sectionTags(c: CaseMeta): CaseSectionId[] {
  return (['model', 'loads', 'results'] as CaseSectionId[]).filter(
    (s) => c.sections[s]
  );
}

const totalBytes = computed(() =>
  caseStore.cases.reduce((sum, c) => sum + c.totalBytes, 0)
);
</script>

<template>
  <div class="bg-slate-800 rounded-lg p-4 space-y-3">
    <div class="flex items-center justify-between border-b border-slate-700 pb-2">
      <h3 class="text-sm font-bold text-slate-200">🗄 算例归档</h3>
      <span class="text-[10px] text-slate-500">
        {{ caseStore.cases.length }} 份 · {{ formatBytes(totalBytes) }}
      </span>
    </div>

    <!-- 保留期设置与清理入口 -->
    <div class="bg-slate-900 rounded p-2.5 space-y-2">
      <div class="flex items-center justify-between text-xs">
        <span class="text-slate-400">保留期（天）</span>
        <input
          type="number"
          min="1"
          :value="caseStore.retentionDays"
          @change="onRetentionChange"
          class="w-20 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-200 text-right focus:border-sky-600 outline-none"
        />
      </div>
      <button
        v-if="caseStore.expiredCases.length === 0"
        disabled
        class="w-full py-1.5 rounded text-[11px] bg-slate-800 text-slate-600 cursor-not-allowed"
      >
        没有超过保留期的算例
      </button>
      <button
        v-else
        @click="askCleanup"
        class="w-full py-1.5 rounded text-[11px] font-bold bg-amber-800 text-amber-100 hover:bg-amber-700 transition"
      >
        清理 {{ caseStore.expiredCases.length }} 份过期算例…
      </button>
      <div v-if="cleanupCancelled" class="text-[10px] text-emerald-400">
        已取消清理，所有算例保持不变、仍可读。
      </div>
    </div>

    <!-- 载入提示 -->
    <div v-if="loadNotice" class="text-[11px] rounded p-2 bg-sky-950/40 border border-sky-900 text-sky-300">
      {{ loadNotice }}
    </div>

    <!-- 空状态 -->
    <div v-if="groupedCases.length === 0" class="text-xs text-slate-500 text-center py-6">
      还没有归档算例，导出后会出现在这里
    </div>

    <!-- 按日期分组的算例列表 -->
    <div v-else class="space-y-3">
      <div v-for="group in groupedCases" :key="group.date">
        <div class="flex items-center gap-2 mb-1.5 sticky top-0">
          <span class="text-[10px] font-bold text-slate-400">{{ group.date }}</span>
          <span class="text-[10px] text-slate-600">{{ group.items.length }} 份</span>
          <div class="flex-1 h-px bg-slate-700/60"></div>
        </div>

        <div class="space-y-1.5">
          <div
            v-for="c in group.items"
            :key="c.id"
            class="rounded border p-2 space-y-1.5"
            :class="c.status === 'partial'
              ? 'border-amber-900/70 bg-amber-950/20'
              : 'border-slate-700 bg-slate-900/60'"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="text-xs font-bold text-slate-200 truncate">{{ c.name }}</div>
                <div class="text-[10px] text-slate-500">
                  {{ formatLocalDateTime(c.createdAt) }} · {{ ageInDays(c.createdAt) }} 天前
                </div>
              </div>
              <span
                v-if="c.status === 'partial'"
                class="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-900/60 text-amber-300"
                title="部分内容未写入"
              >
                不完整
              </span>
            </div>

            <!-- 列表中的节点数 / 构件数取自段落里实际存下的数据 -->
            <div class="grid grid-cols-3 gap-1 text-[10px]">
              <div class="bg-slate-900 rounded px-1.5 py-1">
                <div class="text-slate-500">节点</div>
                <div class="text-slate-300 font-mono">{{ c.stats.nodeCount }}</div>
              </div>
              <div class="bg-slate-900 rounded px-1.5 py-1">
                <div class="text-slate-500">构件</div>
                <div class="text-slate-300 font-mono">{{ c.stats.elementCount }}</div>
              </div>
              <div class="bg-slate-900 rounded px-1.5 py-1">
                <div class="text-slate-500">体积</div>
                <div class="text-slate-300 font-mono">{{ formatBytes(c.totalBytes) }}</div>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-1">
              <span
                v-for="s in sectionTags(c)"
                :key="s"
                class="px-1 py-0.5 rounded text-[9px]"
                :class="c.missingSections?.includes(s)
                  ? 'bg-red-900/50 text-red-300 line-through'
                  : 'bg-slate-800 text-slate-400'"
              >
                {{ CASE_SECTION_LABELS[s] }}
              </span>
              <span class="ml-auto text-[9px] text-slate-600">
                {{ c.stats.extreme.maxStress !== null
                  ? 'σ ' + (c.stats.extreme.maxStress / 1e6).toFixed(1) + 'MPa'
                  : '' }}
              </span>
            </div>

            <div class="flex gap-1 pt-0.5">
              <button
                @click="loadCase(c)"
                class="flex-1 py-1 rounded text-[10px] font-medium bg-sky-800/70 text-sky-100 hover:bg-sky-700 transition"
              >
                载入画布
              </button>
              <button
                @click="caseStore.downloadArchived(c)"
                class="flex-1 py-1 rounded text-[10px] font-medium bg-slate-700 text-slate-300 hover:bg-slate-600 transition"
              >
                下载离线文件
              </button>
              <button
                @click="deleteCase(c)"
                class="px-2 py-1 rounded text-[10px] bg-slate-700/60 text-red-400 hover:bg-red-900/50 transition"
                title="删除"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 清理确认对话框：先列出将被删掉的条目，等用户确认 -->
    <div
      v-if="showCleanupDialog"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      @click.self="cancelCleanup"
    >
      <div class="bg-slate-800 border border-slate-700 rounded-lg shadow-xl w-[92%] max-w-md max-h-[80vh] flex flex-col">
        <div class="p-4 border-b border-slate-700">
          <h4 class="text-sm font-bold text-amber-400">确认清理过期算例</h4>
          <p class="text-xs text-slate-400 mt-1">
            以下 {{ caseStore.expiredCases.length }} 份算例已超过保留期（{{ caseStore.retentionDays }} 天），
            确认后将从本地归档删除：
          </p>
        </div>

        <div class="p-4 overflow-y-auto space-y-1.5 flex-1">
          <div
            v-for="c in caseStore.expiredCases"
            :key="c.id"
            class="flex items-center justify-between gap-3 bg-slate-900 rounded px-2.5 py-1.5"
          >
            <div class="min-w-0">
              <div class="text-xs text-slate-200 truncate">{{ c.name }}</div>
              <div class="text-[10px] text-slate-500">
                {{ c.createdDate }} · {{ ageInDays(c.createdAt) }} 天 ·
                节点 {{ c.stats.nodeCount }} / 构件 {{ c.stats.elementCount }} ·
                {{ formatBytes(c.totalBytes) }}
              </div>
            </div>
            <span class="text-[10px] text-amber-500 shrink-0">将删除</span>
          </div>
        </div>

        <div class="p-4 border-t border-slate-700 flex gap-2">
          <button
            @click="cancelCleanup"
            class="flex-1 py-2 rounded text-xs font-bold bg-slate-700 text-slate-200 hover:bg-slate-600 transition"
          >
            取消（算例保留不动）
          </button>
          <button
            @click="confirmCleanup"
            class="flex-1 py-2 rounded text-xs font-bold bg-red-700 text-white hover:bg-red-600 transition"
          >
            确认删除 {{ caseStore.expiredCases.length }} 份
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
