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
      <!-- 全部账号汇总 + 详细卡片 -->
      <div v-for="accName in accountNames" :key="accName" class="account-section">
        <!-- 账号标题 -->
        <div class="account-title">
          <span class="ac-avatar">👤</span>
          <span class="ac-name">{{ displayName(accName) }}</span>
          <span v-if="accountMeta(accName)?.username" class="ac-username" @click="openProfile(accName)">{{ accountMeta(accName).username }}</span>
          <span v-if="accountMeta(accName)?.profileUrl" class="ac-link" @click="openProfile(accName)">🔗</span>
          <span class="ac-meta">{{ Object.keys(data.accounts[accName]).length }} 个平台</span>
        </div>

        <!-- 摘要（类 TG 推送格式） -->
        <div class="report-summary">
          <div v-for="(line, i) in summaryFor(accName)" :key="i"
               class="sl" :class="{ 'sl-divider': line.startsWith('━') }">{{ line }}</div>
        </div>

        <!-- 平台数据表 -->
        <div v-for="(pd, platform) in data.accounts[accName]" :key="platform" class="pcard">
          <div class="pc-hd">
            <span class="pc-em">{{ platformEmoji[platform] || '📡' }}</span>
            <span class="pc-nm">{{ platformNames[platform] || platform }}</span>
          </div>
          <table class="tbl">
            <thead>
              <tr>
                <th>指标</th>
                <th class="r">本日</th>
                <th class="r">昨日</th>
                <th class="r">对比</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="metric in metricsOrder" :key="metric" v-if="pd.stats[metric] !== undefined">
                <td class="ml">{{ metricLabels[metric] || metric }}</td>
                <td class="r">{{ fmt(pd.stats[metric]) }}</td>
                <td class="r yst">{{ pd.yesterday[metric] !== undefined ? fmt(pd.yesterday[metric]) : '-' }}</td>
                <td class="r df">
                  <span v-if="pd.yesterday[metric] !== undefined" :class="dCls(pd.stats[metric], pd.yesterday[metric])">
                    {{ dArr(pd.stats[metric], pd.yesterday[metric]) }}{{ dFmt(pd.stats[metric], pd.yesterday[metric]) }}
                  </span>
                  <span v-else class="na">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- 趋势图表 -->
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
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

const loading = ref(true)
const data = ref(null)
const curIdx = ref(0)
const pushing = ref(false)

import { PLATFORM_EMOJI as platformEmoji, PLATFORM_NAMES as platformNames, METRIC_LABELS as metricLabels, METRICS_ORDER as metricsOrder, formatNum as fmt, diffArrow as dArr, diffFmt as dFmt } from '../constants.js'

// 趋势图
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
  return v >= 10000 ? (v/10000).toFixed(1)+'万' : v >= 1000 ? (v/1000).toFixed(1)+'K' : String(v)
})

async function loadTrend(days) {
  try {
    trendData.value = await window.xnowpost.getTrend(days || 7)
    if (trendKeys.value.length) activeTrend.value = trendKeys.value[0]
  } catch (_) {}
}

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

function summaryFor(acc) {
  const platforms = data.value?.accounts?.[acc]
  if (!platforms) return []
  const meta = accountMeta(acc)
  const userTag = meta?.username ? ` @${meta.username.replace(/^@/, '')}` : ''
  const timeTag = data.value?.collectedAt ? ` 🕐${data.value.collectedAt}` : ''
  const lines = [
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📊 XNOW 数据日报 · ${data.value.date}${acc !== 'default' ? ` · ${acc}` : ''}${userTag}${timeTag}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
  ]
  let has = false
  for (const [pl, pd] of Object.entries(platforms)) {
    const em = platformEmoji[pl] || '📡'
    const nm = platformNames[pl] || pl
    const parts = [`${em} ${nm}`]
    for (const m of metricsOrder) {
      if (pd.stats[m] === undefined) continue
      has = true
      const lb = metricLabels[m] || m
      const v = fmt(pd.stats[m])
      if (pd.yesterday[m] !== undefined) {
        const a = dArr(pd.stats[m], pd.yesterday[m])
        const d = dFmt(pd.stats[m], pd.yesterday[m])
        parts.push(`${lb} ${v} ${a}${d}`)
      } else parts.push(`${lb} ${v}`)
    }
    if (parts.length > 1) lines.push(parts.join(' | '))
  }
  if (!has) lines.push('暂无数据')
  lines.push('', `━━━━━━━━━━━━━━━━━━━━━━━━`)
  return lines
}

