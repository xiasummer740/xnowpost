<template>
  <div class="report-page">
    <div class="page-header">
      <h2>📊 数据日报</h2>
      <!-- 日期导航 -->
      <div class="date-nav" v-if="data">
        <button class="date-btn" @click="prevDate" :disabled="curIdx <= 0">◀</button>
        <span class="date-label">{{ data.date }}</span>
        <button class="date-btn" @click="nextDate" :disabled="curIdx >= data.availableDates.length - 1">▶</button>
      </div>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="loading-box">
      <span class="loading-spinner"></span>
      <span>加载中...</span>
    </div>

    <!-- 空状态 -->
    <div v-else-if="!data" class="empty-box">
      <span class="empty-icon">📭</span>
      <span>暂无日报数据</span>
      <span class="empty-hint">设置「采集+日报」闹钟后，到点自动采集并生成日报</span>
    </div>

    <!-- 日报内容 -->
    <template v-else>
      <!-- 账号 Tab -->
      <div class="account-tabs" v-if="accountNames.length > 1">
        <button
          v-for="name in accountNames"
          :key="name"
          class="account-tab"
          :class="{ active: activeAccount === name }"
          @click="activeAccount = name"
        >
          {{ name === 'default' ? '默认' : name }}
        </button>
      </div>

      <!-- 选中的账号 -->
      <template v-for="accName in accountNames" :key="accName">
        <div v-if="activeAccount === accName" class="account-section">
          <div class="account-title" v-if="accountNames.length > 1">
            👤 {{ accName === 'default' ? '默认账号' : accName }}
          </div>

          <!-- 日报摘要 -->
          <div class="report-summary">
            <div class="summary-line" v-for="(line, i) in summaryLines(accName)" :key="i">{{ line }}</div>
          </div>

          <!-- 平台数据卡片 -->
          <div class="platform-grid">
            <div v-for="(pd, platform) in data.accounts[accName]" :key="platform" class="platform-card">
              <div class="pc-header">
                <span class="pc-emoji">{{ platformEmoji[platform] || '📡' }}</span>
                <span class="pc-name">{{ platformNames[platform] || platform }}</span>
              </div>
              <table class="pc-table">
                <thead>
                  <tr>
                    <th>指标</th>
                    <th class="num">本日</th>
                    <th class="num">昨日</th>
                    <th class="num">对比</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="metric in metricsOrder" :key="metric" v-if="pd.stats[metric] !== undefined">
                    <td class="metric-label">{{ metricLabels[metric] || metric }}</td>
                    <td class="num">{{ formatNum(pd.stats[metric]) }}</td>
                    <td class="num yesterday-val">{{ pd.yesterday[metric] !== undefined ? formatNum(pd.yesterday[metric]) : '-' }}</td>
                    <td class="num diff">
                      <span v-if="pd.yesterday[metric] !== undefined" :class="diffClass(pd.stats[metric], pd.yesterday[metric])">
                        {{ diffArrow(pd.stats[metric], pd.yesterday[metric]) }}{{ formatDiff(pd.stats[metric], pd.yesterday[metric]) }}
                      </span>
                      <span v-else class="diff-na">-</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

const loading = ref(true)
const data = ref(null)
const curIdx = ref(0)
const activeAccount = ref('default')

const platformEmoji = {
  tiktok: '🎵', xiaohongshu: '📕', facebook: '📘',
  instagram: '📸', youtube: '▶️', x: '𝕏',
}
const platformNames = {
  tiktok: 'TikTok', xiaohongshu: '小红书', facebook: 'Facebook',
  instagram: 'Instagram', youtube: 'YouTube', x: 'X (Twitter)',
}
const metricLabels = {
  followers: '粉丝', views: '播放', likes: '点赞',
  comments: '评论', shares: '转发', reach: '触达', engagement: '互动率',
  profile_views: '主页访问',
}
const metricsOrder = ['followers', 'views', 'profile_views', 'likes', 'comments', 'shares', 'reach', 'engagement']

// 账号列表
const accountNames = computed(() => {
  if (!data.value?.accounts) return []
  return Object.keys(data.value.accounts)
})

