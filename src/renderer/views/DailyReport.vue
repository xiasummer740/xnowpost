<template>
  <div class="report-page">
    <div class="page-header">
      <h2>📊 数据日报</h2>
      <div class="date-nav" v-if="data">
        <button class="date-btn" @click="prevDate" :disabled="curIdx <= 0">◀</button>
        <span class="date-label">{{ data.date }}</span>
        <span v-if="data.collectedAt" class="date-time" title="采集时间">🕐 {{ data.collectedAt }}</span>
        <button class="date-btn" @click="nextDate" :disabled="curIdx >= data.availableDates.length - 1">▶</button>
        <span class="nav-divider"></span>
        <button class="date-btn" @click="handleRefresh" title="刷新">🔄</button>
        <button class="date-btn" @click="handlePush" :disabled="pushing" title="推送到 Telegram">{{ pushing ? '⏳' : '📤' }}</button>
        <button class="date-btn" @click="handleExport" title="导出 CSV">📥</button>
      </div>
    </div>

    <div v-if="loading" class="loading-box">
      <span class="loading-spinner"></span>
      <span>加载中...</span>
    </div>

    <div v-else-if="!data" class="empty-box">
      <span class="empty-icon">📭</span>
      <span>暂无日报数据</span>
      <span class="empty-hint">设置「采集+日报」闹钟后，到点自动采集并生成日报</span>
    </div>

    <template v-else>
      <!-- ===== KPI 汇总行 ===== -->
      <div class="kpi-row">
        <div v-for="k in kpiList" :key="k.key" class="kpi-card" :style="{ '--accent': k.color }">
          <span class="kpi-icon">{{ k.icon }}</span>
          <div class="kpi-body">
            <span class="kpi-label">{{ k.label }}</span>
            <span class="kpi-val">{{ fmt(k.today) }}</span>
            <span v-if="k.showDiff" class="kpi-diff" :class="k.today >= k.yesterday ? 'up' : 'dn'">
              {{ k.yesterday !== undefined ? diffStr(k.today, k.yesterday) : '-' }}
            </span>
          </div>
        </div>
      </div>

      <!-- ===== 账号卡片 ===== -->
      <div v-for="accName in accountNames" :key="accName" class="ac-card">
        <div class="ac-hd">
          <span class="ac-avatar">👤</span>
          <span class="ac-name">{{ displayName(accName) }}</span>
          <span v-if="accountMeta(accName)?.username" class="ac-username" @click="openProfile(accName)">{{ accountMeta(accName).username }}</span>
          <span class="ac-meta">{{ Object.keys(data.accounts[accName]).length }} 个平台</span>
        </div>

        <div v-for="(pd, platform) in data.accounts[accName]" :key="platform" class="pl-card">
          <div class="pl-hd">
            <span class="pl-emoji">{{ platformEmoji[platform] || '📡' }}</span>
            <span class="pl-name">{{ platformNames[platform] || platform }}</span>
          </div>
          <div class="pl-body">
            <div v-for="metric in visibleMetrics(pd)" :key="metric" class="mr">
              <div class="mr-top">
                <span class="mr-label">{{ metricLabels[metric] || metric }}</span>
                <span class="mr-val">{{ fmt(pd.stats[metric]) }}</span>
                <span v-if="pd.yesterday[metric] !== undefined" class="mr-diff" :class="dCls(pd.stats[metric], pd.yesterday[metric])">
                  {{ diffStr(pd.stats[metric], pd.yesterday[metric]) }}
                </span>
              </div>
              <div class="mr-bar">
                <div class="mr-track">
                  <div class="mr-fill mr-fill-today" :style="{ width: barPct(pd.stats[metric], metricMax[pdKey(accName,platform)]) }"></div>
                  <div v-if="pd.yesterday[metric] !== undefined" class="mr-fill mr-fill-yst" :style="{ width: barPct(pd.yesterday[metric], metricMax[pdKey(accName,platform)]) }"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== 趋势图表 ===== -->
      <div v-if="trendData && trendKeys.length > 0" class="trend-section">
        <h3 class="trend-title">📈 趋势（近 {{ trendDays }} 天）</h3>
        <div class="trend-tabs">
          <span v-for="k in trendKeys" :key="k" class="trend-chip"
                :class="{ active: activeTrend === k }" @click="activeTrend = k">
            {{ k.split('|')[1] }} · {{ metricLabel(k.split('|')[2]) }}
          </span>
        </div>
        <div class="trend-chart" v-if="activeTrend && trendData[activeTrend]">
          <svg :viewBox="`0 0 ${chartW} ${chartH}`" class="trend-svg">
            <line v-for="gi in 4" :key="'g'+gi" :x1="padL" :y1="padT + (chartH-padT-padB)/4*gi"
                  :x2="chartW-padR" :y2="padT + (chartH-padT-padB)/4*gi"
                  stroke="#334155" stroke-width="1" />
            <polyline :points="trendPoints" fill="none" stroke="#f59e0b" stroke-width="2"
                      stroke-linejoin="round" stroke-linecap="round" />
            <circle v-for="(pt, pi) in trendPointCoords" :key="'p'+pi"
                    :cx="pt.x" :cy="pt.y" r="3" fill="#f59e0b" />
            <text v-for="(pt, pi) in trendPointCoords" :key="'x'+pi"
                  :x="pt.x" :y="chartH-4" text-anchor="middle"
                  font-size="9" fill="#64748b">{{ pt.label.slice(-5) }}</text>
            <text v-if="trendPointCoords.length" :x="trendPointCoords[trendPointCoords.length-1].x"
                  :y="trendPointCoords[trendPointCoords.length-1].y - 8"
                  text-anchor="middle" font-size="11" font-weight="700" fill="#f59e0b"
            >{{ trendLastVal }}</text>
          </svg>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { PLATFORM_EMOJI as platformEmoji, PLATFORM_NAMES as platformNames, METRIC_LABELS as metricLabels, METRICS_ORDER as metricsOrder, formatNum as fmt, diffArrow as dArr, diffFmt as dFmt } from '../constants.js'

