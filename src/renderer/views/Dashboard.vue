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
      <input v-model="quickTopic" placeholder="输入主题（留空让 AI 自由发挥）..."
             class="quick-input" @keyup.enter="quickGenerate" :disabled="store.status.running" />
      <button class="btn btn-primary quick-btn" @click="quickGenerate" :disabled="store.status.running">
        ⚡ 生成
      </button>
    </div>

    <!-- 进度面板（引擎运行时显示） -->
    <div v-if="store.status.running" class="progress-panel">
      <div class="progress-header">
        <span>⏳ 正在生成...</span>
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
      <button class="btn btn-publish" @click="handlePublish" :disabled="publishing">
        {{ publishing ? '⏳ 发布中...' : '📤 发布' }}
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
const quickTopic = ref('');
const logExpanded = ref(false);
const collectData = ref(null);
let refreshTimer = null;

const platformNames = {
  tiktok: 'TikTok', xiaohongshu: '小红书', facebook: 'Facebook',
  instagram: 'Instagram', youtube: 'YouTube', x: 'X',
};
const metricLabels = {
  followers: '粉丝', views: '播放', likes: '点赞',
  comments: '评论', shares: '转发', reach: '触达', engagement: '互动',
};
function formatNum(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

const statusText = computed(() => {
  if (!store.status.configured) return '🔑 还需要配置 API Key 才能开始工作';
  if (store.status.running) return '⏳ 引擎运行中...';
  if (store.status.schedulerActive) return '⏰ 调度器执行中';
  return '🟢 一切就绪';
});

const currentStep = computed(() => {
  const logs = store.logs;
  if (!logs.length) return { label: '准备中...', percent: 0 };
  const recent = logs.slice(-20).map(l => l.message).join(' ');
  if (recent.includes('文案') || recent.includes('DeepSeek') || recent.includes('标题') || recent.includes('分镜')) return { label: '🤖 AI 生成文案', percent: 15 };
  if (recent.includes('封面') || recent.includes('底图') || recent.includes('Kolors') || recent.includes('回退')) return { label: '🎨 生成图片素材', percent: 40 };
  if (recent.includes('配音') || recent.includes('edge-tts') || recent.includes('voice')) return { label: '🔊 合成配音', percent: 60 };
  if (recent.includes('合成') || recent.includes('ffmpeg') || recent.includes('video_')) return { label: '🎬 合成视频', percent: 80 };
  if (recent.includes('推送') || recent.includes('TG')) return { label: '📤 推送到频道', percent: 95 };
  return { label: '处理中...', percent: 10 };
});

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

async function refreshStatus() {
  const status = await window.xnowpost.getEngineStatus();
  Object.assign(store.status, status);
}

onMounted(async () => {
  await refreshToday();
  store.loadCost();
  collectData.value = await window.xnowpost.getLatestCollect();
  refreshTimer = setInterval(() => {
    refreshToday();
    refreshStatus();
  }, 10000);
});

onUnmounted(() => {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
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

/* 进度面板 */
.progress-panel {
  background: #1e293b; border: 1px solid #f59e0b44; border-radius: 12px;
  padding: 20px; margin-bottom: 20px; animation: fadeIn 0.3s ease;
}
@keyframes fadeIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
.progress-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; font-size: 15px; font-weight: 600; color: #f59e0b; }
.btn-cancel { padding: 6px 16px; background: #ef4444; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; }
.btn-cancel:hover:not(:disabled) { background: #dc2626; }
.btn-cancel:disabled { opacity: 0.5; cursor: not-allowed; }
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
.item-meta { font-size: 12px; color: #64748b; margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap; }
.item-time { color: #94a3b8; font-weight: 500; }

/* 骨架屏 */
.skeleton-list { display: flex; flex-direction: column; gap: 8px; }
.skeleton-card {
  display: flex; gap: 14px; padding: 12px; background: #1e293b; border-radius: 10px;
}
.skeleton-thumb {
  width: 64px; height: 64px; border-radius: 8px; background: linear-gradient(90deg, #1e293b 25%, #334155 50%, #1e293b 75%);
  background-size: 200% 100%; animation: shimmer 1.5s infinite; flex-shrink: 0;
}
.skeleton-lines { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 8px; }
.skeleton-line {
  height: 12px; border-radius: 4px; background: linear-gradient(90deg, #1e293b 25%, #334155 50%, #1e293b 75%);
  background-size: 200% 100%; animation: shimmer 1.5s infinite;
}
.skeleton-line.w-60 { width: 60%; }
.skeleton-line.w-30 { width: 30%; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

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

/* 空状态 */
.empty-box {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 40px; color: #64748b; font-size: 14px;
}
.empty-icon { font-size: 32px; }

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
  display: flex; gap: 12px; padding: 3px 0; font-size: 12px; font-family: monospace;
  border-bottom: 1px solid #1e293b22;
}
.log-time { color: #64748b; min-width: 140px; flex-shrink: 0; }
.log-msg { color: #94a3b8; }
.log-line.success .log-msg { color: #22c55e; }
.log-line.error .log-msg { color: #ef4444; }
.log-line.warning .log-msg { color: #f59e0b; }
</style>
