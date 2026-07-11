<template>
  <div class="dashboard">
    <h2>🏠 控制台</h2>

    <div class="status-bar">
      <span>{{ statusText }}</span>
      <div class="status-badges">
        <span v-if="store.status.running" class="badge badge-engine">⏳ 引擎运行中</span>
        <span v-else-if="store.status.schedulerActive" class="badge badge-scheduler">⏰ 调度器执行中</span>
        <span v-else class="badge badge-idle">⚪ 空闲</span>
        <span v-if="store.status.schedulerLastRun" class="badge badge-lastrun">🕐 {{ store.status.schedulerLastRun }}</span>
      </div>
    </div>

    <!-- 未配置引导 -->
    <div v-if="!store.status.configured" class="welcome-banner">
      <h3>👋 欢迎使用 XNOWPost！</h3>
      <p>需要先配置 API Key 才能开始生成内容：</p>
      <ol>
        <li><strong>DeepSeek</strong> — AI 生成文案（注册送额度）</li>
        <li><strong>硅基流动</strong> — AI 生成图片（注册送 14 元）</li>
        <li><strong>Telegram Bot</strong> — 可选，推送到频道</li>
      </ol>
      <p class="welcome-hint">👉 <router-link to="/config" class="welcome-link">去配置页填写</router-link></p>
    </div>

    <!-- 快捷生成（仅空闲时显示，引擎/调度器运行时隐藏） -->
    <div v-if="store.status.configured && !store.status.running && !store.status.schedulerActive" class="quick-bar">
      <div class="qb-main">
        <input v-model="quickTopic" placeholder="输入主题（留空让 AI 自由发挥）..."
               class="quick-input" @keyup.enter="quickGenerate" :disabled="batchMode" />
        <button class="btn btn-primary quick-btn" @click="quickGenerate" :disabled="batchMode">
          ⚡ 生成
        </button>
      </div>
      <div class="qb-mode">
        <span class="qb-toggle" :class="{ on: batchMode }" @click="batchMode = !batchMode">
          📋 批量
        </span>
      </div>
    </div>

    <!-- 批量生成面板 -->
    <div v-if="batchMode && !store.status.running" class="batch-panel">
      <div class="bp-hint">每行一个主题，按顺序依次生成</div>
      <textarea v-model="batchTopics" class="bp-textarea" rows="4" placeholder="AI 视频创作技巧&#10;今日科技新闻&#10;产品使用教程"></textarea>
      <div class="bp-actions">
        <button class="btn btn-primary btn-sm" @click="runBatch" :disabled="!batchTopics.trim()">🚀 批量生成 ({{ topicCount }})</button>
        <button class="btn btn-secondary btn-sm" @click="batchMode = false">取消</button>
      </div>
    </div>

    <!-- 进度面板（引擎运行时显示） -->
    <div v-if="store.status.running" class="progress-panel">
      <div class="progress-header">
        <span>{{ batchTotal > 0 ? `📋 批量生成 ${batchDone}/${batchTotal}` : '⏳ 正在生成...' }}</span>
        <button class="btn btn-cancel" @click="handleCancel" :disabled="cancelling">
          {{ cancelling ? '取消中...' : '✕ 取消' }}
        </button>
      </div>
      <div class="progress-step-label">{{ currentStep.label }}</div>
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: currentStep.percent + '%' }"></div>
      </div>
      <div class="progress-log">
        <div v-for="(log, i) in recentLogs" :key="i" class="progress-line" :class="log.type">
          <span class="progress-line-time">{{ log.time.slice(-8) }}</span>
          <span class="progress-line-msg">{{ log.message }}</span>
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-primary" @click="runAuto" :disabled="store.status.running || !store.status.configured">
        🚀 立即生成（{{ isMorning ? '1视频+1图文' : '1视频' }}）
      </button>
      <button class="btn btn-secondary" @click="runVideo" :disabled="store.status.running || !store.status.configured">
        🎬 仅视频
      </button>
      <button class="btn btn-secondary" @click="runPost" :disabled="store.status.running || !store.status.configured">
        🟢 仅图文
      </button>
      <button class="btn btn-collect" @click="handleCollect" :disabled="collecting">
        {{ collecting ? '⏳ 采集中...' : '📊 采集' }}
      </button>
      <button class="btn btn-publish" @click="handlePublish" :disabled="publishing">
        {{ publishing ? '⏳ 发布中...' : '📤 发布' }}
      </button>
    </div>

    <!-- 完成通知横幅 -->
    <div v-if="showCompletionBanner" class="completion-banner">
      <span class="cb-icon">✅</span>
      <span class="cb-text">内容已生成完成！</span>
      <button class="btn btn-publish btn-sm" @click="handlePublish" :disabled="publishing">
        {{ publishing ? '⏳ 发布中...' : '📤 立即发布' }}
      </button>
      <button class="cb-close" @click="showCompletionBanner = false">✕</button>
    </div>

    <!-- 内容预览 -->
    <div v-if="previewData" class="preview-card">
      <div class="pc-hd">
        <span>📄 最新生成内容</span>
        <button class="cb-close" @click="previewData = null">✕</button>
      </div>
      <div v-if="previewData.text" class="preview-text">{{ previewData.text.slice(0, 300) }}{{ previewData.text.length > 300 ? '...' : '' }}</div>
      <div v-if="previewData.images?.length" class="preview-imgs">
        <img v-for="(img, ii) in previewData.images.slice(0, 3)" :key="ii" :src="img.data" class="preview-img" />
      </div>
    </div>

    <!-- 系统状态卡 -->
    <div class="health-card">
      <div class="hc-title">🖥️ 系统状态</div>
      <div class="hc-grid">
        <div class="hc-item">
          <span class="hc-dot" :class="store.status.running ? 'hc-on' : 'hc-off'"></span>
          <span class="hc-label">引擎</span>
          <span class="hc-val">{{ store.status.running ? '运行中' : '空闲' }}</span>
        </div>
        <div class="hc-item">
          <span class="hc-dot" :class="store.status.schedulerRunning ? 'hc-on' : 'hc-off'"></span>
          <span class="hc-label">调度器</span>
          <span class="hc-val">{{ store.status.schedulerRunning ? '运行中' : '已停止' }}</span>
        </div>
        <div class="hc-item">
          <span class="hc-dot" :class="store.status.recentErrors > 0 ? 'hc-err' : 'hc-on'"></span>
          <span class="hc-label">错误</span>
          <span class="hc-val">{{ store.status.recentErrors || 0 }} 条</span>
        </div>
        <div class="hc-item">
          <span class="hc-dot" :class="store.status.configured ? 'hc-on' : 'hc-off'"></span>
          <span class="hc-label">配置</span>
          <span class="hc-val">{{ store.status.configured ? '已配置' : '未配置' }}</span>
        </div>
      </div>
    </div>

    <!-- 引擎连续失败警告 -->
    <div v-if="consecutiveFailures >= 2" class="fail-warning">
      <span>⚠️ 引擎已连续 {{ consecutiveFailures }} 次执行失败</span>
      <button class="btn btn-secondary btn-sm" @click="dismissWarning">知道了</button>
    </div>

    <!-- 待发布卡片 -->
    <div v-if="pendingItems.length > 0" class="publish-card">
      <div class="pc-header">
        <span>📤 待发布内容</span>
        <span class="pc-count">{{ pendingItems.length }} 项</span>
      </div>
      <div v-for="(item, i) in pendingItems" :key="i" class="pc-row">
        <span class="pc-type">{{ item.type === 'video' ? '🎬' : '🟢' }}</span>
        <span class="pc-title">{{ item.title }}</span>
        <span class="pc-date">{{ item.date }} {{ item.time }}</span>
      </div>
      <button class="btn btn-publish btn-sm pc-btn" @click="handlePublish" :disabled="publishing">
        {{ publishing ? '⏳ 发布中...' : '📤 发布全部' }}
      </button>
    </div>

    <!-- 费用概览 -->
    <div v-if="store.latestCost" class="cost-card">
      <span class="cost-label">💰 最近费用</span>
      <div class="cost-items">
        <div class="cost-item">
          <span class="cost-metric">DeepSeek</span>
          <span class="cost-value">¥{{ store.latestCost.deepseek?.toFixed(4) || '0' }}</span>
        </div>
        <div class="cost-item">
          <span class="cost-metric">Kolors</span>
          <span class="cost-value">¥{{ store.latestCost.kolors?.toFixed(2) || '0' }}</span>
        </div>
        <div class="cost-item cost-total">
          <span class="cost-metric">合计</span>
          <span class="cost-value">¥{{ store.latestCost.total?.toFixed(2) || '0' }}</span>
        </div>
      </div>
    </div>

    <!-- 采集数据概览 -->
    <div v-if="collectData" class="collect-card">
      <div class="collect-header">
        <span>📊 数据概览</span>
        <span class="collect-date">{{ collectData.date }}</span>
      </div>
      <div class="collect-grid">
        <div v-for="(stats, platform) in collectData.platforms" :key="platform" class="platform-card">
          <div class="platform-name">{{ platformNames[platform] || platform }}</div>
          <div class="platform-stats">
            <div v-for="(val, key) in stats" :key="key" class="stat-item">
              <span class="stat-label">{{ metricLabels[key] || key }}</span>
              <span class="stat-value">{{ formatNum(val) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 今日产出（缩略图卡片） -->
    <div class="today-preview" v-if="store.status.todayDir">
      <div class="section-header">
        <h3>📅 今日产出 {{ store.status.todayDir }}</h3>
        <button class="btn btn-small" @click="openDir">📂 打开目录</button>
      </div>

      <!-- 骨架屏：加载中 -->
      <div v-if="todayLoading" class="skeleton-list">
        <div v-for="n in 2" :key="n" class="skeleton-card">
          <div class="skeleton-thumb"></div>
          <div class="skeleton-lines">
            <div class="skeleton-line w-60"></div>
            <div class="skeleton-line w-30"></div>
          </div>
        </div>
      </div>

      <div v-else-if="todayItems.length === 0" class="empty-box">
        <span class="empty-icon">📭</span>
        <span>还没有产出，点「立即生成」开始</span>
      </div>

      <div v-else v-for="item in todayItems" :key="item.id" class="item-card">
        <div class="item-thumb">
          <img v-if="item.thumbnail" :src="item.thumbnail" class="thumb-img" />
          <span v-else class="thumb-placeholder">{{ item.type === 'video' ? '🎬' : '🟢' }}</span>
        </div>
        <div class="item-body">
          <div class="item-title">{{ item.title_zh }}</div>
          <div class="item-meta">
            {{ item.type === 'video' ? '🎬 视频' : '🟢 图文' }}
            <span v-if="item.time" class="item-time">· {{ item.time }}</span>
            <span class="item-status">· {{ item.status === 'ready' ? '✅ 完成' : '⏳ 待合成' }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 日志区域（非运行状态折叠） -->
    <div class="logs-section">
      <div class="section-header" @click="logExpanded = !logExpanded" style="cursor:pointer;">
        <h3>📜 最近日志</h3>
        <span class="log-toggle">{{ logExpanded || store.status.running ? '收起' : '展开' }} {{ logExpanded || store.status.running ? '▲' : '▼' }}</span>
      </div>
      <div v-if="logExpanded || store.status.running || store.logs.length > 0" class="log-container" :class="{ collapsed: !logExpanded && !store.status.running }">
        <div v-if="store.logs.length === 0 && !store.status.running" class="empty-log">
          暂无日志，触发「立即生成」后会显示在这里
        </div>
        <template v-else>
          <div v-for="(log, i) in displayLogs" :key="i" class="log-line" :class="log.type">
            <span class="log-time">{{ log.time }}</span>
            <span class="log-msg">{{ log.message }}</span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useAppStore } from '../stores/app.js';
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';

const store = useAppStore();
const todayItems = ref([]);
const todayLoading = ref(true);
const isMorning = new Date().getHours() < 12;
const cancelling = ref(false);
const publishing = ref(false);
const collecting = ref(false);
const quickTopic = ref('');
const batchMode = ref(false);
const batchTopics = ref('');
const batchTotal = ref(0);
const batchDone = ref(0);
const logExpanded = ref(false);
const collectData = ref(null);
const showCompletionBanner = ref(false);
const previewData = ref(null);
const pendingItems = ref([]);
const consecutiveFailures = ref(0);

function dismissWarning() { consecutiveFailures.value = 0; }
let refreshTimer = null;
let cleanupStatusPush = null;
import { PLATFORM_NAMES as platformNames, METRIC_LABELS as metricLabels, formatNum } from '../constants.js';

// 轮询状态跟踪
let prevRunning = false
let tickCount = 0
// metricLabels, formatNum imported from constants.js

const statusText = computed(() => {
  if (!store.status.configured) return '🔑 还需要配置 API Key 才能开始工作';
  if (store.status.running) return '⏳ 引擎运行中...';
  if (store.status.schedulerActive) return '⏰ 调度器执行中';
  return '🟢 一切就绪';
});

const currentStep = ref({ label: '准备中...', percent: 0 });
let cleanupProgress = null;

const recentLogs = computed(() => store.logs.slice(-5));
const displayLogs = computed(() => store.logs.slice(-20).reverse());

// 非运行时自动折叠日志
watch(() => store.status.running, (running, was) => {
  // 引擎刚停下（从 true→false）且最后一条日志是错误 → 展开让用户看见
  if (was && !running) {
    const last = store.logs[store.logs.length - 1];
    if (last && last.type === 'error') {
      logExpanded.value = true;
    } else {
      logExpanded.value = false;
    }
  }
});

async function loadThumbnails(items) {
  for (const item of items) {
    if (item.dir) {
      window.xnowpost.getThumbnail(item.dir).then(url => {
        if (url) item.thumbnail = url;
      }).catch(() => {});
    }
  }
}

async function refreshToday() {
  todayLoading.value = true;
  const history = await window.xnowpost.getHistory();
  const today = history.find(h => h.date === store.status.todayDir);
  todayItems.value = today ? today.items : [];
  todayLoading.value = false;
  if (todayItems.value.length) loadThumbnails(todayItems.value);
}

async function handleCancel() {
  cancelling.value = true;
  try { await store.cancelEngine(); } finally { cancelling.value = false; }
}

function quickGenerate() {
  if (store.status.running) return;
  const topic = quickTopic.value?.trim() || '';
  store.addLog('info', topic ? `📝 主题: ${topic}` : '📝 未指定主题，AI 自由发挥');
  store.addLog('info', '🚀 开始生成...');
  store.runEngine('auto', topic);
}

async function runAuto() { await store.runEngine('auto'); await refreshToday(); }
async function runVideo() { await store.runEngine('video'); await refreshToday(); }
async function runPost() { await store.runEngine('post'); await refreshToday(); }

const topicCount = computed(() => batchTopics.value.trim() ? batchTopics.value.trim().split('\n').filter(Boolean).length : 0)

async function runBatch() {
  const topics = batchTopics.value.trim().split('\n').filter(Boolean)
  if (topics.length === 0) return
  batchTotal.value = topics.length
  batchDone.value = 0
  batchMode.value = false

  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i].trim()
    store.addLog('info', `📋 [${i+1}/${topics.length}] ${topic}`)
    await store.runEngine('auto', topic)
    batchDone.value = i + 1
    await refreshToday()
    // 检查是否被取消
    if (!store.status.running && i < topics.length - 1) break
  }
  batchTotal.value = 0
  batchDone.value = 0
}