const loading = ref(true)
const data = ref(null)
const curIdx = ref(0)
const pushing = ref(false)

// --- KPI 配置 ---
const kpiDefs = [
  { key: 'views',      label: '总播放',   icon: '▶️', color: '#3b82f6' },
  { key: 'profile_views', label: '主页访问', icon: '👁️', color: '#8b5cf6' },
  { key: 'likes',      label: '总点赞',   icon: '❤️', color: '#ef4444' },
  { key: 'comments',   label: '总评论',   icon: '💬', color: '#22c55e' },
  { key: 'followers',  label: '总粉丝',   icon: '👥', color: '#f59e0b' },
]

// diff 字符串（箭头+绝对值）
function diffStr(c, p) {
  if (p === undefined) return '-'
  return (c >= p ? '↑' : '↓') + dFmt(c, p)
}

// --- KPI 汇总计算 ---
const kpiList = computed(() => {
  if (!data.value?.accounts) return []
  const accs = data.value.accounts
  return kpiDefs.map(def => {
    let today = 0, yesterday = 0, hasYst = false
    for (const platCards of Object.values(accs)) {
      for (const pd of Object.values(platCards)) {
        if (pd.stats[def.key] !== undefined) today += pd.stats[def.key]
        if (pd.yesterday[def.key] !== undefined) { yesterday += pd.yesterday[def.key]; hasYst = true }
      }
    }
    return { ...def, today, yesterday, showDiff: hasYst }
  })
})

// --- 账号相关 ---
const accountNames = computed(() => data.value?.accounts ? Object.keys(data.value.accounts) : [])

function accountMeta(acc) {
  return data.value?.accountMeta?.[acc] || null
}
function displayName(acc) {
  return acc === 'default' ? '默认' : acc
}
function openProfile(acc) {
  const meta = accountMeta(acc)
  if (meta?.profileUrl) window.xnowpost.openExternal(meta.profileUrl)
}

