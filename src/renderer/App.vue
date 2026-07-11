<template>
  <!-- 非桌面环境遮罩 -->
  <div v-if="!isElectron" class="electron-required">
    <div class="er-card">
      <div class="er-icon">🖥️</div>
      <h1>需要桌面版</h1>
      <p>XNOWPost 是桌面应用程序，请使用桌面版运行。</p>
      <div class="er-hint">
        如已在桌面版打开，请检查是否被安全软件拦截。
      </div>
      <button class="er-retry" @click="retryCheck">🔄 重试检测</button>
    </div>
  </div>

  <div v-else class="app-container">
    <aside class="sidebar">
      <div class="logo">
        <h1>XNOWPost</h1>
        <div class="logo-meta">
          <span v-if="isDev" class="dev-badge">开发版</span>
          <span class="ver">v{{ version }}</span>
        </div>
        <p>内容营销引擎</p>
      </div>
      <nav>
        <router-link to="/" class="nav-item" :class="{ active: $route.path === '/' }">
          🏠 首页
        </router-link>
        <router-link to="/config" class="nav-item" :class="{ active: $route.path === '/config' }">
          ⚙️ 配置
        </router-link>
        <router-link to="/history" class="nav-item" :class="{ active: $route.path === '/history' }">
          📋 历史
        </router-link>
        <router-link to="/logs" class="nav-item" :class="{ active: $route.path === '/logs' }">
          📜 日志
        </router-link>
        <router-link to="/report" class="nav-item" :class="{ active: $route.path === '/report' }">
          📊 日报
        </router-link>
        <router-link to="/schedule" class="nav-item" :class="{ active: $route.path === '/schedule' }">
          ⏰ 闹钟
        </router-link>
      </nav>
      <div class="sidebar-footer">
        <span class="status-dot" :class="store.status.configured ? 'online' : 'offline'"></span>
        {{ store.status.configured ? '已配置' : '未配置' }}
        <button class="about-btn" @click="showAbout = true" title="关于">
          <span v-if="updateAvailable" class="update-dot"></span>
          ℹ️
        </button>
      </div>
    </aside>
    <main class="content">
      <router-view />
    </main>

    <!-- 新手指引 -->
    <div v-if="showGuide" class="modal-overlay" @click.self="closeGuide">
      <div class="guide-card">
        <h3>🚀 快速开始</h3>
        <div class="guide-steps">
          <div class="guide-step" :class="{ done: guideStep > 0 }">
            <div class="gs-num">1</div>
            <div class="gs-body">
              <strong>配置 API Key</strong>
              <p>填写 DeepSeek 和硅基流动的 API Key，让 AI 帮您写文案、生图片</p>
              <router-link to="/config" class="guide-link" @click="closeGuide">去配置 →</router-link>
            </div>
          </div>
          <div class="guide-step" :class="{ done: guideStep > 1 }">
            <div class="gs-num">2</div>
            <div class="gs-body">
              <strong>添加采集账号</strong>
              <p>在配置页添加需要监控的社交媒体账号，绑定比特浏览器环境</p>
            </div>
          </div>
          <div class="guide-step" :class="{ done: guideStep > 2 }">
            <div class="gs-num">3</div>
            <div class="gs-body">
              <strong>设置定时闹钟</strong>
              <p>在闹钟页设置每天自动产出内容的时间，到点自动运行</p>
              <router-link to="/schedule" class="guide-link" @click="closeGuide">去设置 →</router-link>
            </div>
          </div>
        </div>
        <div class="guide-footer">
          <button class="btn btn-primary" @click="nextGuideStep">
            {{ guideStep < 2 ? '下一步' : '开始使用' }}
          </button>
          <button class="btn-guide-skip" @click="closeGuide">跳过引导</button>
        </div>
      </div>
    </div>

    <!-- 关于/更新弹窗 -->
    <div v-if="showAbout" class="modal-overlay" @click.self="showAbout = false">
      <div class="modal-dialog">
        <h3>关于 XNOWPost</h3>
        <div class="about-info">
          <p class="about-version">版本 {{ version }} <span v-if="isDev" class="dev-badge-sm">开发版</span></p>
          <!-- 更新检查 -->
          <div v-if="updateAvailable" class="update-panel">
            <p class="update-msg">🆕 v{{ updateInfo.version }} 可用</p>
            <div v-if="downloadProgress > 0 && downloadProgress < 100" class="update-progress-bar">
              <div class="update-progress-fill" :style="{ width: downloadProgress + '%' }"></div>
            </div>
            <div class="update-actions">
              <button v-if="!downloading && !downloaded" class="btn-update" @click="doDownload">📥 下载更新</button>
              <button v-if="downloaded" class="btn-update btn-install" @click="doInstall">🔄 立即安装</button>
              <span v-if="downloading && downloadProgress < 100" class="downloading-text">⏳ 下载中 {{ downloadProgress }}%</span>
            </div>
          </div>
          <div v-else-if="updateChecked && !updateAvailable" class="update-panel update-latest">
            <p>✅ 已是最新版本</p>
          </div>
          <div v-else class="update-panel">
            <button class="btn-update" @click="doCheck">🔍 检查更新</button>
          </div>
        </div>
        <button class="btn-close" @click="showAbout = false">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useAppStore } from './stores/app.js';