async function handleCollect() {
  collecting.value = true
  store.addLog('info', '📊 手动触发数据采集...')
  try {
    const result = await window.xnowpost.runCollect()
    if (!result.ok) {
      store.addLog('error', '采集失败: ' + (result.message || ''))
    } else {
      store.addLog('success', '✅ 采集完成，正在刷新数据...')
      // 采集完成后自动刷新采集卡片
      collectData.value = await window.xnowpost.getLatestCollect()
    }
  } catch (e) {
    store.addLog('error', '采集调用失败: ' + (e.message || e))
  }
  collecting.value = false
}

async function refreshCollectData() {
  try {
    collectData.value = await window.xnowpost.getLatestCollect()
  } catch (_) {}
}

async function handlePublish() {
  publishing.value = true
  try {
    const result = await window.xnowpost.runPublish()
    if (!result.ok) {
      store.addLog('error', '发布失败: ' + (result.message || ''))
    }
  } catch (e) {
    store.addLog('error', '发布调用失败: ' + (e.message || e))
  }
  publishing.value = false
}
async function openDir() { await window.xnowpost.openOutputDir(); }

async function loadPendingItems() {
  try {
    pendingItems.value = await window.xnowpost.getPendingPublish()
  } catch (_) {}
}

async function loadLatestPreview() {
  try {
    const history = await window.xnowpost.getHistory()
    const today = history.find(h => h.date === store.status.todayDir)
    if (today?.items?.length) {
      const latest = today.items[0]
      if (latest.dir) {
        const session = await window.xnowpost.readSession(latest.dir)
        if (session) previewData.value = session
      }
    }
  } catch (_) {}
}