// 每个账号+平台唯一 key 用于缓存最大值的引用
function pdKey(acc, platform) { return acc + '|' + platform }

// 当日可见指标（按 METRICS_ORDER 排序，只显示有值的）
function visibleMetrics(pd) {
  return metricsOrder.filter(m => pd.stats[m] !== undefined)
}

// 每个平台内最大指标值（用于柱状图 100% 基准）
const metricMax = computed(() => {
  const m = {}
  if (!data.value?.accounts) return m
  for (const [acc, platforms] of Object.entries(data.value.accounts)) {
    for (const [pl, pd] of Object.entries(platforms)) {
      const key = pdKey(acc, pl)
      let max = 1
      for (const metric of metricsOrder) {
        if (pd.stats[metric] !== undefined) max = Math.max(max, pd.stats[metric])
        if (pd.yesterday[metric] !== undefined) max = Math.max(max, pd.yesterday[metric])
      }
      m[key] = max
    }
  }
  return m
})

function barPct(val, max) {
  if (!val || !max) return '0%'
  return Math.max(2, (val / max) * 100) + '%'
}

function dCls(c, p) { return c >= p ? 'up' : 'dn' }

// --- 趋势 ---
const trendData = ref(null)
const activeTrend = ref('')
const trendDays = ref(7)
const chartW = 600, chartH = 200, padL = 40, padR = 20, padT = 30, padB = 30

const trendKeys = computed(() => trendData.value ? Object.keys(trendData.value) : [])

function metricLabel(m) { return metricLabels[m] || m }

const trendPoints = computed(() => {
  const s = trendData.value?.[activeTrend.value]
  if (!s) return ''
  const vals = s.values
  const max = Math.max(...vals.filter(v => v !== null), 1)
  const min = Math.min(...vals.filter(v => v !== null), 0)
  const range = max - min || 1
  const stepX = (chartW - padL - padR) / Math.max(vals.length - 1, 1)
  return vals.map((v, i) => {
    if (v === null) return ''
    const x = padL + i * stepX
    const y = padT + (chartH - padT - padB) * (1 - (v - min) / range)
    return `${x},${y}`
  }).filter(Boolean).join(' ')
})

const trendPointCoords = computed(() => {
  const s = trendData.value?.[activeTrend.value]
  if (!s) return []
  const vals = s.values
  const max = Math.max(...vals.filter(v => v !== null), 1)
  const min = Math.min(...vals.filter(v => v !== null), 0)
  const range = max - min || 1
  const stepX = (chartW - padL - padR) / Math.max(vals.length - 1, 1)
  return vals.map((v, i) => {
    if (v === null) return null
    const x = padL + i * stepX
    const y = padT + (chartH - padT - padB) * (1 - (v - min) / range)
    return { x, y, label: s.dates[i], value: v }
  }).filter(Boolean)
})

const trendLastVal = computed(() => {
  const pts = trendPointCoords.value
  if (!pts.length) return ''
  const v = pts[pts.length - 1].value
  return v >= 10000 ? (v / 10000).toFixed(1) + '万' : v >= 1000 ? (v / 1000).toFixed(1) + 'K' : String(v)
})

async function loadTrend(days) {
  try {
    trendData.value = await window.xnowpost.getTrend(days || 7)
    if (trendKeys.value.length) activeTrend.value = trendKeys.value[0]
  } catch (_) {}
}

// --- 日报缓存 ---
const reportCache = new Map()

async function load(date) {
  loading.value = true
  try {
    const cacheKey = date || '__latest'
    if (reportCache.has(cacheKey)) {
      data.value = reportCache.get(cacheKey)
      if (data.value) {
        curIdx.value = data.value.availableDates.indexOf(data.value.date)
        if (curIdx.value < 0) curIdx.value = 0
      }
      loading.value = false
      return
    }
    const r = await window.xnowpost.getDailyReport(date)
    data.value = r
    if (r) {
      reportCache.set(cacheKey, r)
      if (cacheKey !== r.date) reportCache.set(r.date, r)
      curIdx.value = r.availableDates.indexOf(r.date)
      if (curIdx.value < 0) curIdx.value = 0
    }
  } catch (e) {
    console.error('加载日报失败:', e)
    data.value = null
  } finally { loading.value = false }
}

