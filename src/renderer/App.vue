<template>
  <!-- 非桌面环境遮罩 -->
  <div v-if="!isElectron" class="electron-required">
    <div class="er-card">
      <div class="er-icon">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.4">
          <rect x="2.5" y="4" width="19" height="13" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
      </div>
      <h1>需要桌面版</h1>
      <p>XNOWPost 是桌面应用程序，请使用桌面版运行。</p>
      <div class="er-hint">如已在桌面版打开，请检查是否被安全软件拦截。</div>
      <button class="x-btn" @click="retryCheck">
        <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v4h-4" /></svg>
        重试检测
      </button>
    </div>
  </div>

  <div v-else class="app-container">
    <aside class="sidebar">
      <div class="logo">
        <div class="logo-mark">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3v12" /><path d="m7 12 5 5 5-5" /><path d="M4 19h16" />
          </svg>
        </div>
        <span class="logo-name">XNOWPost</span>
        <span v-if="isDev" class="dev-badge">DEV</span>
        <span class="ver">v{{ version }}</span>
      </div>

      <nav>
        <router-link to="/" class="nav-item" :class="{ active: $route.path === '/' }">
          <svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 10v10h14V10" /></svg>
          首页
        </router-link>
        <router-link to="/accounts" class="nav-item" :class="{ active: $route.path === '/accounts' }">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5" /><path d="M4.5 20c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5" /></svg>
          账号
        </router-link>
        <router-link to="/config" class="nav-item" :class="{ active: $route.path === '/config' }">
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1 2 2 0 1 1-4 0 1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 15a2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 4.6a2 2 0 1 1 4 0 1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 19.4 11a2 2 0 1 1 0 4z" />
          </svg>
          配置
        </router-link>
        <router-link to="/history" class="nav-item" :class="{ active: $route.path === '/history' }">
          <svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" /><path d="M8 9h8M8 13h5" /></svg>
          历史
        </router-link>
        <router-link to="/report" class="nav-item" :class="{ active: $route.path === '/report' }">
          <svg viewBox="0 0 24 24"><path d="M4 19V9M10 19V5M16 19v-7M22 19H2" /></svg>
          日报
        </router-link>
        <router-link to="/schedule" class="nav-item" :class="{ active: $route.path === '/schedule' }">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>
          定时
        </router-link>
        <router-link to="/logs" class="nav-item" :class="{ active: $route.path === '/logs' }">
          <svg viewBox="0 0 24 24"><path d="M6 3h9l3 3v15H6z" /><path d="M9 9h6M9 13h6M9 17h4" /></svg>
          日志
        </router-link>
      </nav>

      <div class="sidebar-footer">
        <span class="status-dot" :class="store.status.configured ? 'online' : 'offline'"></span>
        <span class="foot-text">{{ store.status.configured ? '已配置' : '未配置' }}</span>
        <button class="about-btn" @click="showAbout = true" title="关于">
          <span v-if="updateAvailable" class="update-dot"></span>
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
        </button>
      </div>
    </aside>

    <main class="content">
      <router-view />
    </main>

    <!-- 新手指引 -->
    <div v-if="showGuide" class="modal-overlay" @click.self="closeGuide">
      <div class="guide-card">
        <h3>快速开始</h3>
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
              <strong>登录账号</strong>
              <p>把账号文件丢进 import\accounts\，在「账号」页一键批量登录指纹环境</p>
              <router-link to="/accounts" class="guide-link" @click="closeGuide">去账号 →</router-link>
            </div>
          </div>
          <div class="guide-step" :class="{ done: guideStep > 2 }">
            <div class="gs-num">3</div>
            <div class="gs-body">
              <strong>设置定时闹钟</strong>
              <p>在定时页设置每天自动产出内容的时间，到点自动运行</p>
              <router-link to="/schedule" class="guide-link" @click="closeGuide">去设置 →</router-link>
            </div>
          </div>
        </div>
        <div class="guide-footer">
          <button class="x-btn primary" @click="nextGuideStep">
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
            <p class="update-msg">v{{ updateInfo.version }} 可用</p>
            <div v-if="downloadProgress > 0 && downloadProgress < 100" class="update-progress-bar">
              <div class="update-progress-fill" :style="{ width: downloadProgress + '%' }"></div>
            </div>
            <div class="update-actions">
              <button v-if="!downloading && !downloaded" class="x-mini hi" @click="doDownload">下载更新</button>
              <button v-if="downloaded" class="x-mini hi" @click="doInstall">立即安装</button>
              <span v-if="downloading && downloadProgress < 100" class="downloading-text">下载中 {{ downloadProgress }}%</span>
            </div>
          </div>
          <div v-else-if="updateChecked && !updateAvailable" class="update-panel update-latest">
            <p>已是最新版本</p>
          </div>
          <div v-else class="update-panel">
            <button class="x-mini" @click="doCheck">检查更新</button>
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
import { version as pkgVersion } from '../../package.json';