async function refreshStatus() {
  const status = await window.xnowpost.getEngineStatus();
  Object.assign(store.status, status);
}

onMounted(async () => {
  await refreshToday();
  store.loadCost();
  await refreshCollectData();
  loadPendingItems();
  prevRunning = store.status.running;
  refreshTimer = setInterval(async () => {
    if (document.hidden) return;
    tickCount++;

    // light status check each tick
    const status = await window.xnowpost.getEngineStatus().catch(() => null);
    if (!status) return;
    const wasRunning = prevRunning;
    prevRunning = status.running;
    Object.assign(store.status, status);
    // load consecutive failure count
    window.xnowpost.getFailureCount().then(c => { consecutiveFailures.value = c }).catch(() => {})

    // engine just finished -> refresh output + cost + show banner
    if (wasRunning && !status.running) {
      refreshToday();
      store.loadCost();
      showCompletionBanner.value = true;
      loadPendingItems();
      loadLatestPreview();
    }

    // refresh output/collect every 60s (4th tick)
    if (tickCount % 4 === 0) {
      if (!status.running) refreshToday();
      refreshCollectData();
    }
  }, 15000);

  // 监听引擎结构化进度
  cleanupProgress = window.xnowpost.onProgress((p) => {
    currentStep.value = { label: p.label, percent: p.percent };
  });

  // 监听调度器状态即时推送（不依赖 15s 轮询）
  cleanupStatusPush = window.xnowpost.onEngineStatusPush((status) => {
    const wasRunning = prevRunning;
    prevRunning = status.running;
    Object.assign(store.status, status);
    if (wasRunning && !status.running) {
      refreshToday();
      store.loadCost();
      loadPendingItems();
    }
  });
});