function prevDate() {
  if (!data.value || curIdx.value <= 0) return
  load(data.value.availableDates[curIdx.value - 1])
}
function nextDate() {
  if (!data.value || curIdx.value >= data.value.availableDates.length - 1) return
  load(data.value.availableDates[curIdx.value + 1])
}
function handleRefresh() { if (data.value) load(data.value.date) }
async function handlePush() {
  if (!data.value) return
  pushing.value = true
  try {
    const r = await window.xnowpost.pushReport(data.value.date)
    if (!r.ok && r.message) console.error('推送失败:', r.message)
  } catch (e) { console.error('推送调用失败:', e)
  } finally { pushing.value = false }
}

async function handleExport() {
  if (!data.value) return
  const rows = [['date', 'account', 'platform', 'metric', 'value']]
  for (const [acc, platforms] of Object.entries(data.value.accounts)) {
    for (const [plat, pd] of Object.entries(platforms)) {
      for (const [metric, value] of Object.entries(pd.stats)) {
        rows.push([data.value.date, acc, plat, metric, value])
      }
    }
  }
  const csv = rows.map(r => r.join(',')).join('\n')
  try {
    await window.xnowpost.exportCsv(csv, `report-${data.value.date}.csv`)
  } catch (e) { console.error('导出失败:', e) }
}

onMounted(() => load())
</script>

<style scoped>
/* =============================================
   数据日报 — 仪表盘风格 v2
   ============================================= */
.report-page { max-width: 860px; margin: 0 auto; padding-bottom: 40px; }