import { onMounted, ref } from 'vue';
import { version } from '../../package.json';

const store = useAppStore();
const isElectron = ref(!!window.xnowpost);
const isDev = ref(window.xnowpost?.isDev ?? false);
function retryCheck() {
  isElectron.value = !!window.xnowpost;
}

// 新手引导
const showGuide = ref(false);
const guideStep = ref(0);
function nextGuideStep() {
  if (guideStep.value < 2) { guideStep.value++; return }
  closeGuide();
}
function closeGuide() {
  showGuide.value = false;
  try { localStorage.setItem('xnowpost_guided', '1') } catch (_) {}
}

// 更新状态
const showAbout = ref(false);
const updateAvailable = ref(false);
const updateInfo = ref({});
const updateChecked = ref(false);
const downloading = ref(false);
const downloaded = ref(false);
const downloadProgress = ref(0);
const updateError = ref('');

function doCheck() {
  updateChecked.value = false;
  updateError.value = '';
  window.xnowpost.checkUpdate();
}
function doDownload() {
  downloading.value = true;
  window.xnowpost.downloadUpdate();
}
function doInstall() {
  window.xnowpost.installUpdate();
}

onMounted(async () => {
  if (!window.xnowpost) return; // skip IPC in browser mode
  await store.loadConfig();

  // first-visit guide
  if (!store.status.configured) {
    const guided = (() => { try { return localStorage.getItem('xnowpost_guided') } catch(_) { return null } })()
    if (!guided) { showGuide.value = true }
  }

  // listen for update events
  window.xnowpost.onUpdateAvailable((info) => {
    updateAvailable.value = true;
    updateInfo.value = info;
    updateChecked.value = true;
  });
  window.xnowpost.onUpdateNotAvailable(() => {
    updateAvailable.value = false;
    updateChecked.value = true;
  });
  window.xnowpost.onUpdateProgress((p) => {
    downloadProgress.value = p.percent;
  });
  window.xnowpost.onUpdateDownloaded(() => {
    downloaded.value = true;
    downloading.value = false;
    downloadProgress.value = 100;
  });
  window.xnowpost.onUpdateError((message) => {
    updateError.value = message;
    updateChecked.value = true;
  });

  // 监听引擎日志（上限 500 条防 OOM）
  window.xnowpost.onLog((entry) => {
    store.logs.push(entry);
    if (store.logs.length > 500) store.logs.splice(0, store.logs.length - 500);
  });
});
</script>