function formatNum(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + '万'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

function diffArrow(curr, prev) {
  return curr >= prev ? '↑' : '↓'
}

function diffClass(curr, prev) {
  return curr >= prev ? 'diff-up' : 'diff-down'
}

function formatDiff(curr, prev) {
  const diff = Math.abs(curr - prev)
  if (diff >= 10000) return (diff / 10000).toFixed(1) + '万'
  if (diff >= 1000) return (diff / 1000).toFixed(1) + 'K'
  return String(diff)
}

function summaryLines(account) {
  if (!data.value?.accounts?.[account]) return []
  const platforms = data.value.accounts[account]
  const lines = [
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📊 XNOW 数据日报 · ${data.value.date}${account !== 'default' ? ` · ${account}` : ''}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
  ]
  for (const [platform, pd] of Object.entries(platforms)) {
    const emoji = platformEmoji[platform] || '📡'
    const name = platformNames[platform] || platform
    const parts = [`${emoji} ${name}`]
    for (const metric of metricsOrder) {
      if (pd.stats[metric] === undefined) continue
      const label = metricLabels[metric] || metric
      const val = formatNum(pd.stats[metric])
      if (pd.yesterday[metric] !== undefined) {
        const arrow = diffArrow(pd.stats[metric], pd.yesterday[metric])
        const diff = formatDiff(pd.stats[metric], pd.yesterday[metric])
        parts.push(`${label} ${val} ${arrow}${diff}`)
      } else {
        parts.push(`${label} ${val}`)
      }
    }
    lines.push(parts.join(' | '))
  }
  lines.push('')
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━`)
  return lines
}

async function load(date) {
  loading.value = true
  try {
    const result = await window.xnowpost.getDailyReport(date)
    data.value = result
    if (result) {
      curIdx.value = result.availableDates.indexOf(result.date)
      if (curIdx.value < 0) curIdx.value = 0
      // 默认选中第一个非 default 账号
      const names = Object.keys(result.accounts || {})
      activeAccount.value = names.includes('default') ? 'default' : (names[0] || 'default')
    }
  } catch (err) {
    console.error('加载日报失败:', err)
    data.value = null
  } finally {
    loading.value = false
  }
}

function prevDate() {
  if (!data.value || curIdx.value <= 0) return
  load(data.value.availableDates[curIdx.value - 1])
}

function nextDate() {
  if (!data.value || curIdx.value >= data.value.availableDates.length - 1) return
  load(data.value.availableDates[curIdx.value + 1])
}

onMounted(() => load())
</script>

<style scoped>
.report-page {
  max-width: 800px;
  margin: 0 auto;
}
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  flex-wrap: wrap;
  gap: 12px;
}
.page-header h2 { margin: 0; }

/* 日期导航 */
.date-nav {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #1e293b;
  border-radius: 8px;
  padding: 6px 12px;
  border: 1px solid #334155;
}
.date-btn {
  background: none; border: none; color: #94a3b8; cursor: pointer;
  font-size: 14px; padding: 4px 6px; border-radius: 4px; transition: all 0.15s;
}
.date-btn:hover:not(:disabled) { color: #f59e0b; background: #33415544; }
.date-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.date-label { font-size: 14px; font-weight: 600; color: #e2e8f0; min-width: 100px; text-align: center; }

/* 账号 Tabs */
.account-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  background: #1e293b;
  border-radius: 8px;
  padding: 4px;
  border: 1px solid #334155;
}
.account-tab {
  flex: 1;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #94a3b8;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}
.account-tab:hover { color: #e2e8f0; background: #33415566; }
.account-tab.active { color: #0f172a; background: #f59e0b; }

.account-title {
  font-size: 15px;
  font-weight: 700;
  color: #60a5fa;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid #334155;
}

/* 加载 */
.loading-box {
  display: flex; align-items: center; justify-content: center;
  gap: 10px; padding: 60px 0; color: #64748b;
}
.loading-spinner {
  width: 20px; height: 20px;
  border: 2px solid #334155;
  border-top-color: #f59e0b;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* 空状态 */
.empty-box {
  display: flex; flex-direction: column; align-items: center;
  gap: 10px; padding: 60px 0; color: #64748b; font-size: 14px;
}
.empty-icon { font-size: 40px; }
.empty-hint { font-size: 12px; color: #475569; }

/* 日报摘要 */
.report-summary {
  background: #1e293b; border: 1px solid #334155; border-radius: 10px;
  padding: 16px 20px; margin-bottom: 20px;
  font-family: monospace; font-size: 12px; line-height: 1.7;
  color: #94a3b8; white-space: pre-wrap; word-break: break-all;
}

/* 平台网格 */
.platform-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}

/* 平台卡片 */
.platform-card {
  background: #1e293b; border: 1px solid #334155; border-radius: 10px;
  padding: 16px; transition: border-color 0.2s;
}
.platform-card:hover { border-color: #475569; }
.pc-header {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid #334155;
}
.pc-emoji { font-size: 20px; line-height: 1; }
.pc-name { font-size: 15px; font-weight: 700; color: #e2e8f0; }

/* 数据表格 */
.pc-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.pc-table th { color: #64748b; font-weight: 600; text-align: left; padding: 4px 6px; border-bottom: 1px solid #1e293b; }
.pc-table th.num, .pc-table td.num { text-align: right; }
.pc-table td { padding: 5px 6px; color: #94a3b8; border-bottom: 1px solid #0f172a; }
.pc-table tr:last-child td { border-bottom: none; }
.metric-label { color: #cbd5e1; font-weight: 500; }
.yesterday-val { color: #64748b; }
.diff { font-weight: 600; min-width: 50px; }
.diff-up { color: #22c55e; }
.diff-down { color: #ef4444; }
.diff-na { color: #475569; }
</style>