onUnmounted(() => {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (cleanupProgress) { cleanupProgress(); cleanupProgress = null; }
  if (cleanupStatusPush) { cleanupStatusPush(); cleanupStatusPush = null; }
});
</script>

<style scoped>
h2 { font-size: 24px; margin-bottom: 20px; }
h3 { font-size: 16px; color: #94a3b8; margin: 0; }
.section-header { display: flex; justify-content: space-between; align-items: center; margin: 20px 0 12px; }
.btn-small { padding: 6px 14px; background: #334155; color: #e2e8f0; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; }
.btn-small:hover { background: #475569; }

.status-bar {
  display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center;
  padding: 12px 16px; background: #1e293b; border-radius: 8px; margin-bottom: 20px; font-size: 14px;
}
.status-badges { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.badge {
  font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 5px;
  white-space: nowrap;
}
.badge-engine { color: #f59e0b; background: #f59e0b15; animation: pulse 1.5s infinite; }
.badge-idle { color: #64748b; background: #33415533; }
.badge-scheduler { color: #60a5fa; background: #2563eb15; animation: pulse 1.5s infinite; }
.badge-lastrun { color: #94a3b8; background: #33415533; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

.actions { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
.btn {
  padding: 12px 24px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600;
  cursor: pointer; transition: all 0.2s;
}
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-primary { background: linear-gradient(135deg, #f59e0b, #d97706); color: #0f172a; }
.btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(245,158,11,0.3); }
.btn-secondary { background: #334155; color: #e2e8f0; }
.btn-secondary:hover:not(:disabled) { background: #475569; }
.btn-publish { background: linear-gradient(135deg, #3b82f6, #2563eb); color: #fff; }
.btn-publish:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(59,130,246,0.3); }
.btn-publish { background: linear-gradient(135deg, #3b82f6, #2563eb); color: #fff; display: inline-flex; align-items: center; gap: 6px; }
.btn-publish:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(59,130,246,0.3); }
.btn-collect { background: linear-gradient(135deg, #10b981, #059669); color: #fff; }
.btn-collect:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(16,185,129,0.3); }

/* 进度面板 */
.progress-panel {
  background: #1e293b; border: 1px solid #f59e0b44; border-radius: 12px;
  padding: 20px; margin-bottom: 20px; animation: fadeIn 0.3s ease;
}
@keyframes fadeIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
.progress-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; font-size: 15px; font-weight: 600; color: #f59e0b; }
.btn-cancel { padding: 6px 16px; background: #ef4444; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.2s; display: flex; align-items: center; gap: 6px; }
.btn-cancel:hover:not(:disabled) { background: #dc2626; }
.btn-cancel:disabled { opacity: 0.7; cursor: not-allowed; }
.btn-cancel:disabled::before { content: ''; width: 14px; height: 14px; border: 2px solid #fff; border-top-color: transparent; border-radius: 50%; animation: cancel-spin 0.6s linear infinite; display: inline-block; }
@keyframes cancel-spin { to { transform: rotate(360deg); } }

.progress-step-label { font-size: 13px; color: #94a3b8; margin-bottom: 8px; }
.progress-bar { height: 6px; background: #334155; border-radius: 3px; margin-bottom: 12px; overflow: hidden; }
.progress-fill { height: 100%; background: linear-gradient(90deg, #f59e0b, #ef4444); border-radius: 3px; transition: width 0.5s ease; min-width: 2%; }
.progress-log { max-height: 120px; overflow-y: auto; background: #0f172a; border-radius: 6px; padding: 8px 10px; }
.progress-line { display: flex; gap: 8px; font-size: 11px; font-family: monospace; padding: 2px 0; }
.progress-line-time { color: #475569; min-width: 60px; }
.progress-line-msg { color: #64748b; }
.progress-line.success .progress-line-msg { color: #22c55e; }
.progress-line.error .progress-line-msg { color: #ef4444; }
.progress-line.warning .progress-line-msg { color: #f59e0b; }

/* 欢迎引导 */
.welcome-banner {
  background: linear-gradient(135deg, #f59e0b15, #ef444415);
  border: 1px solid #f59e0b44; border-radius: 12px;
  padding: 24px; margin-bottom: 20px; animation: fadeIn 0.3s ease;
}
.welcome-banner h3 { font-size: 20px; color: #f59e0b; margin: 0 0 8px; }
.welcome-banner p { font-size: 13px; color: #94a3b8; margin: 8px 0; }
.welcome-banner ol { margin: 12px 0; padding-left: 20px; }
.welcome-banner li { margin: 6px 0; color: #cbd5e1; font-size: 13px; }
.welcome-hint { margin-top: 12px; }
.welcome-link { color: #f59e0b; text-decoration: underline; }

/* 快捷生成 */
.quick-bar {
  display: flex; gap: 10px; margin-bottom: 20px;
  padding: 16px; background: #1e293b; border-radius: 12px; border: 1px solid #334155;
}
.quick-input {
  flex: 1; padding: 12px 16px; border: 1px solid #334155; border-radius: 8px;
  background: #0f172a; color: #e2e8f0; font-size: 14px; outline: none; transition: border-color 0.2s;
}
.quick-input:focus { border-color: #f59e0b; }
.quick-input:disabled { opacity: 0.4; }
.quick-btn { padding: 12px 28px; white-space: nowrap; }

/* 快捷栏 + 批量切换 */
.qb-main { display: flex; gap: 10px; flex: 1; }
.qb-mode { display: flex; align-items: center; }
.qb-toggle {
  padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600;
  background: #334155; color: #64748b; cursor: pointer; transition: all 0.15s;
  white-space: nowrap; user-select: none;
}
.qb-toggle:hover { color: #94a3b8; }
.qb-toggle.on { background: #2563eb44; color: #60a5fa; border: 1px solid #2563eb44; }

/* 批量生成面板 */
.batch-panel {
  padding: 16px; background: #1e293b; border: 1px solid #3b82f644; border-radius: 12px;
  margin-bottom: 20px; animation: fadeIn 0.2s ease;
}
.bp-hint { font-size: 12px; color: #64748b; margin-bottom: 10px; }
.bp-textarea {
  width: 100%; padding: 12px; border: 1px solid #334155; border-radius: 8px;
  background: #0f172a; color: #e2e8f0; font-size: 14px; font-family: inherit;
  outline: none; resize: vertical; box-sizing: border-box;
}
.bp-textarea:focus { border-color: #3b82f6; }
.bp-actions { display: flex; gap: 10px; margin-top: 10px; }
.btn-sm { padding: 8px 16px; font-size: 12px; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; }

/* 费用卡片 */
.cost-card {
  background: linear-gradient(135deg, #065f4622, #05966922);
  border: 1px solid #05966944; border-radius: 12px;
  padding: 14px 20px; margin-bottom: 20px;
  display: flex; align-items: center; gap: 20px; flex-wrap: wrap;
}
.cost-label { font-size: 13px; color: #94a3b8; white-space: nowrap; }
.cost-items { display: flex; gap: 20px; flex: 1; }
.cost-item { display: flex; flex-direction: column; gap: 2px; }
.cost-metric { font-size: 11px; color: #64748b; }
.cost-value { font-size: 16px; font-weight: 700; color: #34d399; }
.cost-total .cost-value { color: #f59e0b; font-size: 18px; }

/* 今日产出 — 缩略图卡片 */
.item-card {
  display: flex; gap: 14px; padding: 12px; background: #1e293b; border-radius: 10px;
  margin-bottom: 8px; transition: background 0.15s;
}
.item-card:hover { background: #334155; }
.item-thumb {
  width: 64px; height: 64px; border-radius: 8px; overflow: hidden;
  background: #0f172a; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
}
.thumb-img { width: 100%; height: 100%; object-fit: cover; }
.thumb-placeholder { font-size: 24px; opacity: 0.5; }
.item-body { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
.item-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item-meta { font-size: 13px; color: #64748b; margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap; }
.item-time { color: #94a3b8; font-weight: 500; }

/* skeleton + shimmer in global style.css */

/* 完成通知横幅 */
.completion-banner {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; background: #065f4622; border: 1px solid #22c55e44;
  border-radius: 10px; margin-bottom: 16px; animation: fadeIn 0.3s ease;
}
.cb-icon { font-size: 20px; }
.cb-text { flex: 1; font-size: 14px; font-weight: 600; color: #22c55e; }
.cb-close {
  background: none; border: none; color: #64748b; cursor: pointer;
  font-size: 16px; padding: 2px 6px; border-radius: 4px;
}
.cb-close:hover { background: #334155; color: #e2e8f0; }

/* 内容预览卡片 */
.preview-card {
  background: #1e293b; border: 1px solid #f59e0b44; border-radius: 10px;
  padding: 12px 16px; margin-bottom: 16px; animation: fadeIn 0.3s ease;
}
.pc-hd { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 13px; font-weight: 700; color: #f59e0b; }
.preview-text { font-size: 13px; color: #94a3b8; line-height: 1.5; margin-bottom: 8px; max-height: 120px; overflow-y: auto; }
.preview-imgs { display: flex; gap: 8px; flex-wrap: wrap; }
.preview-img { width: 80px; height: 80px; object-fit: cover; border-radius: 6px; border: 1px solid #334155; }

/* 系统状态卡 */
.health-card {
  background: #1e293b; border: 1px solid #334155; border-radius: 10px;
  padding: 12px 16px; margin-bottom: 16px;
}
.hc-title { font-size: 13px; font-weight: 700; color: #94a3b8; margin-bottom: 10px; }
.hc-grid { display: flex; gap: 16px; flex-wrap: wrap; }
.hc-item { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.fail-warning {
  display: flex; align-items: center; gap: 12px; padding: 10px 14px;
  background: #7f1d1d33; border: 1px solid #ef444444; border-radius: 10px;
  margin-bottom: 16px; font-size: 13px; color: #fca5a5; animation: fadeIn 0.3s ease;
}
.hc-dot { width: 8px; height: 8px; border-radius: 50%; }
.hc-on { background: #22c55e; }
.hc-off { background: #64748b; }
.hc-err { background: #ef4444; animation: pulse 1.5s infinite; }
.hc-label { color: #64748b; }
.hc-val { color: #e2e8f0; font-weight: 600; }

/* 待发布卡片 */
.publish-card {
  background: #1e3a5f22; border: 1px solid #2563eb44; border-radius: 10px;
  padding: 12px 16px; margin-bottom: 16px;
}
.pc-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 13px; font-weight: 700; color: #60a5fa; }
.pc-count { font-size: 11px; color: #64748b; font-weight: 400; background: #0f172a; padding: 2px 8px; border-radius: 10px; }
.pc-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #33415533; font-size: 13px; }
.pc-row:last-of-type { border-bottom: none; }
.pc-type { flex-shrink: 0; }
.pc-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #e2e8f0; }
.pc-date { font-size: 11px; color: #64748b; flex-shrink: 0; }
.pc-btn { margin-top: 8px; width: 100%; justify-content: center; }

/* 采集数据概览 */
.collect-card {
  background: linear-gradient(135deg, #1e3a5f22, #1e40af22);
  border: 1px solid #2563eb44; border-radius: 12px;
  padding: 14px 20px; margin-bottom: 20px;
}
.collect-header {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 14px; font-weight: 600; color: #e2e8f0; margin-bottom: 10px;
}
.collect-date { font-size: 12px; color: #64748b; font-weight: 400; }
.collect-grid { display: flex; flex-wrap: wrap; gap: 8px; }
.platform-card {
  background: #0f172a; border-radius: 8px; padding: 10px 12px;
  min-width: 140px; flex: 1;
}
.platform-name { font-size: 12px; font-weight: 700; color: #60a5fa; margin-bottom: 6px; }
.platform-stats { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.stat-item { display: flex; gap: 4px; font-size: 11px; }
.stat-label { color: #64748b; }
.stat-value { color: #e2e8f0; font-weight: 600; }

/* empty-box in global style.css */

/* 日志区域（可折叠） */
.logs-section { margin-top: 24px; }
.log-toggle { font-size: 12px; color: #64748b; cursor: pointer; user-select: none; }
.log-toggle:hover { color: #94a3b8; }
.log-container { transition: all 0.3s ease; overflow: hidden; }
.log-container.collapsed {
  max-height: 0; margin: 0; padding: 0; opacity: 0;
}
:not(.collapsed).log-container {
  max-height: 600px; background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; padding: 12px;
}
.empty-log { padding: 20px; text-align: center; color: #64748b; font-size: 13px; }
.log-line {
  display: flex; gap: 12px; padding: 3px 0; font-size: 13px; font-family: monospace;
  border-bottom: 1px solid #1e293b22;
}
.log-time { color: #64748b; min-width: 140px; flex-shrink: 0; }
.log-msg { color: #94a3b8; }
.log-line.success .log-msg { color: #22c55e; }
.log-line.error .log-msg { color: #ef4444; }
.log-line.warning .log-msg { color: #f59e0b; }
</style>
