<template>
  <div class="logs-page">
    <div class="header">
      <h2>📜 运行日志</h2>
      <div class="header-right">
        <input type="date" v-model="historyDate" class="date-input" @change="loadHistory" />
        <button class="btn btn-secondary" @click="switchToLive">🔄 实时</button>
        <button class="btn btn-secondary" @click="openFolder" title="在资源管理器里打开 %APPDATA%\xnowpost\logs">📂 打开文件夹</button>
        <button class="btn btn-secondary" @click="clearScreen" title="只清当前屏幕，日志文件不动（保留 30 天）">🧹 清屏</button>
      </div>
    </div>

    <div class="stat-bar">
      <span v-if="isHistory" class="history-badge">📂 历史日志：{{ historyDate }}</span>
      <span v-else class="history-badge live">🟢 实时：今天（读日志文件，重启也不会丢）</span>
      <span class="stat-text">
        共 {{ baseLogs.length }} 行
        <template v-if="activeFilter !== 'all' || activeSource !== 'all'"> ｜筛选后 {{ filteredLogs.length }} 行</template>
      </span>
      <span v-if="hiddenByClear > 0" class="cleared-chip" @click="clearedUntil = ''">
        🧹 已清屏 {{ hiddenByClear }} 行 · 点这里恢复
      </span>
    </div>

    <div class="filter-bar">
      <span
        class="filter-chip mode"
        :class="{ active: viewMode === 'runs' }"
        @click="setViewMode('runs')"
        title="每一轮任务压成一行，点开才看细节"
      >🧩 按任务分组</span>
      <span
        class="filter-chip mode"
        :class="{ active: viewMode === 'flat' }"
        @click="setViewMode('flat')"
      >📜 全部行</span>
      <span class="filter-sep">｜</span>
      <span
        v-for="t in filterTypes"
        :key="t.key"
        class="filter-chip"
        :class="{ active: activeFilter === t.key }"
        @click="activeFilter = t.key"
      >{{ t.label }}</span>
      <span class="filter-sep">｜</span>
      <span
        v-for="s in sourceTypes"
        :key="s.key"
        class="filter-chip source"
        :class="{ active: activeSource === s.key }"
        @click="activeSource = s.key"
      >{{ s.label }}</span>
      <span v-if="viewMode === 'flat' && hiddenCount > 0" class="more-btn" @click="visibleCount += 2000">
        ⬆️ 还有 {{ hiddenCount }} 行更早的，点这里再显示 2000 行
      </span>
    </div>

    <!-- ===== 按任务分组：一轮一行，点开看细节 ===== -->
    <div v-if="viewMode === 'runs'" class="log-container" ref="listEl" @scroll.passive="onListScroll">
      <div v-for="run in visibleRuns" :key="run.id" class="run">
        <div class="run-hd" :class="run.result" @click="toggleRun(run.id)">
          <span class="run-caret">{{ expanded[run.id] ? '▾' : '▸' }}</span>
          <span class="run-time">{{ run.startTime }}</span>
          <span class="run-title">{{ run.title }}</span>
          <span class="run-result" :class="run.result">{{ resultText(run) }}</span>
          <span v-if="run.durationText" class="run-meta">⏱ {{ run.durationText }}</span>
          <span v-if="run.accounts.length" class="run-meta">👤 {{ run.accounts.join(',') }}</span>
          <span v-if="run.envs.length" class="run-meta">🖥 {{ run.envs.join(',') }}</span>
          <span v-if="run.published" class="run-meta ok">📤 已发 {{ run.published }}</span>
          <span v-if="run.cost" class="run-meta">💰 ¥{{ run.cost }}</span>
          <span v-if="run.errors.length" class="run-meta bad">❌ {{ run.errors.length }}</span>
          <span v-if="run.warnings.length" class="run-meta warn">⚠️ {{ run.warnings.length }}</span>
          <span class="run-count">{{ run.matched || run.count }} 行</span>
        </div>
        <div v-if="run.failReason" class="run-fail">{{ run.failReason }}</div>
        <div v-if="expanded[run.id]" class="run-body">
          <div v-for="(log, i) in run.lines" :key="i" class="log-line" :class="log.type">
            <span class="log-time">{{ log.time ? log.time.slice(11) : '' }}</span>
            <span class="log-src" :class="log.source">{{ log.source === 'scheduler' ? '调度' : '应用' }}</span>
            <span class="log-level">{{ levelIcon(log.type) }}</span>
            <span class="log-msg">{{ log.message }}</span>
          </div>
        </div>
      </div>
      <div v-if="visibleRuns.length === 0" class="empty">
        {{ logs.length === 0 ? '暂无日志' : '没有匹配的日志' }}
      </div>
    </div>

    <!-- ===== 全部行（原始视图） ===== -->
    <div v-else class="log-container" ref="listEl" @scroll.passive="onListScroll">
      <div v-for="(log, i) in filteredLogs" :key="i" class="log-line" :class="log.type">
        <span class="log-time">{{ log.time }}</span>
        <span class="log-src" :class="log.source">{{ log.source === 'scheduler' ? '调度' : '应用' }}</span>
        <span class="log-level">{{ levelIcon(log.type) }}</span>
        <span class="log-msg">{{ log.message }}</span>
      </div>
      <div v-if="filteredLogs.length === 0" class="empty">
        {{ logs.length === 0 ? '暂无日志' : '没有匹配的日志' }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { useAppStore } from '../stores/app.js';
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import { groupLogRuns, filterRuns } from '../lib/log-runs.js';

const store = useAppStore();
const logs = computed(() => store.logs);
const listEl = ref(null);
const visibleCount = ref(2000);
const activeFilter = ref('all');
const activeSource = ref('all');
const historyDate = ref('');
const isHistory = ref(false);

const filterTypes = [
  { key: 'all', label: '全部' },
  { key: 'success', label: '✅ 成功' },
  { key: 'error', label: '❌ 错误' },
  { key: 'warning', label: '⚠️ 警告' },
  { key: 'info', label: 'ℹ️ 信息' },
];

const sourceTypes = [
  { key: 'all', label: '来源：全部' },
  { key: 'app', label: '应用' },
  { key: 'scheduler', label: '调度' },
];

// 默认「按任务分组」：一天 11 轮任务 = 11 行，点开才是细节
const viewMode = ref('runs');
const expanded = reactive({});

/** 全部轮次（在完整日志上分组，不受"最近 2000 行"限制，避免把某一轮切成半截） */
const allRuns = computed(() => groupLogRuns(baseLogs.value));
const visibleRuns = computed(() => filterRuns(allRuns.value, {
  type: activeFilter.value,
  source: activeSource.value,
}).reverse());   // 最新的任务在最上面

function toggleRun(id) {
  expanded[id] = !expanded[id];
}

async function setViewMode(mode) {
  viewMode.value = mode
  stickTop.value = true
  stickBottom.value = true
  await nextTick()
  if (listEl.value) listEl.value.scrollTop = mode === 'runs' ? 0 : listEl.value.scrollHeight
}

function resultText(run) {
  return { success: '✅ 成功', error: '❌ 失败', unknown: '⏸ 未确认', muted: '· 杂项' }[run.result] || '';
}

const filteredLogs = computed(() => {
  let list = baseLogs.value
  if (activeFilter.value !== 'all') list = list.filter(l => l.type === activeFilter.value)
  if (activeSource.value !== 'all') list = list.filter(l => (l.source || 'app') === activeSource.value)
  // 默认只渲染最近 2000 行（一天能写 6000+ 行，全塞进 DOM 会明显卡）；
  // 想看更早的点筛选栏右边那个按钮（每次再加 2000 行）
  return visibleCount.value > 0 ? list.slice(-visibleCount.value) : list
})

const hiddenCount = computed(() => {
  let total = baseLogs.value.length
  if (activeFilter.value !== 'all') total = baseLogs.value.filter(l => l.type === activeFilter.value).length
  if (activeSource.value !== 'all') total = baseLogs.value.filter(l => (l.source || 'app') === activeSource.value).length
  return Math.max(0, total - visibleCount.value)
})

function levelIcon(type) {
  return { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' }[type] || 'ℹ️';
}

// 初始化：拉取实时日志 + 设定历史日志默认日期
// 日期默认值（实时日志的加载与轮询放在下面的 onMounted 里统一做，别重复拉两遍）
onMounted(() => {
  try {
    historyDate.value = new Date().toLocaleDateString('sv-SE');
  } catch (_) {}
});

/*
 * 「清屏」（2026-10-19 修）：以前的按钮叫「清空」，实际只清了内存里那 500 行缓冲，
 * 而实时视图是每 5 秒重读日志文件的 —— 点完 5 秒原样回来，等于一个假按钮。
 * 现在按"清屏水位线"来：记住当前最新一行的时间，只显示比它更新的行，
 * 日志文件一个字都不删（30 天保留策略照旧），点统计条上的「恢复」就能看回来。
 */
const clearedUntil = ref('');

function normLogTime(t) {
  return String(t || '').trim().replace(/\//g, '-');
}

function clearScreen() {
  const last = logs.value[logs.value.length - 1];
  if (!last) return;
  clearedUntil.value = normLogTime(last.time);
  // 顺手清掉内存缓冲（重启应用后也不会再冒出来）
  store.clearLogs();
}

/** 清屏之后的日志（水位线之前的一律不显示） */
const baseLogs = computed(() => {
  if (!clearedUntil.value) return logs.value;
  return logs.value.filter((l) => normLogTime(l.time) > clearedUntil.value);
});

/** 被清屏藏起来的行数（用于「恢复」提示） */
const hiddenByClear = computed(() => logs.value.length - baseLogs.value.length);

async function openFolder() {
  try {
    const r = await window.xnowpost.openLogFolder()
    if (r && r.ok === false) store.addLog('error', '打开日志文件夹失败：' + r.message)
  } catch (e) {
    store.addLog('error', '打开日志文件夹失败：' + (e.message || e))
  }
}

/*
 * 刷新时要不要动滚动条（2026-10-30 修）：
 * 以前 loadLive 每 5 秒都把 scrollTop 强行拉回顶/底，人一套滑到中间就被拽回去，
 * 看起来像「鼠标一动就弹回顶部」。现在的规则：
 *   - 只有你本来就停在顶（分组视图）/ 底（行视图）时，才继续跟着最新一条走；
 *   - 你一旦自己滑开了，就记住位置不动 —— 分组视图新日志插在最上面，
 *     按"高度增量"补偿 scrollTop，眼里的内容一行都不跳。
 * 关掉浏览器原生 scroll-anchoring（CSS overflow-anchor: none），避免和我们手算的补偿叠加。
 */
const stickTop = ref(true)
const stickBottom = ref(true)

function onListScroll() {
  const el = listEl.value
  if (!el) return
  stickTop.value = el.scrollTop <= 24
  stickBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 32
}

/**
 * @param {'top'|'bottom'|'keep'} [anchor] 不传 = 按你当前是否停在最新处自动决定
 */
async function loadLive({ anchor } = {}) {
  const before = listEl.value
  const prevTop = before ? before.scrollTop : 0
  const prevHeight = before ? before.scrollHeight : 0
  try {
    await store.loadLogs()
  } catch (_) { /* ignore */ }
  await nextTick()
  const box = listEl.value
  if (!box) return

  const isRuns = viewMode.value === 'runs'
  const mode = anchor || (isRuns
    ? (stickTop.value ? 'top' : 'keep')
    : (stickBottom.value ? 'bottom' : 'keep'))

  if (mode === 'top') box.scrollTop = 0
  else if (mode === 'bottom') box.scrollTop = box.scrollHeight
  else if (mode === 'keep' && isRuns) {
    // 新的轮次插在最上面 → 内容整体下移了 delta，scrollTop 同步加上去，视野不动
    const delta = box.scrollHeight - prevHeight
    if (delta > 0) box.scrollTop = prevTop + delta
  }
  // keep + 行视图：新行加在底部，scrollTop 不用动
}

async function loadHistory() {
  if (!historyDate.value) return
  isHistory.value = true
  try {
    store.logs = await window.xnowpost.getLogsByDate(historyDate.value)
  } catch (_) { store.logs = [] }
  await nextTick()
  if (listEl.value) listEl.value.scrollTop = 0   // 历史日志从头看
}

function switchToLive() {
  isHistory.value = false
  historyDate.value = ''
  loadLive({ anchor: viewMode.value === 'runs' ? 'top' : 'bottom' })
}

// 实时模式每 5 秒重读一次今天的日志文件：
// 调度器是**另一个进程**在写 scheduler-<日期>.log，主进程不会转发它的每一行，
// 不轮询的话界面永远停在打开这一页的那一刻（用户实际反馈「只有这几行」就是这么来的）。
let liveTimer = null
onMounted(() => {
  loadLive()
  liveTimer = setInterval(() => {
    if (isHistory.value) return
    if (document.visibilityState !== 'visible') return
    loadLive()
  }, 5000)
})
onUnmounted(() => { if (liveTimer) clearInterval(liveTimer) })
</script>

<style scoped>
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
h2 { font-size: 24px; }
.btn-secondary { padding: 8px 16px; background: #334155; color: #e2e8f0; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
.btn-secondary:hover { background: #475569; }
.header-right { display: flex; gap: 8px; align-items: center; }
.date-input {
  padding: 6px 10px; border: 1px solid #334155; border-radius: 6px;
  background: #1e293b; color: #e2e8f0; font-size: 13px; outline: none;
}
.date-input:focus { border-color: #f59e0b; }
.history-badge {
  font-size: 12px; color: #60a5fa; background: #1e3a5f33; border: 1px solid #2563eb33;
  padding: 4px 10px; border-radius: 6px; display: inline-block;
}
.history-badge.live { color: #22c55e; background: #052e1633; border-color: #22c55e33; }
.stat-bar { display: flex; gap: 12px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.cleared-chip {
  margin-left: 10px;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--brand);
  background: var(--brand-soft);
  cursor: pointer;
}
.cleared-chip:hover { filter: brightness(1.1); }.stat-text { font-size: 12px; color: #64748b; }

.filter-bar { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; align-items: center; }
.filter-sep { color: #334155; margin: 0 2px; }
.filter-chip {
  padding: 4px 12px; border-radius: 6px; font-size: 12px; font-weight: 600;
  background: #1e293b; color: #64748b; border: 1px solid #334155;
  cursor: pointer; transition: all 0.15s; user-select: none;
}
.filter-chip:hover { color: #94a3b8; border-color: #475569; }
.filter-chip.active { background: #334155; color: #f59e0b; border-color: #f59e0b44; }
.filter-chip.source.active { color: #60a5fa; border-color: #60a5fa44; }
.filter-chip.mode.active { color: #a78bfa; border-color: #a78bfa44; }

/* ---- 按任务分组 ---- */
.run { border-bottom: 1px solid #1e293b; }
.run-hd {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 7px 6px; cursor: pointer; font-size: 12.5px; font-family: monospace;
}
.run-hd:hover { background: #1e293b55; }
.run-caret { color: #64748b; width: 12px; flex: none; }
.run-time { color: #94a3b8; }
.run-title { color: #e2e8f0; font-weight: 600; }
.run-result { font-weight: 600; }
.run-result.success { color: #22c55e; }
.run-result.error { color: #ef4444; }
.run-result.unknown { color: #f59e0b; }
.run-result.muted { color: #64748b; }
.run-meta { color: #64748b; }
.run-meta.ok { color: #22c55e; }
.run-meta.bad { color: #ef4444; }
.run-meta.warn { color: #f59e0b; }
.run-count { margin-left: auto; color: #475569; }
.run-fail {
  color: #f87171; font-size: 12px; font-family: monospace;
  padding: 0 6px 8px 34px; word-break: break-all;
}
.run-body { border-left: 2px solid #1e293b; margin: 0 0 8px 12px; padding-left: 6px; }
.more-btn {
  margin-left: auto; font-size: 12px; color: #60a5fa; cursor: pointer;
  border: 1px dashed #2563eb55; border-radius: 6px; padding: 3px 10px;
}
.more-btn:hover { background: #1e3a5f33; }

.log-container {
  border-radius: 8px; padding: 12px; max-height: calc(100vh - 230px); overflow-y: auto;
  /* 关掉浏览器原生 scroll-anchoring：我们自己在 loadLive 里按高度增量补偿，
     两套同时生效会互相打架（表现成「有时候跳一格」）。 */
  overflow-anchor: none;
  /* 日志区保持深底（等宽字要看得清），但描边走品牌渐变，和别的卡片是一套 */
  background:
    linear-gradient(rgba(10, 16, 27, 0.86), rgba(10, 16, 27, 0.86)) padding-box,
    linear-gradient(135deg, rgba(168, 85, 247, 0.5), rgba(59, 130, 246, 0.35) 50%, rgba(20, 184, 166, 0.45)) border-box;
  border: 1px solid transparent;
}
.log-line { display: flex; gap: 8px; padding: 3px 0; font-size: 13px; font-family: monospace; border-bottom: 1px solid #1e293b22; }
.log-time { color: #64748b; min-width: 148px; }
.log-src {
  min-width: 34px; text-align: center; font-size: 10px; line-height: 16px;
  border-radius: 3px; padding: 0 4px; height: 16px; margin-top: 1px;
  background: #1e293b; color: #64748b; flex: none;
}
.log-src.scheduler { background: #1e3a5f; color: #93c5fd; }
.log-level { min-width: 20px; flex: none; }
.log-msg { color: #94a3b8; word-break: break-all; }
.log-line.success .log-msg { color: #22c55e; }
.log-line.error .log-msg { color: #ef4444; }
.log-line.warning .log-msg { color: #f59e0b; }
.empty { padding: 40px; text-align: center; color: #64748b; }
</style>
