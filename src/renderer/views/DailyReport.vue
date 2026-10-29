<template>
  <div class="report-page">
    <div class="page-header">
      <h2>📊 数据日报</h2>
      <div class="date-nav" v-if="data">
        <button class="date-btn" @click="prevDate" :disabled="curIdx <= 0">◀</button>
        <span class="date-label">{{ data.date }}</span>
        <span v-if="data.collectedAt" class="date-time" title="采集时间">🕐 {{ data.collectedAt }}</span>
        <!-- 首页原来的「最近费用」卡片已删：这个数字放在这里更合理（和"这天发了什么"一起看） -->
        <span v-if="lastCost" class="date-cost" title="最近一次生成的总花费（DeepSeek 文案 + 生图）">💰 最近一次 ¥{{ lastCost }}</span>
        <button class="date-btn" @click="nextDate" :disabled="curIdx >= data.availableDates.length - 1">▶</button>
        <span class="nav-divider"></span>
        <!--
          三个纯图标按钮以前只有 tooltip（🔄 / 📤 / 📥），而且「导出」被画成了红色 ——
          红色在本项目里只表示「失败/危险」，导出是安全操作，颜色把意思说反了。
          现在带文字、统一中性色，"推 TG"也直接写明。
        -->
        <button class="date-btn text" @click="handleRefresh" title="重读这一天的采集结果">🔄 刷新</button>
        <button class="date-btn text" @click="handlePush" :disabled="pushing" title="把这一天推送到 Telegram（没配 token 会提示去配置）">
          {{ pushing ? '⏳ 推送中' : '📤 推送 TG' }}
        </button>
        <button class="date-btn text" @click="handleExport" title="导出这一天的 CSV">📥 导出 CSV</button>
      </div>
    </div>

    <!-- 采集结果提示：这一页显示的是"某天的数据"，当天到底采到没有必须说清楚 -->
    <div v-if="collectWarn" class="collect-warn" :class="collectWarn.tone">
      <span class="cw-icon">{{ collectWarn.tone === 'bad' ? '⚠️' : 'ℹ️' }}</span>
      <div class="cw-body">
        <span class="cw-title">{{ collectWarn.title }}</span>
        <span v-if="collectWarn.hint" class="cw-hint">{{ collectWarn.hint }}</span>
      </div>
    </div>

    <!-- 发布侧结果：这一页原来只有「平台数据」，账号没数据时整页都是「—」。
         发了多少条 / 失败多少条 / 有没有未确认，永远是实话，也是每天最想知道的事。 -->
    <div v-if="publishDay" class="x-card pub-day">
      <div class="x-card-head">
        <span class="x-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 4 11.6 20.4l-2.1-6.9L2.6 11.4z" />
            <path d="m9.5 13.5 4.2-4.2" />
          </svg>
        </span>
        <h2>这天发了什么</h2>
        <span class="x-hint">{{ publishDay.date }} · 共 {{ publishDay.sessions }} 个生成会话</span>
        <div class="x-spacer"></div>
        <span class="x-tag" :class="publishDay.published ? 'ok' : 'mute'">已发 {{ publishDay.published }}</span>
        <span class="x-tag" :class="publishDay.failed ? 'danger' : 'mute'">失败 {{ publishDay.failed }}</span>
        <span class="x-tag" :class="publishDay.unconfirmed ? 'warn' : 'mute'">未确认 {{ publishDay.unconfirmed }}</span>
      </div>
      <ul v-if="publishDay.accounts.length" class="pub-list">
        <li v-for="(a, i) in publishDay.accounts.slice(0, 10)" :key="'ok' + i">
          <span class="x-tag ok">{{ a.env || '—' }}</span>
          <span class="pub-title">{{ a.title || a.session }}</span>
        </li>
      </ul>
      <ul v-if="publishDay.failures.length" class="pub-list is-bad">
        <li v-for="(f, i) in publishDay.failures.slice(0, 6)" :key="'bad' + i">
          <span class="x-tag" :class="f.unconfirmed ? 'warn' : 'danger'">{{ f.unconfirmed ? '未确认' : '失败' }}</span>
          <span class="pub-title">{{ f.session }}<template v-if="f.stage"> · {{ f.stage }}</template></span>
          <span class="pub-reason">{{ f.reason }}</span>
        </li>
      </ul>
      <p v-if="!publishDay.published && !publishDay.failures.length" class="x-tip">这天还没有发布记录（也没有失败记录）。</p>
      <p class="x-tip">「已发」来自发布账本（点过 Post 且确认公开）；「未确认」= 点过 Post 但没能证明已公开，既不重发也不算成功。</p>
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
      <!-- 只显示这天真的采到的指标（2026-10-19）：以前 5 张卡里 4 张是「—」，
           等于用首屏告诉用户"什么都没有"。全都没采到时整行不渲染，直接看下面的表。 -->
      <div v-if="kpiVisible.length" class="kpi-row">
        <div v-for="k in kpiVisible" :key="k.key" class="kpi-card" :style="{ '--accent': k.color }">
          <span class="kpi-icon">{{ k.icon }}</span>
          <div class="kpi-body">
            <span class="kpi-label">{{ k.label }}</span>
            <span class="kpi-val" :class="{ 'is-empty': k.today === null }">{{ kpiText(k.today) }}</span>
            <span v-if="k.showDiff" class="kpi-diff" :class="k.today >= k.yesterday ? 'up' : 'dn'">
              {{ k.yesterday !== null ? diffStr(k.today, k.yesterday) : '-' }}
            </span>
          </div>
        </div>
      </div>
      <p v-if="kpiVisible.length" class="kpi-note">「—」= 这天没采到这项指标（不是 0）。粉丝/关注/获赞来自账号主页，播放/点赞/评论来自 TikTok 分析页。</p>

      <!-- ===== 账号明细表 ===== -->
      <!--
        2026-10-19 收口：原来是「每个账号一张卡、每个平台一段、每个指标一行 + 进度条」，
        10 个号 × 3 个指标 = 30 行「0」+ 30 根空进度条，一屏几乎全是零和空条。
        现在压成一张表：一行一个（账号 + 平台），指标横向排开，没采到的还是显示「—」。
      -->
      <div class="ac-table-wrap">
        <table class="ac-table">
          <thead>
            <tr>
              <th style="width: 78px">账号</th>
              <th style="width: 92px">平台</th>
              <th>用户名</th>
              <th v-for="m in tableMetrics" :key="m" class="num">{{ metricLabels[m] || m }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in acRows" :key="row.accName + '|' + row.platform">
              <td class="ac-name">{{ displayName(row.accName) }}</td>
              <td>
                <span class="pl-chip">{{ platformEmoji[row.platform] || '📡' }} {{ platformNames[row.platform] || row.platform }}</span>
              </td>
              <td class="ac-username">
                <span v-if="accountMeta(row.accName)?.username" @click="openProfile(row.accName)">@{{ accountMeta(row.accName).username }}</span>
                <span v-else class="muted">—</span>
              </td>
              <td v-for="m in tableMetrics" :key="m" class="num">
                <template v-if="row.pd && row.pd.stats[m] !== undefined">
                  <span class="v">{{ fmt(row.pd.stats[m]) }}</span>
                  <span v-if="row.pd.yesterday && row.pd.yesterday[m] !== undefined" class="d" :class="dCls(row.pd.stats[m], row.pd.yesterday[m])">
                    {{ diffStr(row.pd.stats[m], row.pd.yesterday[m]) }}
                  </span>
                </template>
                <span v-else class="muted" :title="row.pd ? '这天没采到这项' : emptyReason(row.accName)">—</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="kpi-note">
          「—」= 这天没采到这项（不是 0）。粉丝/关注/获赞来自账号主页，播放/点赞/评论来自 TikTok 分析页；
          没采到数据的账号也列在这里，并写明原因。
        </p>
      </div>

      <!-- ===== 趋势图表 ===== -->
      <div v-if="trendData && trendOptions.length > 0" class="trend-section">
        <h3 class="trend-title">
          📈 趋势（近 {{ trendDays }} 天<span v-if="trendRange">：{{ trendRange }}</span>）
        </h3>
        <p class="trend-note">
          图例带账号名，点一下切换指标。
          <span v-if="trendLatest">这条线最近有数据的一天是 {{ trendLatest }}。</span>
          <span v-else>这个指标在窗口内没有任何数据。</span>
        </p>
        <div class="trend-tabs">
          <span v-for="o in trendOptions" :key="o.key" class="trend-chip"
                :class="{ active: activeTrend === o.key }" @click="activeTrend = o.key">
            {{ o.label }}
          </span>
        </div>
        <div class="trend-chart" v-if="activeTrend && trendData[activeTrend]">
          <svg :viewBox="`0 0 ${chartW} ${chartH}`" class="trend-svg">
            <line v-for="gi in 4" :key="'g'+gi" :x1="padL" :y1="padT + (chartH-padT-padB)/4*gi"
                  :x2="chartW-padR" :y2="padT + (chartH-padT-padB)/4*gi"
                  stroke="#334155" stroke-width="1" />
            <polyline v-for="(seg, si) in trendSegments" :key="'s'+si" :points="seg"
                      fill="none" stroke="#f59e0b" stroke-width="2"
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
// 指标强调色只在品牌渐变家族里挑（紫/蓝/青/靛）：红=失败、黄=警告、绿=成功，
// 这三种颜色在这个应用里只表示状态，不能拿去当装饰色（2026-10-29 配色收口）。
const kpiDefs = [
  { key: 'views',      label: '总播放',   icon: '▶️', color: '#3b82f6' },
  { key: 'profile_views', label: '主页访问', icon: '👁️', color: '#a855f7' },
  { key: 'likes',      label: '总点赞',   icon: '❤️', color: '#ec4899' },
  { key: 'comments',   label: '总评论',   icon: '💬', color: '#6366f1' },
  { key: 'followers',  label: '总粉丝',   icon: '👥', color: '#14b8a6' },
]

// diff 字符串（箭头+绝对值）
function diffStr(c, p) {
  if (p === undefined) return '-'
  return (c >= p ? '↑' : '↓') + dFmt(c, p)
}

// --- KPI 汇总计算 ---
// ⚠️ 「这天没采到这项指标」和「真的是 0」必须能分开（2026-10-19 用户反馈"看不懂"）：
// 旧实现 today 从 0 开始累加，没数据的指标也显示 0 —— 总粉丝明明是"没采到"，却显示成 0 粉。
// 现在没有任何一个平台有这项指标时返回 null，界面显示「—」。
const kpiList = computed(() => {
  if (!data.value?.accounts) return []
  const accs = data.value.accounts
  return kpiDefs.map(def => {
    let today = 0, yesterday = 0, hasYst = false, seen = false
    for (const platCards of Object.values(accs)) {
      for (const pd of Object.values(platCards)) {
        if (pd.stats[def.key] !== undefined) { today += pd.stats[def.key]; seen = true }
        if (pd.yesterday[def.key] !== undefined) { yesterday += pd.yesterday[def.key]; hasYst = true }
      }
    }
    return { ...def, today: seen ? today : null, yesterday: hasYst ? yesterday : null, showDiff: hasYst && seen }
  })
})

// 只保留"这天真有数"的 KPI（null = 没采到，不占位）
const kpiVisible = computed(() => kpiList.value.filter((k) => k.today !== null))
// KPI 数值显示：null（没这项数据）显示 —，不冒充 0
function kpiText(v) { return v === null || v === undefined ? '—' : fmt(v) }

// --- 账号相关 ---
// 这天有数据的账号 + 配置里的全部账号（并集、按名字排序）：
// 只有把"没采到的号"也列出来，用户才知道 10 个号里谁有数据、谁没有
const accountNames = computed(() => {
  if (!data.value) return []
  const set = new Set(Object.keys(data.value.accounts || {}))
  for (const a of (data.value.configAccounts || [])) {
    if (a && a.name) set.add(a.name)
  }
  return [...set].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN', { numeric: true }))
})

function emptyReason(acc) {
  const e = data.value?.collect || data.value?.collectToday
  if (!e) return '这天没有这个账号的采集记录（可能那天没跑采集）。'
  if (e.insufficient) return '这天这个账号没采到数据：TikTok 分析页只返回「--」占位（还没有可统计的播放/粉丝）。'
  return `这天这个账号没采到数据（${e.reason || '未解析到指标'}）。`
}

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
// 表格里固定这几列（横着看比竖着一排 progress bar 好读得多）
const tableMetrics = computed(() => {
  const prefer = ['followers', 'following', 'total_likes', 'views', 'likes', 'comments']
  const present = new Set()
  for (const platforms of Object.values(data.value?.accounts || {})) {
    for (const pd of Object.values(platforms)) {
      for (const m of Object.keys(pd.stats || {})) present.add(m)
    }
  }
  const cols = prefer.filter((m) => present.has(m))
  // 出了新指标也别丢：排在固定列后面
  for (const m of metricsOrder) if (present.has(m) && !cols.includes(m)) cols.push(m)
  return cols.length ? cols : prefer
})

// 表格数据：账号 × 平台 一行；这天没采到数据的号也要出一行（否则用户以为"只能看一个号"）
const acRows = computed(() => {
  const rows = []
  for (const acc of accountNames.value) {
    const platforms = data.value?.accounts?.[acc] || {}
    const names = Object.keys(platforms)
    if (!names.length) {
      rows.push({ accName: acc, platform: 'tiktok', pd: null })
    } else {
      for (const platform of names) rows.push({ accName: acc, platform, pd: platforms[platform] })
    }
  }
  return rows
})

function dCls(c, p) { return c >= p ? 'up' : 'dn' }

// --- 采集状态提示 ---
// 为什么要这段：2026-10-19 那轮采集 10 个号全部只拿到「--」，界面却仍显示上一版数据 +
// 今天的时间戳，看起来像"今天的数据"。现在把"这天到底采到没有"直接写在页面上。
const collectWarn = computed(() => {
  const d = data.value
  if (!d) return null
  const day = d.date || ''
  const c = d.collect
  const today = d.collectToday
  const isLatest = (d.availableDates || []).length ? d.availableDates[0] === day : true

  // ① 这一天的采集自己有记录：直说
  if (c) {
    if (!c.ok) {
      const none = !c.total ? '没有可采集的账号' : `${c.collected}/${c.total} 个账号有数据`
      return {
        tone: 'bad',
        title: `${day} 采集没拿到数据（${none}）`,
        hint: c.insufficient
          ? 'TikTok 分析页只返回「--」占位：这些账号还没有可统计的播放/粉丝数据，不是采集器坏了。下方展示的是这天已有的记录。'
          : `原因：${c.reason || '未解析到指标'}。下方展示的是这天已有的记录。`,
      }
    }
    if (c.total && c.collected < c.total) {
      return {
        tone: 'info',
        title: `${day} 采集完成 ${c.collected}/${c.total} 个账号${c.at ? `（${c.at}）` : ''}`,
        hint: `没采到的：${c.reason || '部分账号无数据'}`,
      }
    }
    // 全部入库了，但只有主页数字（分析页仍是「--」）也要说，否则用户以为播放/点赞真的是 0
    if (c.insufficient > 0) {
      return {
        tone: 'info',
        title: `${day} 采集完成 ${c.collected}/${c.total} 个账号${c.at ? `（${c.at}）` : ''}`,
        hint: `其中 ${c.insufficient} 个号只拿到主页的粉丝/关注/获赞；播放、点赞、评论 TikTok 仍返回「--」（这些号还没有播放数据）。`,
      }
    }
    return null
  }

  // ② 看的是历史日期（这页没有当天采集记录），但今天那轮采集失败了：这最容易被误读成"今天的数据"
  if (today && !today.ok && isLatest) {
    return {
      tone: 'bad',
      title: `今天（${d.today || '今天'}）${today.at ? today.at.slice(-8) : ''} 的采集没拿到数据：${today.collected}/${today.total} 个账号有数据`,
      hint: `所以这一页显示的是 ${day}（最近一次有数据的一天）的记录。${today.insufficient ? 'TikTok 分析页只返回「--」占位，这些账号还没有可统计的数据。' : `原因：${today.reason || '未解析到指标'}。`}`,
    }
  }
  return null
})

// --- 趋势 ---
const trendData = ref(null)
const activeTrend = ref('')
const trendDays = ref(7)
const chartW = 600, chartH = 200, padL = 40, padR = 20, padT = 30, padB = 30

const trendKeys = computed(() => trendData.value ? Object.keys(trendData.value) : [])

function metricLabel(m) { return metricLabels[m] || m }

/**
 * 图例只列「当前这份日报里的账号」的指标，并且必须带账号名前缀。
 * 旧的图例文字是 `平台·指标`（如 `tiktok·播放`），8 个号 × 多个指标会渲染出一排
 * 长得一模一样的 chip，用户根本分不清点的是哪个号（2026-10-19 用户反馈"看不懂"）。
 */
const trendOptions = computed(() => {
  const t = trendData.value
  if (!t) return []
  const accs = new Set(Object.keys(data.value?.accounts || {}))
  return Object.keys(t)
    .map((key) => {
      const s = t[key]
      return { key, account: s.account, platform: s.platform, metric: s.metric }
    })
    .filter((o) => !accs.size || accs.has(o.account))
    .map((o) => ({ ...o, label: `${o.account} · ${metricLabel(o.metric)}` }))
    .sort((a, b) => a.account.localeCompare(b.account) || a.metric.localeCompare(b.metric))
})

// 横轴范围（真实日历天，取自接口返回的 dates）
const trendRange = computed(() => {
  const s = trendData.value?.[activeTrend.value]
  if (!s || !s.dates?.length) return ''
  const a = s.dates[0], b = s.dates[s.dates.length - 1]
  return a === b ? a : `${a} ~ ${b}`
})

// 最近一个"有数字"的日期（横轴右端是今天，今天没数据时要说明白）
const trendLatest = computed(() => {
  const s = trendData.value?.[activeTrend.value]
  if (!s) return ''
  for (let i = s.values.length - 1; i >= 0; i--) {
    if (s.values[i] !== null) return s.dates[i]
  }
  return ''
})

function trendXY(s) {
  const vals = s.values
  const defined = vals.filter((v) => v !== null)
  const max = Math.max(...defined, 1)
  const min = Math.min(...defined, 0)
  const range = max - min || 1
  const stepX = (chartW - padL - padR) / Math.max(vals.length - 1, 1)
  return (v, i) => ({
    x: padL + i * stepX,
    y: padT + (chartH - padT - padB) * (1 - (v - min) / range),
  })
}

/**
 * 折线要按「连续有数据的天」分段：旧实现把 null 过滤掉再连成一条线，
 * 于是 2026-07-22 和 2026-10-18（中间隔了 3 个月）被连成一条水平线，
 * 看着像"这 7 天都是 0"（用户实际就是这么误解的）。
 */
const trendSegments = computed(() => {
  const s = trendData.value?.[activeTrend.value]
  if (!s) return []
  const xy = trendXY(s)
  const segs = []
  let cur = []
  s.values.forEach((v, i) => {
    if (v === null) {
      if (cur.length > 1) segs.push(cur.join(' '))
      cur = []
      return
    }
    const p = xy(v, i)
    cur.push(`${p.x},${p.y}`)
  })
  if (cur.length > 1) segs.push(cur.join(' '))
  return segs
})

const trendPointCoords = computed(() => {
  const s = trendData.value?.[activeTrend.value]
  if (!s) return []
  const xy = trendXY(s)
  return s.values.map((v, i) => {
    if (v === null) return null
    const p = xy(v, i)
    return { x: p.x, y: p.y, label: s.dates[i], value: v }
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
    // 默认选中「当前日报里第一个账号的第一项」，不是 blindly 取第一个 key
    if (trendOptions.value.length) activeTrend.value = trendOptions.value[0].key
  } catch (_) {}
}

// --- 日报缓存 ---
const reportCache = new Map()

// --- 发布侧结果（2026-10-19 P0-3）---
// 数据型日报在账号没数据时全是「—」，但"今天发了 N 条、失败 M 条"永远是实话。
const publishDay = ref(null)
async function loadPublishDay(date) {
  try {
    publishDay.value = await window.xnowpost.getPublishDay(date || '')
  } catch (_) {
    publishDay.value = null
  }
}

// 最近一次生成的花费（cost:latest）。只取一次，切日期不重取 —— 它不随日期变。
const lastCost = ref('')
let costLoaded = false
async function loadCostOnce() {
  if (costLoaded) return
  costLoaded = true
  try {
    const c = await window.xnowpost.getLatestCost()
    const total = Number(c?.total ?? c?.cost?.total ?? NaN)
    lastCost.value = Number.isFinite(total) && total > 0 ? total.toFixed(2) : ''
  } catch (_) { lastCost.value = '' }
}
async function load(date, force = false) {
  loading.value = true
  try {
    const cacheKey = date || '__latest'
    // force = 用户点了「刷新」：必须先清掉缓存，否则会直接命中旧数据返回（P2-7 空操作）
    if (force) {
      reportCache.delete(cacheKey)
      reportCache.delete('__latest')
      if (date) reportCache.delete(date)
    }
    loadPublishDay(date)
    loadCostOnce()
    if (!force && reportCache.has(cacheKey)) {
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
// 刷新：强制绕过缓存重新拉取当前日期
function handleRefresh() { if (data.value) load(data.value.date, true) }
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

// 初始化：日报 + 趋势（趋势原先定义了 loadTrend 却从未调用，图表永远不显示）
onMounted(() => {
  load()
  loadTrend(trendDays.value)
})
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
.page-header h2 {
  margin: 0; font-size: 22px; font-weight: 800; letter-spacing: 1px;
  background: var(--brand-grad); -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
}
.date-nav {
  display: flex; align-items: center; gap: 8px;
  background: rgba(19, 29, 43, 0.86); border-radius: 8px; padding: 5px 10px; border: 1px solid rgba(139, 92, 246, 0.3);
}
/* ── 账号明细表（替换原来的每号一卡 + 每指标一根进度条） ── */
.ac-table-wrap {
  background: var(--bg1); border: 1px solid var(--stroke);
  border-radius: var(--r-md); padding: 4px 12px 10px; overflow-x: auto;
}
.ac-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.ac-table th {
  text-align: left; font-weight: 600; color: var(--text-3); font-size: 11.5px;
  padding: 9px 8px; border-bottom: 1px solid var(--stroke); white-space: nowrap;
}
.ac-table th.num { text-align: right; }
.ac-table td { padding: 8px; border-bottom: 1px solid var(--stroke); color: var(--text); }
.ac-table tr:last-child td { border-bottom: 0; }
.ac-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.ac-table td.ac-name { font-family: var(--font-mono); font-weight: 600; }
.ac-table .ac-username { color: var(--text-2); font-size: 12px; cursor: pointer; }
.ac-table .ac-username:hover { color: var(--brand); }
.ac-table .muted { color: var(--text-3); }
.ac-table .v { font-weight: 600; }
.ac-table .d { margin-left: 5px; font-size: 11px; }
.pl-chip {
  display: inline-block; padding: 2px 8px; border-radius: 999px;
  background: var(--bg2); border: 1px solid var(--stroke);
  color: var(--text-2); font-size: 11.5px; white-space: nowrap;
}
.date-btn {
  background: none; border: none; color: var(--text-2); cursor: pointer;
  font-size: 13px; padding: 3px 5px; border-radius: 4px; transition: all .15s;
}
.date-btn.text {
  border: 1px solid var(--stroke); padding: 3px 9px; font-size: 12px;
  color: var(--text-2); background: var(--bg1);
}
.date-btn:hover:not(:disabled) { color: var(--brand); background: var(--bg2); }
.date-btn:disabled { opacity: .3; cursor: not-allowed; }
.date-cost {
  font-size: 11px; color: var(--text-2); background: var(--bg2);
  border: 1px solid var(--stroke);
  padding: 2px 8px; border-radius: 4px; white-space: nowrap;
}.date-label { font-size: 13px; font-weight: 600; color: #e2e8f0; min-width: 90px; text-align: center; }
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

/* ---- 采集状态提示条 ---- */
.collect-warn {
  display: flex; align-items: flex-start; gap: 10px;
  margin-bottom: 16px; padding: 12px 14px;
  border-radius: 12px; border: 1px solid;
  font-size: 13px; line-height: 1.55;
}
.collect-warn.bad  { background: rgba(245, 158, 11, .10); border-color: rgba(245, 158, 11, .38); }
.collect-warn.info { background: rgba(56, 189, 248, .10); border-color: rgba(56, 189, 248, .32); }
.cw-icon { font-size: 15px; line-height: 1.3; }
.cw-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.collect-warn.bad  .cw-title { color: #fbbf24; font-weight: 600; }
.collect-warn.info .cw-title { color: #7dd3fc; font-weight: 600; }
.cw-hint { color: #94a3b8; font-size: 12px; }

/* ---- KPI 说明（「—」= 没采到，不是 0）---- */
.kpi-note { margin: -4px 0 14px; color: #64748b; font-size: 12px; }
.kpi-val.is-empty { color: #475569; }

/* ---- 没采到数据的账号卡片 ---- */
.ac-meta-empty { color: #f59e0b !important; }
.pl-empty {
  margin: 8px 0 0 34px; padding: 12px 14px;
  border: 1px dashed #334155; border-radius: 10px;
  color: #64748b; font-size: 12px; line-height: 1.5;
}

/* ---- 趋势说明 ---- */
.trend-note { margin: -6px 0 10px; color: #64748b; font-size: 12px; line-height: 1.5; }

/* ===== KPI 汇总行 ===== */
/* 用 flex 固定卡宽：只剩 1 张时不会被拉成"一张大卡占满整行" */
.kpi-row {
  display: flex; flex-wrap: wrap;
  gap: 12px; margin-bottom: 20px;
}
.kpi-card { flex: 0 0 210px; }
.kpi-card {
  display: flex; align-items: center; gap: 12px;
  /* 渐变描边 + 半透明深底：和外面那些 .x-card 是一套观感 */
  background:
    linear-gradient(rgba(19, 29, 43, 0.86), rgba(19, 29, 43, 0.86)) padding-box,
    linear-gradient(135deg, rgba(168, 85, 247, 0.6), rgba(59, 130, 246, 0.45) 50%, rgba(20, 184, 166, 0.55)) border-box;
  border: 1px solid transparent; border-radius: 12px;
  padding: 14px 16px;
  position: relative; overflow: hidden;
  transition: box-shadow .2s, transform .15s;
}
.kpi-card:hover {
  box-shadow: 0 8px 24px var(--brand-glow);
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
.kpi-val {
  font-size: 20px; font-weight: 800; line-height: 1.2; margin: 2px 0;
  background: var(--brand-grad); -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
}
.kpi-diff { font-size: 11px; font-weight: 700; }
.kpi-diff.up { color: #22c55e; }
.kpi-diff.dn { color: #ef4444; }

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

/* ── 「这天发了什么」卡片（只读 theme.css 的变量，不写死色值）── */
.pub-day .x-card-head h2 { font-size: 14px; }
.pub-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.pub-list li { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-1); }
.pub-list.is-bad li { color: var(--text-2); }
.pub-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 52%; }
.pub-reason { color: var(--text-3); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pub-day .x-tip { margin: 10px 0 0; }
</style>