// fmt, dArr, dFmt imported from constants.js
function dCls(c,p) { return c>=p ? 'up' : 'dn' }

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
      // also cache by its actual date
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
  load(data.value.availableDates[curIdx.value-1])
}
function nextDate() {
  if (!data.value || curIdx.value >= data.value.availableDates.length-1) return
  load(data.value.availableDates[curIdx.value+1])
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
  const rows = [['date','account','platform','metric','value']]
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
.report-page{max-width:800px;margin:0 auto}
.page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:12px}
.page-header h2{margin:0;font-size:22px}
.date-nav{display:flex;align-items:center;gap:8px;background:#1e293b;border-radius:8px;padding:5px 10px;border:1px solid #334155}
.date-btn{background:none;border:none;color:#94a3b8;cursor:pointer;font-size:13px;padding:3px 5px;border-radius:4px;transition:all .15s}
.date-btn:hover:not(:disabled){color:#f59e0b;background:#33415544}
.date-btn:disabled{opacity:.3;cursor:not-allowed}
.date-label{font-size:13px;font-weight:600;color:#e2e8f0;min-width:90px;text-align:center}
.date-time{font-size:11px;color:#22c55e;background:#22c55e22;padding:2px 8px;border-radius:4px;white-space:nowrap}
.nav-divider{width:1px;height:16px;background:#334155;margin:0 2px}

.loading-box{display:flex;align-items:center;justify-content:center;gap:10px;padding:60px 0;color:#64748b}
.loading-spinner{width:20px;height:20px;border:2px solid #334155;border-top-color:#f59e0b;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.empty-box{display:flex;flex-direction:column;align-items:center;gap:10px;padding:60px 0;color:#64748b;font-size:14px}
.empty-icon{font-size:40px}
.empty-hint{font-size:12px;color:#475569}

/* 账号区块 */
.account-section{margin-bottom:20px}
.account-title{display:flex;align-items:center;gap:8px;margin-bottom:10px;padding:8px 14px;background:linear-gradient(135deg,#1e3a5f22,#1e40af22);border:1px solid #2563eb44;border-radius:10px}
.ac-avatar{font-size:15px}
.ac-name{font-size:14px;font-weight:700;color:#60a5fa}
.ac-username{font-size:12px;color:#22c55e;cursor:pointer;font-weight:600}
.ac-username:hover{text-decoration:underline}
.ac-link{font-size:14px;cursor:pointer;opacity:0.6;transition:opacity .15s}
.ac-link:hover{opacity:1}
.ac-meta{margin-left:auto;font-size:11px;color:#64748b}

/* 摘要 */
.report-summary{background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:12px 16px;margin-bottom:12px;font-family:monospace;font-size:13px;line-height:1.7;color:#94a3b8;white-space:pre-wrap;word-break:break-all}
.sl-divider{color:#334155}

/* 平台卡片 - 简洁 */
.pcard{background:#1e293b;border-radius:10px;padding:12px 14px;margin-bottom:6px;border:1px solid transparent;transition:border-color .2s}
.pcard:hover{border-color:#334155}
.pc-hd{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.pc-em{font-size:15px}
.pc-nm{font-size:13px;font-weight:700;color:#e2e8f0}

/* 数据表 */
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{color:#64748b;font-weight:600;text-align:left;padding:3px 8px;border-bottom:1px solid #0f172a}
.tbl th.r,.tbl td.r{text-align:right}
.tbl td{padding:4px 8px;color:#94a3b8;border-bottom:1px solid #0f172a22}
.tbl tr:last-child td{border-bottom:none}
.ml{color:#cbd5e1;font-weight:500}
.yst{color:#64748b}
.df{font-weight:600;min-width:50px}
.up{color:#22c55e}
.dn{color:#ef4444}
.na{color:#475569}

/* 趋势图表 */
.trend-section{margin-top:24px;padding-top:16px;border-top:1px solid #334155}
.trend-title{font-size:15px;color:#e2e8f0;margin:0 0 10px}
.trend-tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.trend-chip{padding:4px 10px;border-radius:5px;font-size:11px;font-weight:600;background:#1e293b;color:#64748b;border:1px solid #334155;cursor:pointer;transition:all .15s}
.trend-chip:hover{color:#94a3b8;border-color:#475569}
.trend-chip.active{background:#334155;color:#f59e0b;border-color:#f59e0b44}
.trend-chart{background:#0f172a;border-radius:10px;padding:12px;border:1px solid #1e293b}
.trend-svg{width:100%;height:auto;display:block}
</style>