<style scoped>
.app-container {
  display: flex;
  height: 100vh;
  background: #0f172a;
  color: #e2e8f0;
}
.sidebar {
  width: 200px;
  min-width: 200px;
  background: #1e293b;
  display: flex;
  flex-direction: column;
  padding: 20px 0;
  border-right: 1px solid #334155;
}
.logo {
  padding: 0 16px 14px;
  border-bottom: 1px solid #334155;
  margin-bottom: 8px;
}
.logo h1 {
  font-size: 18px;
  font-weight: 900;
  background: linear-gradient(135deg, #f59e0b, #ef4444);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  margin: 0 0 3px 0;
}
.logo-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 2px;
}
.logo .ver {
  font-size: 11px;
  font-weight: 600;
  background: #334155;
  -webkit-text-fill-color: #94a3b8;
  padding: 1px 6px;
  border-radius: 4px;
}
.dev-badge {
  font-size: 10px;
  font-weight: 800;
  background: #f97316;
  -webkit-text-fill-color: #0f172a;
  padding: 1px 5px;
  border-radius: 3px;
  letter-spacing: 0.5px;
  white-space: nowrap;
}
.logo p { font-size: 11px; color: #64748b; margin: 0; }
.nav-item {
  display: block;
  padding: 12px 20px;
  color: #94a3b8;
  text-decoration: none;
  font-size: 14px;
  transition: all 0.2s;
  border-left: 3px solid transparent;
}
.nav-item:hover { color: #e2e8f0; background: #33415533; }
.nav-item.active { color: #f59e0b; border-left-color: #f59e0b; background: #33415544; }
.sidebar-footer {
  margin-top: auto;
  padding: 12px 16px;
  font-size: 12px;
  color: #64748b;
  display: flex;
  align-items: center;
  gap: 6px;
}
.about-btn {
  margin-left: auto;
  background: none;
  border: none;
  color: #64748b;
  cursor: pointer;
  font-size: 14px;
  padding: 2px 4px;
  border-radius: 4px;
  position: relative;
  transition: color 0.2s;
}
.about-btn:hover { color: #e2e8f0; background: #334155; }
.update-dot {
  position: absolute;
  top: 0; right: 0;
  width: 7px; height: 7px;
  border-radius: 50%;
  background: #ef4444;
}
.status-dot {
  display: inline-block;
  width: 8px; height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}
.status-dot.online { background: #22c55e; }
.status-dot.offline { background: #ef4444; }
.content {
  flex: 1;
  overflow-y: auto;
  padding: 30px;
}

/* 关于弹窗 */
.modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.6);
  display: flex; align-items: center; justify-content: center;
  z-index: 100;
}
.modal-dialog {
  background: #1e293b; border: 1px solid #334155; border-radius: 12px;
  padding: 24px; width: 380px; max-width: 90vw;
}
.modal-dialog h3 { margin: 0 0 16px; font-size: 18px; color: #e2e8f0; }
.about-info { margin-bottom: 16px; }
.about-version { font-size: 14px; color: #94a3b8; }
.dev-badge-sm {
  font-size: 10px; font-weight: 700; background: #f97316; color: #0f172a;
  padding: 1px 5px; border-radius: 3px; vertical-align: middle; margin-left: 4px;
}
.update-panel { margin-top: 12px; padding: 12px; background: #0f172a; border-radius: 8px; }
.update-msg { font-size: 14px; color: #60a5fa; margin: 0 0 8px; font-weight: 600; }
.update-latest p { margin: 0; font-size: 13px; color: #22c55e; }
.update-error p { margin: 0; font-size: 12px; color: #ef4444; line-height: 1.4; }
.update-actions { display: flex; gap: 8px; align-items: center; }
.btn-update {
  padding: 6px 14px; border: none; border-radius: 6px; font-size: 13px; font-weight: 600;
  cursor: pointer; background: #2563eb; color: #fff; transition: background 0.2s;
}
.btn-update:hover { background: #1d4ed8; }
.btn-install { background: #22c55e; }
.btn-install:hover { background: #16a34a; }
.downloading-text { font-size: 12px; color: #f59e0b; }
.update-progress-bar { height: 4px; background: #334155; border-radius: 2px; margin-bottom: 8px; overflow: hidden; }
.update-progress-fill { height: 100%; background: #2563eb; border-radius: 2px; transition: width 0.3s; }
.btn-close {
  width: 100%; padding: 8px; border: 1px solid #334155; border-radius: 6px;
  background: transparent; color: #94a3b8; font-size: 13px; cursor: pointer; transition: 0.2s;
}
.btn-close:hover { background: #334155; color: #e2e8f0; }

/* 新手引导 */
.guide-card {
  background: #1e293b; border: 1px solid #334155; border-radius: 16px;
  padding: 28px; width: 480px; max-width: 90vw; max-height: 80vh; overflow-y: auto;
}
.guide-card h3 { font-size: 20px; margin: 0 0 20px; color: #f59e0b; text-align: center; }
.guide-steps { display: flex; flex-direction: column; gap: 16px; margin-bottom: 20px; }
.guide-step { display: flex; gap: 14px; padding: 14px; border-radius: 10px; background: #0f172a; border: 1px solid #334155; transition: all 0.3s; }
.guide-step.done { border-color: #22c55e44; background: #065f4622; }
.gs-num {
  width: 28px; height: 28px; border-radius: 50%; background: #334155;
  color: #94a3b8; font-size: 14px; font-weight: 700;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.guide-step.done .gs-num { background: #22c55e; color: #0f172a; }
.gs-body { flex: 1; }
.gs-body strong { display: block; font-size: 14px; color: #e2e8f0; margin-bottom: 4px; }
.gs-body p { font-size: 12px; color: #64748b; margin: 0; line-height: 1.5; }
.guide-link { font-size: 12px; color: #f59e0b; font-weight: 600; text-decoration: none; display: inline-block; margin-top: 6px; }
.guide-link:hover { text-decoration: underline; }
.guide-footer { display: flex; gap: 10px; justify-content: center; align-items: center; }
.btn { padding: 10px 24px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn-primary { background: linear-gradient(135deg, #f59e0b, #d97706); color: #0f172a; }
.btn-guide-skip { background: none; border: none; color: #64748b; font-size: 13px; cursor: pointer; padding: 8px 16px; }
.btn-guide-skip:hover { color: #94a3b8; }

/* 非桌面环境遮罩 */
.electron-required {
  display: flex; align-items: center; justify-content: center;
  height: 100vh; background: #0f172a; color: #e2e8f0;
}
.er-card {
  text-align: center; padding: 48px; max-width: 420px;
  background: #1e293b; border-radius: 16px; border: 1px solid #334155;
}
.er-icon { font-size: 64px; margin-bottom: 16px; }
.er-card h1 { font-size: 24px; margin: 0 0 12px; }
.er-card p { font-size: 14px; color: #94a3b8; margin: 0 0 8px; line-height: 1.6; }
.er-hint { font-size: 12px; color: #64748b; margin-bottom: 20px; }
.er-retry {
  padding: 10px 24px; border: none; border-radius: 8px;
  background: #334155; color: #e2e8f0; font-size: 14px; cursor: pointer; transition: background 0.2s;
}
.er-retry:hover { background: #475569; }
</style>