/* ---- 头部 ---- */
.page-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 20px; flex-wrap: wrap; gap: 12px;
}
.page-header h2 { margin: 0; font-size: 22px; }
.date-nav {
  display: flex; align-items: center; gap: 8px;
  background: #1e293b; border-radius: 8px; padding: 5px 10px; border: 1px solid #334155;
}
.date-btn {
  background: none; border: none; color: #94a3b8; cursor: pointer;
  font-size: 13px; padding: 3px 5px; border-radius: 4px; transition: all .15s;
}
.date-btn:hover:not(:disabled) { color: #f59e0b; background: #33415544; }
.date-btn:disabled { opacity: .3; cursor: not-allowed; }
.date-label { font-size: 13px; font-weight: 600; color: #e2e8f0; min-width: 90px; text-align: center; }
.date-time {
  font-size: 11px; color: #22c55e; background: #22c55e22;
  padding: 2px 8px; border-radius: 4px; white-space: nowrap;
}
.nav-divider { width: 1px; height: 16px; background: #334155; margin: 0 2px; }

/* ---- 加载/空态 ---- */
.loading-box, .empty-box {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 60px 0; color: #64748b; font-size: 14px;
}
.loading-box { flex-direction: row; justify-content: center; }
.loading-spinner {
  width: 20px; height: 20px; border: 2px solid #334155;
  border-top-color: #f59e0b; border-radius: 50%; animation: spin .6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.empty-icon { font-size: 40px; }
.empty-hint { font-size: 12px; color: #475569; }

/* ===== KPI 汇总行 ===== */
.kpi-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px; margin-bottom: 24px;
}
.kpi-card {
  display: flex; align-items: center; gap: 12px;
  background: linear-gradient(135deg, #1e293b, #1a1f2e);
  border: 1px solid #334155; border-radius: 12px;
  padding: 14px 16px;
  position: relative; overflow: hidden;
  transition: border-color .2s, transform .15s;
}
.kpi-card:hover {
  border-color: var(--accent, #3b82f6) !important;
  transform: translateY(-2px);
}
.kpi-card::before {
  content: ''; position: absolute; top: 0; left: 0;
  width: 4px; height: 100%; background: var(--accent, #3b82f6);
  border-radius: 12px 0 0 12px;
}
.kpi-icon { font-size: 20px; flex-shrink: 0; }
.kpi-body { display: flex; flex-direction: column; min-width: 0; }
.kpi-label { font-size: 11px; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
.kpi-val { font-size: 20px; font-weight: 800; color: #f1f5f9; line-height: 1.2; margin: 2px 0; }
.kpi-diff { font-size: 11px; font-weight: 700; }
.kpi-diff.up { color: #22c55e; }
.kpi-diff.dn { color: #ef4444; }

/* ===== 账号卡片 ===== */
.ac-card {
  background: #1e293b; border: 1px solid #334155; border-radius: 14px;
  padding: 16px; margin-bottom: 16px;
  transition: border-color .2s;
}
.ac-card:hover { border-color: #475569; }

.ac-hd {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 14px; padding-bottom: 12px;
  border-bottom: 1px solid #334155;
}
.ac-avatar { font-size: 16px; }
.ac-name { font-size: 15px; font-weight: 700; color: #e2e8f0; }
.ac-username {
  font-size: 12px; color: #22c55e; cursor: pointer; font-weight: 600;
  background: #22c55e15; padding: 1px 8px; border-radius: 4px;
}
.ac-username:hover { text-decoration: underline; }
.ac-meta { margin-left: auto; font-size: 11px; color: #64748b; }

/* ---- 平台卡片 ---- */
.pl-card + .pl-card { margin-top: 12px; padding-top: 12px; border-top: 1px dashed #2a3a52; }
.pl-hd {
  display: flex; align-items: center; gap: 6px; margin-bottom: 8px;
}
.pl-emoji { font-size: 14px; }
.pl-name { font-size: 13px; font-weight: 700; color: #94a3b8; }

/* ---- 指标行 ---- */
.mr { margin-bottom: 10px; }
.mr:last-child { margin-bottom: 0; }
.mr-top {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 3px;
}
.mr-label { font-size: 12px; color: #94a3b8; font-weight: 600; min-width: 56px; }
.mr-val { font-size: 14px; font-weight: 700; color: #e2e8f0; min-width: 50px; text-align: right; }
.mr-diff { font-size: 11px; font-weight: 700; min-width: 48px; }
.mr-diff.up { color: #22c55e; }
.mr-diff.dn { color: #ef4444; }

/* ---- 柱状条 ---- */
.mr-bar { padding-left: 56px; } /* align with label */
.mr-track {
  position: relative; height: 8px;
  background: #0f172a; border-radius: 4px; overflow: hidden;
}
.mr-fill {
  position: absolute; top: 0; left: 0; height: 100%;
  border-radius: 4px; transition: width .3s ease;
}
.mr-fill-today { background: linear-gradient(90deg, #3b82f6, #60a5fa); z-index: 2; }
.mr-fill-yst {
  background: linear-gradient(90deg, #475569, #64748b);
  z-index: 1; opacity: .7;
}

/* ===== 趋势图表 ===== */
.trend-section { margin-top: 24px; padding-top: 16px; border-top: 1px solid #334155; }
.trend-title { font-size: 15px; color: #e2e8f0; margin: 0 0 10px; }
.trend-tabs { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
.trend-chip {
  padding: 4px 10px; border-radius: 5px; font-size: 11px; font-weight: 600;
  background: #1e293b; color: #64748b; border: 1px solid #334155; cursor: pointer;
  transition: all .15s;
}
.trend-chip:hover { color: #94a3b8; border-color: #475569; }
.trend-chip.active { background: #334155; color: #f59e0b; border-color: #f59e0b44; }
.trend-chart { background: #0f172a; border-radius: 10px; padding: 12px; border: 1px solid #1e293b; }
.trend-svg { width: 100%; height: auto; display: block; }
</style>