const store = useAppStore();
// 版本号：pkgVersion 是 Vite **构建时内联**的常量，一旦打包时忘了重建前端，
// 界面就会一直显示上一次构建的旧号（实际发生过：装的是 1.3.2，侧边栏写着 1.3.1）。
// 所以优先用主进程运行时真实版本 app.getVersion()，它永远等于安装包版本。
const version = ref(pkgVersion);
onMounted(async () => {
  try {
    const c = await window.xnowpost?.getConfig?.();
    if (c && c.appVersion) version.value = c.appVersion;
  } catch (_) { /* 拿不到就用构建期版本兜底 */ }
});
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
  // ⚠️ 配置读取失败不能阻断后面的订阅注册，否则日志流与更新事件会被永久禁用（P2-3 同型）
  try {
    await store.loadConfig();
  } catch (e) {
    console.error('加载配置失败:', e);
  }

  // first-visit guide
  try {
    if (!store.status.configured) {
      const guided = (() => { try { return localStorage.getItem('xnowpost_guided') } catch(_) { return null } })();
      if (!guided) { showGuide.value = true }
    }
  } catch (_) {}

  // listen for update events（整块隔离：任一订阅失败不影响已注册的其它订阅）
  try {
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
  } catch (e) {
    console.error('订阅注册失败:', e);
  }
});
</script>

<style scoped>
.app-container {
  display: flex;
  height: 100vh;
  background: var(--bg0);
  color: var(--text);
}

/* ── 侧栏 ── */
.sidebar {
  width: 212px;
  min-width: 212px;
  background: var(--bg1);
  border-right: 1px solid var(--stroke);
  display: flex;
  flex-direction: column;
  padding: 16px 12px;
}
.logo {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 4px 8px 18px;
}
.logo-mark {
  width: 28px;
  height: 28px;
  border-radius: 9px;
  background: linear-gradient(135deg, var(--brand), #ff7a45);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 14px rgba(255, 46, 91, 0.35);
  flex: 0 0 28px;
}
.logo-name {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: 0.2px;
  color: var(--text);
}
.logo .ver {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-3);
  border: 1px solid var(--stroke-2);
  padding: 1px 5px;
  border-radius: 5px;
}
.dev-badge {
  font-size: 9.5px;
  font-weight: 800;
  background: var(--warn);
  color: #14181f;
  padding: 1px 5px;
  border-radius: 4px;
  letter-spacing: 0.4px;
}
nav { display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: var(--r-sm);
  color: var(--text-2);
  text-decoration: none;
  font-size: 13.5px;
  position: relative;
  transition: background 0.16s, color 0.16s;
}
.nav-item svg {
  width: 17px;
  height: 17px;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.7;
  flex: 0 0 17px;
  opacity: 0.9;
}
.nav-item:hover { color: var(--text); background: rgba(44, 61, 80, 0.28); }
.nav-item.active { background: var(--brand-soft); color: #fff; }
.nav-item.active::before {
  content: '';
  position: absolute;
  left: -12px;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--brand);
}
.sidebar-footer {
  margin-top: auto;
  padding: 10px 8px;
  border-top: 1px solid var(--stroke);
  font-size: 12px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 7px;
}
.foot-text { font-size: 12px; color: var(--text-2); }
.status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; }
.status-dot.online { background: var(--ok); box-shadow: 0 0 0 3px rgba(45, 212, 167, 0.14); }
.status-dot.offline { background: var(--danger); box-shadow: 0 0 0 3px rgba(240, 81, 78, 0.14); }
.about-btn {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 3px;
  border-radius: 6px;
  position: relative;
  display: flex;
}
.about-btn svg { width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 1.8; }
.about-btn:hover { color: var(--text); background: var(--bg3); }
.update-dot {
  position: absolute;
  top: 0; right: 0;
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--danger);
}
.content {
  flex: 1;
  overflow-y: auto;
  padding: 22px;
  min-width: 0;
}

