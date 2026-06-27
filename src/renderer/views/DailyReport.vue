<template>
  <div class="report-page">
    <div class="page-header">
      <h2>📊 数据日报</h2>
      <div class="date-nav" v-if="data">
        <button class="date-btn" @click="prevDate" :disabled="curIdx <= 0">◀</button>
        <span class="date-label">{{ data.date }}</span>
        <button class="date-btn" @click="nextDate" :disabled="curIdx >= data.availableDates.length - 1">▶</button>
        <span class="nav-divider"></span>
        <button class="date-btn" @click="handleRefresh" title="刷新">🔄</button>
        <button class="date-btn" @click="handlePush" :disabled="pushing" title="推送到 Telegram">{{ pushing ? '⏳' : '📤' }}</button>
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
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

const loading = ref(true)
const data = ref(null)
const curIdx = ref(0)
const pushing = ref(false)

const platformEmoji = { tiktok:'🎵', xiaohongshu:'📕', facebook:'📘', instagram:'📸', youtube:'▶️', x:'𝕏' }
const platformNames = { tiktok:'TikTok', xiaohongshu:'小红书', facebook:'Facebook', instagram:'Instagram', youtube:'YouTube', x:'X (Twitter)' }
const metricLabels = { followers:'粉丝', views:'播放', likes:'点赞', comments:'评论', shares:'转发', saves:'收藏', reach:'触达', engagement:'互动率', profile_views:'主页访问', following:'关注', new_followers:'新增粉丝' }
const metricsOrder = ['followers','new_followers','following','views','profile_views','likes','comments','shares','saves','reach','engagement']

const accountNames = computed(() => data.value?.accounts ? Object.keys(data.value.accounts) : [])

function accountMeta(acc) {
  return data.value?.accountMeta?.[acc] || null
}
function displayName(acc) {
  const meta = accountMeta(acc)
  return meta?.username || (acc === 'default' ? '默认' : acc)
}
function openProfile(acc) {
  const meta = accountMeta(acc)
  if (meta?.profileUrl) window.xnowpost.openExternal(meta.profileUrl)
}

function summaryFor(acc) {
  const platforms = data.value?.accounts?.[acc]
  if (!platforms) return []
  const lines = [
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📊 XNOW 数据日报 · ${data.value.date}${acc !== 'default' ? ` · ${acc}` : ''}`,
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

function fmt(n) {
  if (n >= 10000) return (n/10000).toFixed(1)+'万'
  if (n >= 1000) return (n/1000).toFixed(1)+'K'
  return String(n)
}
function dArr(c,p) { return c>=p ? '↑' : '↓' }
function dCls(c,p) { return c>=p ? 'up' : 'dn' }
function dFmt(c,p) {
  const d = Math.abs(c-p)
  if (d >= 10000) return (d/10000).toFixed(1)+'万'
  if (d >= 1000) return (d/1000).toFixed(1)+'K'
  return String(d)
}

async function load(date) {
  loading.value = true
  try {
    const r = await window.xnowpost.getDailyReport(date)
    data.value = r
    if (r) {
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
.report-summary{background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:12px 16px;margin-bottom:12px;font-family:monospace;font-size:12px;line-height:1.7;color:#94a3b8;white-space:pre-wrap;word-break:break-all}
.sl-divider{color:#334155}

/* 平台卡片 - 简洁 */
.pcard{background:#1e293b;border-radius:10px;padding:12px 14px;margin-bottom:6px;border:1px solid transparent;transition:border-color .2s}
.pcard:hover{border-color:#334155}
.pc-hd{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.pc-em{font-size:15px}
.pc-nm{font-size:13px;font-weight:700;color:#e2e8f0}

/* 数据表 */
.tbl{width:100%;border-collapse:collapse;font-size:12px}
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
</style>