/* ── 弹窗 ── */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(4, 8, 12, 0.66);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal-dialog {
  background: var(--bg2);
  border: 1px solid var(--stroke-2);
  border-radius: var(--r-md);
  padding: 22px;
  width: 380px;
  max-width: 90vw;
  box-shadow: var(--shadow-2);
}
.modal-dialog h3 { margin: 0 0 14px; font-size: 15px; font-weight: 640; color: var(--text); }
.about-info { margin-bottom: 14px; }
.about-version { font-size: 13px; color: var(--text-2); }
.dev-badge-sm {
  font-size: 10px; font-weight: 700; background: var(--warn); color: #14181f;
  padding: 1px 5px; border-radius: 4px; vertical-align: middle; margin-left: 4px;
}
.update-panel { margin-top: 12px; padding: 12px; background: var(--bg1); border-radius: var(--r-sm); border: 1px solid var(--stroke); }
.update-msg { font-size: 13px; color: var(--info); margin: 0 0 8px; font-weight: 600; }
.update-latest p { margin: 0; font-size: 13px; color: var(--ok); }
.update-actions { display: flex; gap: 8px; align-items: center; }
.downloading-text { font-size: 12px; color: var(--warn); }
.update-progress-bar { height: 4px; background: var(--bg3); border-radius: 2px; margin-bottom: 8px; overflow: hidden; }
.update-progress-fill { height: 100%; background: var(--brand); border-radius: 2px; transition: width 0.3s; }
.btn-close {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--stroke-2);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
  transition: 0.2s;
}
.btn-close:hover { background: var(--bg3); color: var(--text); }

/* ── 新手引导 ── */
.guide-card {
  background: var(--bg2);
  border: 1px solid var(--stroke-2);
  border-radius: var(--r-lg);
  padding: 26px;
  width: 470px;
  max-width: 90vw;
  max-height: 80vh;
  overflow-y: auto;
  box-shadow: var(--shadow-2);
}
.guide-card h3 { font-size: 17px; margin: 0 0 18px; color: var(--text); text-align: center; font-weight: 650; }
.guide-steps { display: flex; flex-direction: column; gap: 12px; margin-bottom: 18px; }
.guide-step {
  display: flex;
  gap: 13px;
  padding: 13px;
  border-radius: var(--r-sm);
  background: var(--bg1);
  border: 1px solid var(--stroke);
  transition: border-color 0.25s, background 0.25s;
}
.guide-step.done { border-color: rgba(45, 212, 167, 0.35); background: rgba(45, 212, 167, 0.06); }
.gs-num {
  width: 26px; height: 26px; border-radius: 50%;
  background: var(--bg3); color: var(--text-2);
  font-size: 12.5px; font-weight: 700;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.guide-step.done .gs-num { background: var(--ok); color: #06181a; }
.gs-body { flex: 1; }
.gs-body strong { display: block; font-size: 13.5px; color: var(--text); margin-bottom: 3px; font-weight: 600; }
.gs-body p { font-size: 12px; color: var(--text-3); margin: 0; line-height: 1.5; }
.guide-link { font-size: 12px; color: var(--brand); font-weight: 600; text-decoration: none; display: inline-block; margin-top: 6px; }
.guide-link:hover { text-decoration: underline; }
.guide-footer { display: flex; gap: 10px; justify-content: center; align-items: center; }
.btn-guide-skip {
  background: none; border: none; color: var(--text-3);
  font-size: 13px; cursor: pointer; padding: 8px 14px; border-radius: var(--r-sm);
}
.btn-guide-skip:hover { color: var(--text-2); background: var(--bg3); }

/* ── 非桌面环境遮罩 ── */
.electron-required {
  display: flex; align-items: center; justify-content: center;
  height: 100vh; background: var(--bg0); color: var(--text);
}
.er-card {
  text-align: center; padding: 44px; max-width: 420px;
  background: var(--bg2); border-radius: var(--r-lg); border: 1px solid var(--stroke-2);
}
.er-icon { color: var(--text-3); margin-bottom: 14px; display: flex; justify-content: center; }
.er-card h1 { font-size: 20px; margin: 0 0 10px; font-weight: 650; }
.er-card p { font-size: 13.5px; color: var(--text-2); margin: 0 0 8px; line-height: 1.6; }
.er-hint { font-size: 12px; color: var(--text-3); margin-bottom: 18px; }
</style>
