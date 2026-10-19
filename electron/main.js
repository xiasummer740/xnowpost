import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { initUpdater, downloadUpdate, quitAndInstall, checkForUpdates } from './updater.js';
// 发布账本 / 最后发布时间（扫描逻辑与命令行脚本共用同一份实现）
import { latestPublishByEnv } from '../src/publish-history.js';
// 环境窗口标题前缀（窗口侧脚本与单测共用一份实现）
// 纯逻辑工具抽到 ./lib/sanitize.js，便于被单元测试直接导入（main.js 本身无法在 node --test 里加载）
import {
  SECRET_FIELDS,
  maskSecret,
  isMaskedValue,
  resolveSessionDir,
  isValidDataDir,
  mimeForImage,
  readTextCapped,
  dedupeJobIds,
} from './lib/sanitize.js';
// 日志行解析/分类/合并（app 日志 + 调度器日志），纯函数，单测在 tests/unit/log-lines.test.js
import { parseLogText, mergeLogLines, dropEchoedSchedulerLines } from './lib/log-lines.js';
import { pickLogsToPrune } from './lib/log-prune.js';
// AI 服务错误的人话翻译（401=Key 无效 / 402=余额 / 429=限流 / 断连 ≠ Key 坏）
import { describeAiError } from './lib/ai-error.js';
import { pickOldDateDirs, isCleanable } from '../src/output-retention.js';
// 发布候选扫描（唯一实现：只认当天 / 跳 FAILED / 跳已发布 / 默认 3 条）
import { scanUnpublished, summarizeSkips, DEFAULT_MAX_PER_RUN } from '../src/output-scan.js';
// 凭据/关键状态的加密备份（纯逻辑 + 单测在 tests/unit/secrets-backup.test.js）
import {
  SECRET_FILES,
  SECRET_KEEP_DAYS,
  BUNDLE_FILE,
  buildBundle,
  parseBundle,
  summarizeBundle,
  isEmptyBundle,
  missingSecretLabels,
  planRestore,
  describeBytes,
} from '../src/secrets-backup.js';
// AI 助手的执行循环（纯逻辑，单测 tests/unit/assistant-loop.test.js）
import { createAssistantSession } from './assistant.js';
// AI 助手的工具白名单 / 参数校验 / 预览 / 脱敏（安全边界唯一实现，单测 assistant-tools.test.js）
import {
  publicTools,
  buildSystemPrompt,
  validateConfigPatch,
  clampPublishCount,
  getToolDef,
} from './lib/assistant-tools.js';

/** 日志页一次最多渲染多少行（再多 DOM 会卡；文件本身不截断，界面可以「显示更早」） */
const LOG_LINE_LIMIT = 6000;

/**
 * 本地日期 YYYY-MM-DD。
 * ⚠️ 日志文件名必须用**本地**日期：`toISOString()` 是 UTC，北京时间 00:00–08:00 会把
 * 当天的日志写进前一天的文件里（调度器早就按本地算，两边文件名就对不上了）。
 */
function localDateStr(d = new Date()) {
  return d.toLocaleDateString('sv-SE');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
// 用 createRequire 加载 electron（ESM 的 import 在 Electron 中不可靠）
const electron = _require('electron');
const { app, BrowserWindow, ipcMain, shell, screen, Tray, Menu, nativeImage } = electron;
const ROOT = path.resolve(__dirname, '..');

/**
 * 程序安装目录（打包后 = exe 所在目录；开发时 = 项目根）。
 * 数据目录绝不能落在它里面：卸载/升级会连数据一起删掉。
 * 用函数懒取，避免 app 尚未 ready 时调用 getPath 的兼容问题。
 */
function installDir() {
  try {
    return app.isPackaged ? path.dirname(app.getPath('exe')) : ROOT;
  } catch (_) {
    return ROOT;
  }
}

// 找到真正的 node.exe（不用 process.execPath 因为 electron.exe 是 GUI 程序，windowsHide 对它无效）
function findNodeExe() {
  const elDir = path.dirname(process.execPath);
  const selfNode = path.join(elDir, 'node.exe');
  if (fs.existsSync(selfNode)) return selfNode;
  try {
    const { execSync } = _require('child_process');
    const r = execSync('where node', { stdio: 'pipe', encoding: 'utf-8', windowsHide: true });
    const lines = r.trim().split('\n');
    if (lines[0]) return lines[0].trim();
  } catch (_) {}
  return 'node';
}
const NODE_EXE = findNodeExe();

// 数据目录：安装版 → %APPDATA%/xnowpost，开发版 → 项目根目录
// ⚠️ 必须在崩溃处理器之前声明：处理器闭包里要用它，声明在后面会踩 TDZ
let DATA_DIR = ROOT;

// 崩溃日志必须写到**可写**的地方。
// ROOT 在打包后是 …/resources/app.asar（asar 内只读），
// 原来写 ROOT/logs 会被 catch(_){} 静默吞掉 → 正式版永远拿不到崩溃证据。
// 这里按 DATA_DIR → userData 依次尝试。
function writeCrashLog(kind, detail) {
  const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`;
  const dirs = [path.join(DATA_DIR, 'logs')];
  try { dirs.push(path.join(app.getPath('userData'), 'logs')); } catch (_) { /* app 未就绪 */ }
  for (const dir of dirs) {
    try {
      fs.ensureDirSync(dir);
      fs.appendFileSync(path.join(dir, 'crash.log'), line);
      return true;
    } catch (_) { /* 换下一个候选目录 */ }
  }
  return false;
}

// 结束子进程及其**整棵进程树**。
// ⚠️ Windows 没有进程组语义，process.kill(-pid) 只会 ESRCH 失败；
// 而引擎会派生 FFmpeg / Playwright / Chromium 等孙进程，
// 只杀父进程会留下一堆孤儿进程继续吃 CPU、占用比特浏览器窗口。
// taskkill /T /F 是唯一能连根拔起的系统内置手段。
function killProcessTree(proc) {
  if (!proc || !proc.pid || proc.killed) return false;
  try {
    const { execFileSync } = _require('child_process');
    execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10000,
    });
    return true;
  } catch (_) {
    // taskkill 失败（进程可能已退出）→ 退回普通 kill 兜底
    try { proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
    return false;
  }
}

// 统一收掉所有后台子进程（重启/退出时必须先做，否则变孤儿）
function killAllChildren() {
  for (const p of [engineProcess, schedulerProcess, collectProcess]) {
    killProcessTree(p);
  }
  engineProcess = null;
  schedulerProcess = null;
  collectProcess = null;
}

// === 失败通知（2026-10-19 全盘审查 P0-3）===
// 原来唯一的对外告警是 `scheduler.js` 的 sendAlert()，只走 Telegram，
// 而配置里的 tgBotToken 是空的 → 定时任务失败/被跳过时**没有任何人会知道**，
// 只能等用户自己打开界面翻日志（2026-10-18 掉登录空跑 24 分钟就是这么漏掉的）。
// 这里用系统通知（Windows 右下角 toast）补上，不依赖 TG。
let lastNotifyKey = '';
let lastNotifyAt = 0;
const NOTIFY_DEDUPE_MS = 10 * 60 * 1000;

function notifyFailure({ title = 'XNOWPost 任务异常', body = '', key = '' } = {}) {
  try {
    if (!electron.Notification || !electron.Notification.isSupported()) return false;
    const now = Date.now();
    const k = key || `${title}|${body}`;
    // 同一件事 10 分钟内只弹一次（一次失败会在日志里刷好几行）
    if (k === lastNotifyKey && now - lastNotifyAt < NOTIFY_DEDUPE_MS) return false;
    lastNotifyKey = k;
    lastNotifyAt = now;
    const n = new electron.Notification({ title, body: String(body || '').slice(0, 400) });
    n.on('click', () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      } catch (_) { /* 窗口已销毁 */ }
    });
    n.show();
    addLog('warning', `🔔 已弹系统通知：${title}`);
    return true;
  } catch (e) {
    addLog('warning', `⚠️ 系统通知发送失败：${e.message}`);
    return false;
  }
}

// 全局未捕获异常处理（写入日志文件，防止静默崩溃）
process.on('uncaughtException', (err) => {
  writeCrashLog('UNCAUGHT', err.stack || err.message);
  console.error('未捕获异常:', err);
});
process.on('unhandledRejection', (reason) => {
  writeCrashLog('UNHANDLED REJECTION', reason instanceof Error ? reason.stack : String(reason));
  console.error('未处理的 Promise 拒绝:', reason);
});

// 配置文件路径
const USER_CONFIG_PATH = () => path.join(DATA_DIR, 'config', 'user.json');

// 默认配置
const DEFAULT_CONFIG = {
  deepseekApiKey: '',
  // 模型与输出上限（空/0 = 用代码目录 config/default.json 里的默认值）。
  // 为什么要能配置：DeepSeek 会把老别名 `deepseek-chat` **静默路由到别的模型**
  // （2026-10-19 实测回包 model=deepseek-flash），旗舰是 `deepseek-v4-pro`。
  // 模型名写死在安装目录里的 default.json 里 = 用户想换只能改代码重新打包。
  deepseekModel: '',
  deepseekMaxTokens: 0,
  siliconflowApiKey: '',
  pexelsApiKey: '',
  tgBotToken: '',
  tgChannelId: '@your_channel',
  cdpEndpoint: 'http://localhost:9222',
  bitApiKey: '',
  browserType: 'foxprofile',   // foxprofile=指纹浏览器（默认） | bitbrowser=比特浏览器
  foxApiBase: 'http://127.0.0.1:8000/api/v1',   // FoxProfile 本地接口地址
  dataDir: '',  // 自定义数据存储目录（空=默认 %APPDATA%/xnowpost）
};

// 窗口引用
let mainWindow = null;
let engineProcess = null;
let collectProcess = null;     // 采集子进程（原先完全无追踪：无取消、无重入保护、退出不杀）
let schedulerProcess = null;   // 调度器子进程（提到这里，供 getEngineStatus 在模块作用域安全引用）
let engineCancelRequested = false;  // 用户是否主动取消了当前引擎运行（区分"失败"与"取消"）
let tray = null;
let isQuitting = false;
let logBuffer = [];
let schedulerRunning = false;  // 调度器是否正在执行引擎任务
let schedulerLastRun = '';     // 最近一次调度执行时间
let consecutiveFailures = 0;   // 引擎连续失败次数

// === 配置读写（带写锁防并发覆盖） ===
let configWriteLock = Promise.resolve();

function loadConfig() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH())) {
      return { ...DEFAULT_CONFIG, ...fs.readJsonSync(USER_CONFIG_PATH()) };
    }
  } catch (e) {
    console.error('读取配置失败:', e);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
  // 串行化：后一个等前一个完成再执行，防并发覆盖
  const currentLink = configWriteLock;
  const result = currentLink.then(() => {
    const current = loadConfig();
    const merged = { ...current, ...config };
    fs.ensureDirSync(path.dirname(USER_CONFIG_PATH()));
    fs.writeJsonSync(USER_CONFIG_PATH(), merged, { spaces: 2 });
    // 同步到环境变量供引擎使用
    process.env.DEEPSEEK_API_KEY = merged.deepseekApiKey || '';
    process.env.SILICONFLOW_API_KEY = merged.siliconflowApiKey || '';
    process.env.TG_BOT_TOKEN = merged.tgBotToken || '';
    process.env.PEXELS_API_KEY = merged.pexelsApiKey || '';
    process.env.TG_CHANNEL_ID = merged.tgChannelId || '';
    process.env.CDP_ENDPOINT = merged.cdpEndpoint || '';
    process.env.BIT_API_KEY = merged.bitApiKey || '';
    process.env.FOXPROFILE_API = merged.foxApiBase || '';
    return merged;
  });
  // 即使失败也不阻断后续保存链：前一个失败后下一个仍能正常写
  configWriteLock = result.catch(() => {});
  return result;
}

// === 日志记录（自动脱敏 + 持久化） ===
function sanitizeLogMessage(msg) {
  return msg.replace(/sk-[a-zA-Z0-9]{10,}/g, 'sk-***');
}

// === 密钥掩码（S4） ===
// 配置页只需要知道「配没配」和「是哪一把」，不需要明文。
// 明文交给渲染进程 = 前端任意 XSS 就能把全部 Key 一次带走。
// SECRET_FIELDS / maskSecret / isMaskedValue 已抽到 ./lib/sanitize.js

function writeLogToFile(entry) {
  try {
    const logDir = path.join(DATA_DIR, 'logs');
    const logFile = path.join(logDir, `app-${localDateStr()}.log`);
    fs.ensureDirSync(logDir);
    const line = `[${entry.time}] [${entry.type.toUpperCase()}] ${entry.message}\n`;
    fs.appendFileSync(logFile, line);
  } catch (e) { /* 日志文件写失败不影响主流程 */ }
}

// === 引擎结构化进度 ===
// engine:progress 原本是**死通道**：preload 暴露了 onProgress、Dashboard 也在消费，
// 但主进程从未 emit 过。这里从引擎 stdout 里解析阶段与 x/y 进度并推送。
function emitProgressFromLine(line) {
  let phase = '';
  if (line.includes('🎨')) phase = '图像';
  else if (line.includes('🔊')) phase = '配音';
  else if (line.includes('🎥') || line.includes('🎬')) phase = '合成';
  else if (line.includes('📤')) phase = '发布';
  else if (line.includes('💰')) phase = '完成';

  const m = line.match(/(\d+)\s*\/\s*(\d+)/);
  if (!phase && !m) return; // 没有可用信息就不打扰前端

  const payload = { label: line, phase, message: line };
  if (m) {
    payload.current = Number(m[1]);
    payload.total = Number(m[2]);
    payload.percent = payload.total > 0
      ? Math.min(100, Math.round((payload.current / payload.total) * 100))
      : 0;
  }
  if (payload.percent === undefined) payload.percent = 0;
  try { mainWindow?.webContents.send('engine:progress', payload); } catch (_) { /* 窗口已关 */ }
}

/**
 * 引擎输出行的日志级别判定。
 *
 * 以前是 `if (t.includes('失败')) addLog('error', ...)` —— 结果
 * 「🗣️ 先做配音（**失败**则一分钱不花在生图上）...」这条普通提示被标成 [ERROR]，
 * 用户以为出错了。关键词匹配不可靠，改成只看行首的图标标记。
 */
function classifyEngineLine(t) {
  if (/^❌/.test(t)) return 'error';
  if (/^⚠/.test(t)) return 'warning';
  if (/^✅/.test(t)) return 'success';
  if (/❌/.test(t)) return 'error';
  return 'info';
}

function addLog(type, message) {
  const entry = {
    time: new Date().toLocaleString('zh-CN'),
    type, // 'info' | 'success' | 'error' | 'warning'
    message: sanitizeLogMessage(message),
  };
  logBuffer.push(entry);
  if (logBuffer.length > 500) logBuffer.shift();
  writeLogToFile(entry);
  if (mainWindow) {
    mainWindow.webContents.send('engine:log', entry);
  }
}

// 窗口状态持久化（尺寸/位置）
const WIN_STATE_FILE = () => path.join(DATA_DIR, 'config', 'window-state.json');

/**
 * IPC 处理器登记表。
 *
 * 为什么要有它：AI 助手需要**直接调用**这些动作（跑运行、发布、采集…），
 * 而 `ipcMain.handle` 注册完就拿不到函数引用了。如果为了助手再写一份"怎么跑引擎"，
 * 两份实现迟早分叉（这就是 output-scan 当初三份实现的翻版）。
 * 所以：处理器一律用 `handle(channel, fn)` 注册，既注册又存进 ACTIONS，
 * 助手通过 `ACTIONS.get(channel)(null, ...args)` 复用**同一份实现**。
 * 注意：被复用的处理器不许依赖第一个参数 `event`（这几个都不依赖）。
 */
const ACTIONS = new Map();
function handle(channel, fn) {
  ACTIONS.set(channel, fn);
  ipcMain.handle(channel, fn);
  return fn;
}

function loadWinState() {
  try {
    if (fs.existsSync(WIN_STATE_FILE())) {
      const state = fs.readJsonSync(WIN_STATE_FILE());
      // 验证窗口位置在可见屏幕内，防拔掉外接屏后窗口飞出屏幕
      if (state.x !== undefined && state.y !== undefined) {
        const displays = screen.getAllDisplays();
        const onScreen = displays.some(d => {
          const { x, y, width, height } = d.bounds;
          return state.x >= x && state.x < x + width - 50 &&
                 state.y >= y && state.y < y + height - 50;
        });
        if (!onScreen) return null;
      }
      return state;
    }
  } catch (_) {}
  return null;
}

function saveWinState(win) {
  if (!win) return;
  try {
    const bounds = win.getBounds();
    const maximized = win.isMaximized();
    fs.ensureDirSync(path.dirname(WIN_STATE_FILE()));
    fs.writeJsonSync(WIN_STATE_FILE(), { ...bounds, maximized }, { spaces: 2 });
  } catch (_) {}
}

// === 窗口创建 ===
function createWindow() {
  const saved = loadWinState();
  mainWindow = new BrowserWindow({
    width: saved?.width || 1100,
    height: saved?.height || 750,
    x: saved?.x,
    y: saved?.y,
    minWidth: 900,
    minHeight: 600,
    title: app.isPackaged ? 'XNOWPost' : 'XNOWPost (开发版)',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--xnowpost-dev=${!app.isPackaged}`],
    },
    show: false,
    frame: true,
    autoHideMenuBar: true,
  });

  if (saved?.maximized) mainWindow.maximize();

  // 始终加载打包文件
  const distIndex = path.join(ROOT, 'dist', 'index.html');
  if (fs.existsSync(distIndex)) {
    mainWindow.loadFile(distIndex);
  } else if (!app.isPackaged) {
    // 仅开发版允许连 Vite 开发服务器
    mainWindow.loadURL('http://localhost:5173');
  } else {
    // 🔴 打包版绝不能回退到 http://localhost:5173：
    //    本机任意进程都能在 5173 上提供页面，而该页面会带着**完整的 preload 桥**运行，
    //    等于把 IPC 全权限交给一个不受控的本地页面。
    addLog('error', '❌ 未找到 dist/index.html，安装包不完整');
    mainWindow.loadURL(
      'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<html><head><meta charset="utf-8"><title>XNOWPost</title></head>' +
        '<body style="font-family:system-ui;padding:40px;line-height:1.8">' +
        '<h2>⚠️ 界面资源缺失</h2>' +
        '<p>未找到 <code>dist/index.html</code>，安装包可能不完整。</p>' +
        '<p>请到<a href="https://github.com/xiasummer740/xnowpost/releases">发布页</a>重新下载安装。</p>' +
        '</body></html>'
      )
    );
  }

  mainWindow.once('ready-to-show', () => {
    // 只在没有可信历史位置时才居中：
    // 原实现每次启动都强制 center()，导致窗口位置记忆完全失效。
    // loadWinState() 已经做过「是否落在可见屏幕内」的校验，返回 null 才需要居中。
    if (!saved) mainWindow.center();
    mainWindow.show();
  });

  // 窗口移动/调整大小时保存状态（防抖）
  let saveTimer = null;
  const onResizeOrMove = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWinState(mainWindow), 500);
  };
  mainWindow.on('resize', onResizeOrMove);
  mainWindow.on('move', onResizeOrMove);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 关闭时：有托盘则隐藏到系统栏，无托盘（真正退出）则正常关闭
  mainWindow.on('close', (event) => {
    saveWinState(mainWindow);
    // 杀掉运行中的引擎子进程（含 FFmpeg / Chromium 等孙进程）
    killProcessTree(engineProcess);
    engineProcess = null;
    if (tray && !isQuitting) {
      // 最小化到系统托盘，不真正关闭
      event.preventDefault();
      mainWindow.hide();
      addLog('info', '📌 XNOWPost 已最小化到系统托盘，右键托盘图标选择"退出"可完全关闭');
    }
    // isQuitting=true 时让默认关闭行为继续
  });

  // DevTools: 需要时按 F12 打开，不自动弹出
  // 如需自动打开，设环境变量 DEBUG=true
}

// === 系统托盘 ===
// 简单 CRC32（PNG 校验用）
function pngCRC32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makePNGChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type);
  const crcData = Buffer.concat([typeB, data]);
  const crc = pngCRC32(crcData);
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc);
  return Buffer.concat([len, typeB, data, crcB]);
}

// 程序化生成一个 32×32 绿色圆形托盘图标 PNG
function generateTrayIconPNG() {
  const { deflateSync } = _require('zlib');
  const W = 32, H = 32;
  const raw = Buffer.alloc((1 + W * 4) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const dx = x - W / 2 + 0.5, dy = y - H / 2 + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const offset = y * (1 + W * 4) + 1 + x * 4;
      if (dist <= 13) {
        // 绿色渐变圆
        const bright = 1 - dist / 16;
        raw[offset] = Math.round(0x22 * bright);     // R
        raw[offset + 1] = Math.round(0xCC * bright); // G
        raw[offset + 2] = Math.round(0x55 * bright); // B
        raw[offset + 3] = 0xFF;                       // A
      } else if (dist <= 14.5) {
        // 抗锯齿边缘
        const alpha = Math.round(255 * (1 - (dist - 13)));
        raw[offset] = 0x22; raw[offset + 1] = 0xCC; raw[offset + 2] = 0x55; raw[offset + 3] = alpha;
      } else {
        raw[offset + 3] = 0; // 完全透明
      }
    }
  }
  const deflated = deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA
  const chunks = [sig, makePNGChunk('IHDR', ihdr), makePNGChunk('IDAT', deflated), makePNGChunk('IEND', Buffer.alloc(0))];
  return Buffer.concat(chunks);
}

function createTray() {
  // 生成或加载托盘图标
  const iconDir = path.join(DATA_DIR, 'config');
  const iconPath = path.join(iconDir, 'tray-icon.png');
  let trayIcon;
  try {
    if (fs.existsSync(iconPath)) {
      trayIcon = nativeImage.createFromPath(iconPath);
    } else {
      fs.ensureDirSync(iconDir);
      const pngBuf = generateTrayIconPNG();
      fs.writeFileSync(iconPath, pngBuf);
      trayIcon = nativeImage.createFromPath(iconPath);
    }
  } catch (_) {
    // 极端 fallback：用 1×1 透明像素
    trayIcon = nativeImage.createEmpty();
  }
  // Windows 托盘图标需要 16×16 或 32×32
  trayIcon = trayIcon.resize({ width: 32, height: 32 });

  tray = new Tray(trayIcon);
  tray.setToolTip('XNOWPost');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        if (tray) { tray.destroy(); tray = null; }
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // 单击托盘图标：显示/聚焦窗口
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// readTextCapped / resolveSessionDir / mimeForImage / isValidDataDir
// 已抽到 ./lib/sanitize.js（那里能直接被单元测试导入）。
// 注意 resolveSessionDir 与 isValidDataDir 现在需要额外传入基准路径。

// === 引擎状态（模块作用域） ===
// ⚠️ 这两个函数原先声明在 setupIPC() **内部**，但 startScheduler() 的 stdout 回调里
//    会调用 pushEngineStatus() —— 那是模块作用域，拿不到 setupIPC 的局部函数 → ReferenceError。
//    异常发生在 stdout 回调内，会导致该 chunk 剩余日志全部丢失、'done' 关键字被漏看，
//    schedulerRunning 永久卡在 true（状态灯说谎）。因此必须提到模块作用域。
function getEngineStatus() {
  const config = loadConfig();
  return {
    configured: !!(config.deepseekApiKey || config.siliconflowApiKey),
    running: !!engineProcess,
    todayDir: getTodayDir(),
    schedulerRunning: !!schedulerProcess,
    schedulerActive: schedulerRunning,
    schedulerLastRun,
    recentErrors: logBuffer.filter(l => l.type === 'error').length,
    consecutiveFailures,   // 原先恒为 0（从未自增），现在真实反映连续失败次数
  };
}

function pushEngineStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('engine:status-push', getEngineStatus());
  } catch (_) { /* 窗口正在关闭 */ }
}

// === IPC 处理器 ===
function setupIPC() {
  // 诊断
  ipcMain.handle('ping', () => ({ ok: true, time: Date.now() }));

  // 获取配置
  ipcMain.handle('config:get', () => {
    const cfg = loadConfig();
    const out = { ...cfg };
    // 只回传掩码 + 「是否已配置」标记，明文的 Key 不再离开主进程
    for (const k of SECRET_FIELDS) {
      out[k] = maskSecret(cfg[k]);
      out['has' + k[0].toUpperCase() + k.slice(1)] = !!cfg[k];
    }
    // 版本号下发给界面：不显示版本号的话，用户根本分不清装的是哪个包（踩过）
    out.appVersion = app.getVersion();
    return out;
  });

  // 保存配置
  ipcMain.handle('config:save', async (event, config) => {
    try {
      const incoming = { ...(config || {}) };
      // 🔴 掩码代表「用户没动这一项」，必须丢弃：
      //    否则会把真实 Key 覆盖成 "sk-67a6****...3f2a" 这种废值。
      //    显式传空字符串仍然表示「用户主动清空」，予以保留。
      for (const k of SECRET_FIELDS) {
        if (isMaskedValue(incoming[k])) delete incoming[k];
      }
      // 数据目录必须是安装目录之外的绝对路径，否则拒绝保存
      if (!isValidDataDir(incoming.dataDir, ROOT)) {
        addLog('error', `拒绝保存非法的数据目录: ${incoming.dataDir}`);
        return { ok: false, message: '数据目录必须是「安装目录之外」的绝对路径' };
      }
      await saveConfig(incoming);
      addLog('success', '配置已保存');
      return { ok: true };
    } catch (e) {
      addLog('error', '保存配置失败: ' + e.message);
      return { ok: false, message: e.message };
    }
  });

  // 获取当前数据目录路径
  ipcMain.handle('config:getDataDir', () => {
    return { path: DATA_DIR };
  });

  // 选择新数据目录（打开文件夹选择器）
  // 粘贴的剪贴板图片：没有文件路径，只能由主进程落到数据目录再交给引擎
  ipcMain.handle('config:savePastedImage', async (_event, buffer, ext = 'png') => {
    try {
      const safeExt = ['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(String(ext).toLowerCase())
        ? String(ext).toLowerCase() : 'png';
      const dir = path.join(DATA_DIR, 'tmp', 'paste');
      fs.ensureDirSync(dir);
      const name = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${safeExt}`;
      const dest = path.join(dir, name);
      fs.writeFileSync(dest, Buffer.from(buffer));
      return { ok: true, path: dest };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // 选择"这次的截图"：多选图片文件，只用于本次生成，不写入配置
  ipcMain.handle('config:pickImages', async () => {
    try {
      const { dialog } = _require('electron');
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        title: '选择截图（按文件名顺序对应分镜）',
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
      });
      if (result.canceled || !result.filePaths.length) return { ok: false };
      return { ok: true, paths: result.filePaths };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('config:selectDir', async (_event, opts) => {
    try {
      const { dialog } = _require('electron');
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: (opts && opts.title) || '选择数据存储目录',
      });
      if (result.canceled || !result.filePaths.length) return { ok: false };
      return { ok: true, path: result.filePaths[0] };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // 迁移数据到新目录（复制所有数据 → 更新配置 → 需重启生效）
  ipcMain.handle('config:migrateData', async (_event, newDir) => {
    try {
      const oldDir = DATA_DIR;
      if (!newDir || !path.isAbsolute(newDir)) return { ok: false, message: '无效的目录路径' };
      if (oldDir === newDir) return { ok: false, message: '新目录与当前目录相同' };
      // 禁止迁到安装目录 —— 卸载/升级会连数据一起删掉
      const instDir = installDir();
      if (!isValidDataDir(newDir, instDir)) {
        return {
          ok: false,
          message: `不能迁到程序安装目录（${instDir}）里：卸载或升级会把数据一起删掉。\n` +
            `建议迁到**同级**文件夹，例如 ${path.join(path.dirname(instDir), 'XNOWPost-data')}，效果一样安全。`,
        };
      }

      // ⚠️ 源目录可能是目录联接（junction / 符号链接）。
      // fs-extra 的 copySync 用 lstat 判断类型，会把联接当成"文件"，
      // 于是报 "Cannot overwrite directory 'X' with non-directory 'Y'"（用户实测踩过）。
      // 必须先解析出真实路径再复制。
      let srcDir = oldDir;
      try {
        srcDir = fs.realpathSync(oldDir);
      } catch (_) { /* 解析失败就用原路径 */ }
      if (srcDir !== oldDir) {
        addLog('info', `ℹ️ 源目录是链接，按真实路径复制: ${srcDir}`);
      }

      addLog('info', `📦 开始迁移数据: ${oldDir} → ${newDir}`);

      // 1. 复制所有数据到新目录（排除无关目录）
      fs.ensureDirSync(newDir);
      const excludeDirs = new Set(['node_modules', '.git', '__pycache__', 'node']);
      fs.copySync(srcDir, newDir, {
        filter: src => !excludeDirs.has(path.basename(src)),
      });

      // 2. 读取旧配置，记录 dataDir 指向新位置
      const cfg = loadConfig(); // 从旧 DATA_DIR 读取
      cfg.dataDir = newDir;
      await saveConfig(cfg); // 写回旧位置（引导用）

      // 3. 也更新新目录下的配置
      const prevDataDir = DATA_DIR;
      DATA_DIR = newDir;
      const newCfg = loadConfig();
      newCfg.dataDir = newDir;
      await saveConfig(newCfg);
      DATA_DIR = prevDataDir;

      addLog('success', `✅ 数据已迁移到: ${newDir}，请重启应用`);
      return { ok: true, needsRestart: true };
    } catch (e) {
      addLog('error', '数据迁移失败: ' + e.message);
      return { ok: false, message: e.message };
    }
  });

  // 重启应用
  ipcMain.handle('app:restart', async () => {
    // app.exit(0) **不会**触发 before-quit，必须先手动收掉子进程：
    // 否则引擎/调度器/采集器会变孤儿继续跑；新实例还可能抢不到单实例锁而立即退出，
    // 用户看到的现象就是"点了重启，应用直接消失了"。
    isQuitting = true;
    killAllChildren();
    // 等 taskkill 落地再拉新实例
    await new Promise(r => setTimeout(r, 800));
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  // 引擎执行队列
  const engineQueue = [];
  let engineRunning = false;

  function doRunEngine(mode, topic, options = {}) {
    const args = mode === 'video' ? ['--video-only'] : mode === 'post' ? ['--post-only'] : [];
    if (topic) { args.push('--topic'); args.push(topic); }
    engineCancelRequested = false;   // 新任务开始，清掉上一次的取消标记
    addLog('info', `🚀 引擎启动 — 模式: ${mode}${topic ? ` | 主题: ${topic}` : ''}`);

    return new Promise((resolve) => {
      // 引擎脚本路径：安装版用解包目录，开发版用项目目录
      const engineRoot = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked')
        : ROOT;
      const scriptPath = path.join(engineRoot, 'src', 'index.js');
      addLog('info', `🚀 node ${scriptPath} ${args.join(' ')}`);
      // ELECTRON_RUN_AS_NODE → 让子进程以纯 Node.js 运行，不走 Chromium/GPU
      const proc = spawn(NODE_EXE, [scriptPath, ...args], {
        cwd: engineRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        // spawn 的 timeout 不生效，下方用 setTimeout 替代
        windowsHide: true,  // 不弹 CMD 窗口
        env: {
          ...process.env,
          XNOWPOST_DATA_DIR: DATA_DIR,  // 引擎输出目录与"打开输出目录"按钮一致
          // 本次生成的临时选项（不动用户持久配置）：
          //   配音语言、用户当场选的截图。用环境变量传给子进程，
          //   这样"这次生成"的选择不会污染 config/user.json。
          ...(options.voiceLang && options.voiceLang !== 'auto'
            ? { XNOWPOST_VOICE_LANG: options.voiceLang } : {}),
          ...(Array.isArray(options.images) && options.images.length
            ? { XNOWPOST_USER_IMAGES: JSON.stringify(options.images) } : {}),
        },
      });
      engineProcess = proc;
      try { pushEngineStatus(); } catch (_) { /* 窗口可能未就绪 */ }
      // 手动超时：spawn 的 timeout 不可靠，用 setTimeout 兜底。
      // 默认 45 分钟：一次 9 分镜视频要跑 DeepSeek 文案 + 9 张生图 + 9 段 edge-tts 配音
      // + 6 个平台的 FFmpeg 合成，15 分钟根本不够（会被中途杀掉）。
      // 需要时可用环境变量覆盖；发布流程的预算由 scheduler/发布器各自控制。
      const ENGINE_TIMEOUT = Number(process.env.XNOWPOST_ENGINE_TIMEOUT_MS) || 45 * 60 * 1000;
      let engineTimer = setTimeout(() => {
        if (!proc.killed) {
          addLog('error', `⏰ 引擎执行超时(${Math.round(ENGINE_TIMEOUT / 60000)}分钟)，强制终止`);
          // 必须连整棵进程树一起收，否则 FFmpeg / Chromium 会留下孤儿
          killProcessTree(proc);
        }
      }, ENGINE_TIMEOUT);
      let output = '';
      // stdout 半行缓冲。必须在 finish 之前声明 —— finish 会读它拼最后一行，
      // 声明在后面就形成 TDZ 隐患（一旦 finish 被同步调用即 ReferenceError）。
      let stdoutBuf = '';

      // error 与 close 都可能触发（已实测：先 ERROR ENOENT 再 CLOSE -4058）。
      // 没有 settled 标志时，两条分支都会清空 engineProcess 并调用 processQueue()，
      // 导致队列里的下一个任务与刚启动的任务并发跑，而且 engineProcess 指向错误的子进程，
      // 此后 engine:cancel / 关窗都杀不掉真正在跑的那个。
      let settled = false;
      const finish = (code, errorMessage) => {
        if (settled) return;
        settled = true;
        clearTimeout(engineTimer);
        // 只清理自己：如果引用已被新进程替换，不要把新引用抹掉
        if (engineProcess === proc) engineProcess = null;
        if (stdoutBuf.trim()) addLog('info', stdoutBuf.trim());
        // 用户主动取消不算失败：不计入连续失败次数，并把 cancelled 显式回传前端
        const cancelled = engineCancelRequested;
        if (cancelled) {
          addLog('warning', '⏹ 引擎已被用户取消');
        } else if (code === 0 && !errorMessage) {
          consecutiveFailures = 0;
          addLog('success', '✅ 引擎执行完成');
        } else {
          consecutiveFailures += 1;
          addLog('error', `${errorMessage || `引擎异常退出 (code: ${code})`}（连续失败 ${consecutiveFailures} 次）`);
        }
        try { pushEngineStatus(); } catch (_) { /* 窗口可能已关闭 */ }
        try { invalidateHistoryCache(); } catch (_) { /* 尚未初始化 */ }
        resolve(cancelled
          ? { ok: false, cancelled: true, message: '已取消' }
          : code === 0 && !errorMessage
            ? { ok: true, output }
            : { ok: false, message: errorMessage || `进程异常退出 (code: ${code})` });
        processQueue();
      };

      proc.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        output += chunk.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          emitProgressFromLine(t);
          addLog(classifyEngineLine(t), t);
        }
      });

      let stderrBuf = '';
      proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        output += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (t) addLog('warning', t);
        }
      });

      proc.on('close', (code) => finish(code));

      proc.on('error', (err) => {
        // error 之后 close 通常也会来（code -4058），靠 finish 里的 settled 保证只结算一次
        addLog('error', `引擎启动失败: ${err.message}`);
        finish(-1, `引擎启动失败: ${err.message}`);
      });
    });
  }

  function processQueue() {
    if (engineQueue.length === 0) { engineRunning = false; return; }
    engineRunning = true;
    const { mode, topic, options, resolve } = engineQueue.shift();
    const queueLeft = engineQueue.length;
    if (queueLeft > 0) addLog('info', `⏳ 队列还有 ${queueLeft} 个任务待执行`);
    doRunEngine(mode, topic, options || {}).then(resolve);
  }

  // 执行引擎（支持排队 + 用户主题）
  handle('engine:run', async (_event, mode = 'auto', topic = '', options = {}) => {
    if (engineRunning || engineProcess) {
      addLog('info', `⏳ 已加入队列（当前有任务运行中），完成后自动执行`);
      return new Promise((resolve) => {
        engineQueue.push({ mode, topic, options, resolve });
      });
    }
    engineRunning = true;
    return doRunEngine(mode, topic, options);
  });

  // 取消引擎
  ipcMain.handle('engine:cancel', () => {
    // 清空排队中的任务
    while (engineQueue.length > 0) {
      const item = engineQueue.shift();
      item.resolve({ ok: false, message: '已取消' });
    }
    if (engineProcess && !engineProcess.killed) {
      // 标记为「用户取消」——finish() 据此回报 cancelled 而不是失败
      engineCancelRequested = true;
      // 连整棵进程树一起收：只 kill 父进程会留下 FFmpeg / Chromium 孤儿，
      // 而 Windows 上 process.kill(-pid) 本来就失败（ESRCH）
      killProcessTree(engineProcess);
      engineProcess = null;
      engineRunning = false;
      consecutiveFailures = 0;   // 用户主动取消不算失败
      addLog('warning', '引擎已被用户取消（含子进程）');
      try { pushEngineStatus(); } catch (_) { /* ignore */ }
      return { ok: true, message: '已取消' };
    }
    return { ok: false, message: '没有运行中的引擎' };
  });

  // 获取历史日志（按日期）
  // 读取某一天的日志（应用 + 调度器，合并按时间排序）
  // 2026-10-19 用户反馈「运行日志只能看到这几行」：根因是这里只读 app-*.log 的尾部，
  // 而调度器日志（任务开始/登录/引擎输出/采集细节）根本没人读 —— 今天那 1269 行全白写了。
  ipcMain.handle('logs:history', async (_event, date) => {
    try {
      const logDir = path.join(DATA_DIR, 'logs');
      // 🔴 日期必须严格校验：原实现把渲染进程传来的字符串直接拼进路径，
      //    传 '../config/x' 就能读到 <DATA_DIR>/config/x.log，再深一层可越出数据目录读任意 *.log
      const dateStr = String(date || localDateStr());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return [];
      const readOne = (name, source) => {
        const f = path.join(logDir, name);
        if (!fs.existsSync(f)) return [];
        try {
          return parseLogText(readTextCapped(f), source);
        } catch (e) {
          console.error(`读取 ${name} 失败:`, e.message);
          return [];
        }
      };
      const appLines = readOne(`app-${dateStr}.log`, 'app');
      const schedLines = readOne(`scheduler-${dateStr}.log`, 'scheduler');
      return mergeLogLines([dropEchoedSchedulerLines(appLines), schedLines], LOG_LINE_LIMIT);
    } catch (e) {
      console.error('读取历史日志失败:', e.message);
      return [];
    }
  });

  // 获取日志（实时）：今天这一天「应用 + 调度器」合并后的尾部，
  // 而不是只给内存缓冲 —— 内存缓冲只有本次进程的 500 行，重启一次就「只剩这几行」了。
  ipcMain.handle('logs:get', () => {
    try {
      const today = localDateStr();
      const logDir = path.join(DATA_DIR, 'logs');
      const readOne = (name, source) => {
        const f = path.join(logDir, name);
        if (!fs.existsSync(f)) return [];
        try {
          return parseLogText(readTextCapped(f), source);
        } catch (_) {
          return [];
        }
      };
      const appLines = readOne(`app-${today}.log`, 'app');
      const schedLines = readOne(`scheduler-${today}.log`, 'scheduler');
      const merged = mergeLogLines([dropEchoedSchedulerLines(appLines), schedLines], LOG_LINE_LIMIT);
      if (merged.length) return merged;
    } catch (e) {
      console.error('读取今日日志失败:', e.message);
    }
    return logBuffer.slice(-500);
  });

  // 打开日志文件夹（用户在界面里点一下就能看到原始文件）
  ipcMain.handle('logs:openFolder', async () => {
    const dir = path.join(DATA_DIR, 'logs');
    fs.ensureDirSync(dir);
    const err = await shell.openPath(dir);
    return err ? { ok: false, message: err } : { ok: true, dir };
  });

  // 清空日志
  ipcMain.handle('logs:clear', () => {
    logBuffer = [];
    return { ok: true };
  });

  // ── 每个账号「最后一次发布成功」的时间 ─────────────────────────────
  // 数据源：`<数据目录>/data/publish-ledger.jsonl`（发布器每成功一次追加一行，带 env）+ `.published` 兜底。
  // 账号页要「发完立刻更新」，所以两层：① 监听账本文件变化 → webContents.send 推送；
  // ② 页面自己 6 秒轮询一次兜底（进程被杀/监听失效时也不会一直显示旧值）。
  let publishTimesCache = null;
  let publishTimesCacheTime = 0;
  const PUBLISH_TIMES_TTL = 5_000;

  function invalidatePublishTimes() {
    publishTimesCache = null;
    publishTimesCacheTime = 0;
  }

  function getPublishTimes() {
    const now = Date.now();
    if (publishTimesCache && (now - publishTimesCacheTime) < PUBLISH_TIMES_TTL) return publishTimesCache;
    try {
      publishTimesCache = {
        ok: true,
        latest: latestPublishByEnv(DATA_DIR),
        scannedAt: new Date().toISOString(),
      };
    } catch (e) {
      publishTimesCache = { ok: false, error: e.message, latest: {} };
    }
    publishTimesCacheTime = now;
    return publishTimesCache;
  }

  function pushPublishTimes() {
    try {
      const payload = getPublishTimes();
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('accounts:publishTimesUpdated', payload);
      }
    } catch (_) { /* 窗口还没建好就算了 */ }
  }

  ipcMain.handle('accounts:publishTimes', () => getPublishTimes());

  // 账本一被追加就立刻推送（fs.watchFile 也能捕获文件"从无到有"）
  try {
    const ledgerFile = path.join(DATA_DIR, 'data', 'publish-ledger.jsonl');
    fs.watchFile(ledgerFile, { interval: 1000 }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return;
      invalidatePublishTimes();
      pushPublishTimes();
    });
  } catch (_) { /* 监听失败不影响功能 */ }

  // 历史产出（30 秒缓存，避免频繁全量扫描）
  let historyCache = null;
  let historyCacheTime = 0;
  const HISTORY_CACHE_TTL = 30_000;

  // 生成/发布结束后主动失效，否则界面会继续显示 30 秒前的旧列表
  function invalidateHistoryCache() {
    historyCache = null;
    historyCacheTime = 0;
  }

  ipcMain.handle('history:list', () => {
    const now = Date.now();
    if (historyCache && (now - historyCacheTime) < HISTORY_CACHE_TTL) {
      return historyCache;
    }

    const outputDir = path.join(DATA_DIR, 'output');
    if (!fs.existsSync(outputDir)) { historyCache = []; historyCacheTime = now; return []; }

    // 整个扫描过程包在 try 里：单个损坏/无权限的目录不应让整个历史列表失败
    try {
      const dateDirs = fs.readdirSync(outputDir)
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .reverse();

      const history = [];
      for (const dateDir of dateDirs) {
        const datePath = path.join(outputDir, dateDir);
        const sessions = fs.readdirSync(datePath)
          .filter(s => fs.statSync(path.join(datePath, s)).isDirectory())
          .sort()
          .reverse();

        const items = [];
        for (const session of sessions) {
          const sp = path.join(datePath, session);
          const files = fs.readdirSync(sp);
          const hasVideo = files.some(f => f.endsWith('.mp4'));
          const hasPost = files.some(f => f.match(/p\d+_\d+\.png/));
          const txtFile = files.find(f => f === '文案.txt');
          let title = session;
          if (txtFile) {
            try {
              const txt = fs.readFileSync(path.join(sp, txtFile), 'utf-8');
              title = txt.split('\n')[0] || session;
            } catch (e) { /* 保留目录名当标题 */ }
          }
          // 从目录名提取时间（pm_1430 → 14:30）
          let time = '';
          const timeMatch = session.match(/(\d{2})(\d{2})$/);
          if (timeMatch) {
            const h = timeMatch[1], m = timeMatch[2];
            time = `${h}:${m}`;
          }
          items.push({
            id: session,
            title_zh: title.substring(0, 40),
            type: hasVideo ? 'video' : hasPost ? 'post' : 'unknown',
            status: 'ready',
            time,
            dir: sp,
            date: dateDir,
            session,
          });
        }
        if (items.length) history.push({ date: dateDir, items });
      }
      historyCache = history;
      historyCacheTime = now;
      return history;
    } catch (e) {
      addLog('error', `扫描历史产出失败: ${e.message}`);
      return [];
    }
  });

  // 获取最近一次生成费用
  ipcMain.handle('cost:latest', () => {
    const outputDir = path.join(DATA_DIR, 'output');
    if (!fs.existsSync(outputDir)) return null;

    try {
      // 找最新日期目录
      const dateDirs = fs.readdirSync(outputDir)
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort().reverse();
      if (!dateDirs.length) return null;

      const latestDate = path.join(outputDir, dateDirs[0]);
      const sessions = fs.readdirSync(latestDate)
        .filter(s => fs.statSync(path.join(latestDate, s)).isDirectory())
        .sort().reverse();
      if (!sessions.length) return null;

      // 找最新 session 的 cost.json
      const costFile = path.join(latestDate, sessions[0], 'cost.json');
      if (!fs.existsSync(costFile)) return null;

      return fs.readJsonSync(costFile);
    } catch (e) {
      return null;
    }
  });

  // 读取历史产出详情（文案 + 图片预览）
  ipcMain.handle('session:read', async (_event, rawDir) => {
    try {
      // 只接受 <DATA_DIR>/output/<date>/<session>，拒绝任意绝对路径
      const sessionDir = resolveSessionDir(rawDir, path.join(DATA_DIR, 'output'));
      if (!sessionDir) return null;

      const files = fs.readdirSync(sessionDir);

      // 读文案
      let text = '';
      const txtFile = files.find(f => f === '文案.txt');
      if (txtFile) text = fs.readFileSync(path.join(sessionDir, txtFile), 'utf-8');

      // 读图片（转 base64，限制 9 张 + 单张 2MB 避免卡 UI）
      // ⚠️ 顺序很重要：必须**先按体积过滤再截取 9 张**。
      //    原实现是先 slice(0,9) 再 filter，一张超大图会把有效图挤出前 9 个位置而整体丢掉。
      const images = files
        .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
        .map(f => ({ name: f, full: path.join(sessionDir, f) }))
        .filter(({ full }) => {
          try { return fs.statSync(full).size <= 2 * 1024 * 1024; } catch (_) { return false; }
        })
        .slice(0, 9)
        .map(({ name, full }) => ({
          name,
          data: `data:${mimeForImage(name)};base64,${fs.readFileSync(full).toString('base64')}`,
        }));

      // 检测视频
      const videoFile = files.find(f => f.endsWith('.mp4'));

      // 读 cost
      let cost = null;
      const costFile = files.find(f => f === 'cost.json');
      if (costFile) cost = fs.readJsonSync(path.join(sessionDir, costFile));

      return { text, images, videoFile: !!videoFile, cost };
    } catch (e) {
      return null;
    }
  });

  // 缩略图（轻量，只读第一张图，用于卡片预览）
  ipcMain.handle('session:thumbnail', async (_event, rawDir) => {
    try {
      // 同样只接受数据目录下的合法 session 目录，并限制单张体积
      const sessionDir = resolveSessionDir(rawDir, path.join(DATA_DIR, 'output'));
      if (!sessionDir) return null;
      const files = fs.readdirSync(sessionDir);
      const imgFile = files.find(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
      if (!imgFile) return null;
      const full = path.join(sessionDir, imgFile);
      if (fs.statSync(full).size > 8 * 1024 * 1024) return null;
      const buf = fs.readFileSync(full);
      return `data:${mimeForImage(imgFile)};base64,${buf.toString('base64')}`;
    } catch (e) {
      return null;
    }
  });

  // 打开输出目录
  ipcMain.handle('shell:openOutput', async () => {
    const dir = path.join(DATA_DIR, 'output');
    try {
      fs.ensureDirSync(dir);
      // shell.openPath 失败时返回错误字符串（不抛异常），原实现直接忽略 → 恒返回 ok
      const err = await shell.openPath(dir);
      if (err) {
        addLog('error', `打开输出目录失败: ${err}`);
        return { ok: false, message: err };
      }
      return { ok: true };
    } catch (e) {
      addLog('error', `打开输出目录失败: ${e.message}`);
      return { ok: false, message: e.message };
    }
  });

  // 导出 CSV
  ipcMain.handle('export:csv', async (_event, csvContent, defaultName) => {
    try {
      const { dialog } = _require('electron');
      if (typeof csvContent !== 'string') return { ok: false, message: '导出内容无效' };
      // 只取文件名部分，防止渲染进程用 ../ 之类的默认名把对话框引到别处
      const safeName = path.basename(String(defaultName || 'export.csv'));
      const result = await dialog.showSaveDialog({
        defaultPath: path.join(DATA_DIR, safeName),
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (!result.canceled && result.filePath) {
        fs.writeFileSync(result.filePath, csvContent, 'utf-8');
        return { ok: true, filePath: result.filePath };
      }
      return { ok: false, message: 'canceled' };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // 打开外部链接（浏览器跳转）
  ipcMain.handle('shell:openExternal', async (_event, url) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      await shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false, message: 'invalid url' };
  });

  // 获取引擎状态（getEngineStatus / pushEngineStatus 已提到模块作用域）
  ipcMain.handle('engine:status', () => getEngineStatus());

  // 获取引擎连续失败次数
  ipcMain.handle('engine:failureCount', () => consecutiveFailures);

  // 定时任务管理
  // 用函数而不是 const 快照：自定义数据目录切换后 DATA_DIR 会变
  const scheduleFile = () => path.join(DATA_DIR, 'config', 'schedule.json');

  // 自愈：历史配置里存在重复 id。dedupeJobIds 已抽到 ./lib/sanitize.js

  ipcMain.handle('schedule:list', () => {
    const file = scheduleFile();
    if (!fs.existsSync(file)) return [];
    try {
      return fs.readJsonSync(file);
    } catch (e) {
      // 🔴 不能静默返回 []：一旦返回空，前端下一次保存就会把**本可恢复**的配置覆盖成空。
      //    先把损坏文件改名留存，再上报错误。
      const backup = `${file}.corrupt-${Date.now()}`;
      try { fs.moveSync(file, backup, { overwrite: true }); } catch (_) { /* ignore */ }
      addLog('error', `定时任务配置解析失败，已备份为 ${path.basename(backup)}: ${e.message}`);
      return [];
    }
  });

  handle('schedule:save', async (_event, jobs) => {
    try {
      if (!Array.isArray(jobs)) return { ok: false, message: '定时任务数据格式错误' };
      const { jobs: fixed, changed } = dedupeJobIds(jobs);
      if (changed) addLog('warning', '⚠️ 检测到重复的定时任务 id，已自动修正');
      const file = scheduleFile();
      fs.ensureDirSync(path.dirname(file));
      fs.writeJsonSync(file, fixed, { spaces: 2 });
      return { ok: true, jobs: fixed, changed };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // 调度执行进度：给控制台看「现在在跑哪个闹钟、跑到哪一步、日志尾、接下来跑什么」
  //
  // 为什么不直接流式拿引擎输出：调度器用 spawnSync 跑引擎/发布器，子进程的 stdout
  // 要等它退出才一次性回放，所以运行中看不到引擎的实时日志。这里改用两个可靠信号：
  //   ① 调度器日志文件（`%APPDATA%/logs/scheduler-<日期>.log`）——开始/结束是实时写的；
  //   ② 今天最新会话目录里的产物文件（video.mp4 / .published / FAILED）——推断阶段。
  ipcMain.handle('schedule:progress', () => {
    const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地时区）
    const out = {
      schedulerRunning: !!schedulerProcess,
      active: false,
      current: null,
      next: [],
      tail: [],
      sessionDir: '',
      stage: '',
      stageText: '',
      lastRun: schedulerLastRun || '',
    };

    // ① 读调度器日志尾部
    const logFile = path.join(DATA_DIR, 'logs', `scheduler-${today}.log`);
    let lines = [];
    try {
      if (fs.existsSync(logFile)) {
        const st = fs.statSync(logFile);
        const start = Math.max(0, st.size - 400 * 1024);
        const fd = fs.openSync(logFile, 'r');
        const buf = Buffer.alloc(st.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        lines = buf
          .toString('utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
      }
    } catch (_) {
      /* 日志读不到不影响其它信息 */
    }
    out.tail = lines.slice(-12);

    const START_RE = /🚀\s*(.+?)\s*任务开始/;
    const END_RE = /(✅\s*.+?完成|❌\s*.+?失败|⚠️\s*.+?未确认|⏱️|⏭️\s*跳过|进程结束)/;
    let startIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (START_RE.test(lines[i])) {
        startIdx = i;
        break;
      }
    }
    if (startIdx >= 0) {
      const after = lines.slice(startIdx + 1);
      const ended = after.some((l) => END_RE.test(l));
      const m = lines[startIdx].match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s*🚀\s*(.+?)\s*任务开始/);
      if (!ended) {
        out.active = true;
        out.current = {
          label: (m ? m[2] : (lines[startIdx].match(START_RE) || [])[1] || '任务').trim(),
          startedAt: m ? m[1] : '',
          elapsedSec: m ? Math.max(0, Math.round((Date.now() - new Date(m[1].replace(' ', 'T')).getTime()) / 1000)) : 0,
        };
      }
    }

    // ② 今天最新会话目录 → 阶段
    try {
      const dayDir = path.join(DATA_DIR, 'output', today);
      if (fs.existsSync(dayDir)) {
        const dirs = fs
          .readdirSync(dayDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^(am|pm)_\d{4}$/.test(d.name))
          .map((d) => d.name)
          .sort()
          .reverse();
        if (dirs.length) {
          const name = dirs[0];
          const dir = path.join(dayDir, name);
          const has = (f) => fs.existsSync(path.join(dir, f));
          out.sessionDir = name;
          if (has('.published')) {
            out.stage = 'published';
            out.stageText = '已发布';
          } else if (has('FAILED')) {
            out.stage = 'failed';
            out.stageText = '发布失败';
          } else if (has('video.mp4')) {
            out.stage = 'publishing';
            out.stageText = '已产出视频，正在发布';
          } else {
            out.stage = 'generating';
            out.stageText = '生成中';
          }
        }
      }
    } catch (_) {
      /* 阶段推断失败就算了 */
    }

    // ③ 接下来的闹钟（按距现在多久排序）
    try {
      const jobs = fs.existsSync(scheduleFile()) ? fs.readJsonSync(scheduleFile()) : [];
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      out.next = (Array.isArray(jobs) ? jobs : [])
        .filter((j) => j && j.enabled && j.mode !== 'collect' && /^\d{1,2}:\d{2}$/.test(String(j.time || '')))
        .map((j) => {
          const [h, m] = String(j.time).split(':').map(Number);
          const t = h * 60 + m;
          let diff = t - nowMin;
          if (diff < 0) diff += 24 * 60;
          return { time: j.time, label: j.label || '', account: j.account || '', mode: j.mode, inMinutes: diff };
        })
        .sort((a, b) => a.inMinutes - b.inMinutes)
        .slice(0, 3);
    } catch (_) {
      /* 读不到就空着 */
    }

    return out;
  });

  /**
   * 在**主进程里**发一次 DeepSeek chat 请求。
   *
   * ⚠️ 绝不能用 OpenAI SDK（它的 fetch = undici）—— 2026-10-19 实测：
   *    同一把 Key、同一台机器，`node` 里用 SDK 连打 5 次全通（0.4~0.9s），
   *    但在 **Electron 主进程**里必然 0.6~0.8s 就 `Premature close`
   *    （连 `/models` 这种 GET 用 axios 都正常，只有 SDK 的请求挂）。
   *    所以这里走 axios（node:https），和硅基流动 / Pexels 的测试走同一套栈。
   * 返回 `{ model, usage }`；HTTP 4xx/5xx 也当作异常抛出，并带上 status 供文案分类。
   */
  async function deepSeekChatMain(apiKey, { model, maxTokens = 10, timeout = 30000, retries = 1 } = {}) {
    const axios = (await import('axios')).default;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await axios.post(
          'https://api.deepseek.com/chat/completions',
          { model, max_tokens: maxTokens, messages: [{ role: 'user', content: 'hi' }] },
          {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout,
            validateStatus: () => true,
          },
        );
        if (r.status >= 400) {
          const e = new Error(r.data?.error?.message || `HTTP ${r.status}`);
          e.status = r.status;
          throw e;
        }
        return { model: r.data?.model || model, usage: r.data?.usage || null };
      } catch (e) {
        lastErr = e;
        addLog('error', `DeepSeek 请求失败（第 ${attempt + 1} 次）：${e.name || 'Error'} ${e.message}`);
      }
    }
    throw lastErr;
  }

  // 模型列表 + 「当前请求的模型实际被路由到了哪个模型」
  // 背景（2026-10-19）：用户问"模型是最新的吗、会自动升级吗"。
  // 实测 `deepseek-chat` 这个老别名被服务端静默路由到 `deepseek-flash`，
  // 而 `/models` 只列出 flash 和 v4-pro —— 界面上必须能看见这件事。
  ipcMain.handle('ai:models', async () => {
    const config = loadConfig();
    const apiKey = String(config.deepseekApiKey || '').trim();
    const requested = String(config.deepseekModel || '').trim() || 'deepseek-chat';
    if (!apiKey) {
      return { ok: false, message: '请先填写 DeepSeek API Key 再刷新模型列表', models: [], requested, actual: '' };
    }
    const out = { ok: false, message: '', models: [], requested, actual: '', elapsedMs: 0 };
    try {
      const axios = (await import('axios')).default;
      const r = await axios.get('https://api.deepseek.com/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15000,
      });
      out.models = (r.data?.data || []).map((m) => String(m?.id || '')).filter(Boolean).sort();
      out.ok = true;
    } catch (e) {
      out.message = describeAiError(e, { provider: 'DeepSeek 模型列表' });
      return out;
    }
    // 再用一个极小的请求问出"实际跑的是哪个模型"（别名可能被服务端路由）
    const started = Date.now();
    try {
      const r = await deepSeekChatMain(apiKey, { model: requested, maxTokens: 1, retries: 1 });
      out.actual = r.model || requested;
      out.elapsedMs = Date.now() - started;
      out.message = out.actual !== requested
        ? `请求的 ${requested} 被服务端路由到 ${out.actual}（${(out.elapsedMs / 1000).toFixed(1)}s）`
        : `请求的 ${requested} 就是实际模型（${(out.elapsedMs / 1000).toFixed(1)}s）`;
    } catch (e) {
      out.message = describeAiError(e, { provider: 'DeepSeek 探测实际模型', elapsedMs: Date.now() - started, attempts: 2 });
    }
    return out;
  });

  // 测试 API 连接
  ipcMain.handle('config:test', async (_event, type, key) => {
    // 只接受真实 Key：配置页现在拿到的是掩码，
    // 掩码必须回退到已保存的配置，否则"测试连接"会拿着 sk-abcd****wxyz 去请求，必然失败。
    const config = loadConfig();
    const field = type === 'tg' ? 'tgBotToken' : type + 'ApiKey';
    const apiKey = (isMaskedValue(key) ? '' : (key || '')) || config[field] || '';

    if (type === 'deepseek') {
      if (!apiKey) return { ok: false, message: '请先填写 DeepSeek API Key' };
      const model = String(config.deepseekModel || '').trim() || 'deepseek-chat';
      const started = Date.now();
      try {
        // 30 秒 + 重试 1 次；用 axios 而不是 OpenAI SDK（原因见 deepSeekChatMain 注释）
        const r = await deepSeekChatMain(apiKey, { model, maxTokens: 10, timeout: 30000, retries: 1 });
        const elapsedMs = Date.now() - started;
        // ⚠️ 回包里的 model 才是**真正跑的那个模型**：别名可能被服务端路由到别的型号
        const actual = r.model || model;
        const routed = actual !== model ? `（请求 ${model}，实际由服务端路由到 ${actual}）` : '';
        return {
          ok: true,
          model: actual,
          requestedModel: model,
          elapsedMs,
          message: `DeepSeek 文案 API ✅ 连接成功 · 实际模型 ${actual}${routed} · ${(elapsedMs / 1000).toFixed(1)}s`,
        };
      } catch (err) {
        return {
          ok: false,
          message: describeAiError(err, { provider: 'DeepSeek', elapsedMs: Date.now() - started, attempts: 2 }),
        };
      }
    }

    if (type === 'siliconflow') {
      if (!apiKey) return { ok: false, message: '请先填写硅基流动 API Key' };
      const started = Date.now();
      try {
        // 测试生图 API
        const axios = (await import('axios')).default;
        const resp = await axios.post(
          'https://api.siliconflow.cn/v1/images/generations',
          { model: 'Kwai-Kolors/Kolors', prompt: 'test', image_size: '512x512', batch_size: 1, guidance_scale: 7.5 },
          { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 }
        );
        if (resp.status === 200) {
          return { ok: true, message: `硅基流动 生图 API ✅ 连接成功（模型: Kolors，${((Date.now() - started) / 1000).toFixed(1)}s）` };
        }
        return { ok: false, message: '硅基流动 ❌ HTTP ' + resp.status };
      } catch (err) {
        // 服务商给的业务错误优先（比如"余额不足"），否则用统一的人话翻译
        const biz = err.response?.data?.message;
        return {
          ok: false,
          message: biz
            ? `硅基流动 ❌ ${biz}`
            : describeAiError(err, { provider: '硅基流动', elapsedMs: Date.now() - started }),
        };
      }
    }

    if (type === 'tg') {
      if (!apiKey) return { ok: false, message: '请先填写 TG Bot Token' };
      try {
        const axios = (await import('axios')).default;
        const resp = await axios.get(`https://api.telegram.org/bot${apiKey}/getMe`, { timeout: 10000 });
        if (resp.data?.ok) {
          return { ok: true, message: `TG Bot ✅ @${resp.data.result.username} 连接成功` };
        }
        return { ok: false, message: 'TG ❌ Token 无效' };
      } catch (err) {
        return { ok: false, message: 'TG ❌ ' + (err.response?.data?.description || err.message) };
      }
    }

    if (type === 'pexels') {
      if (!apiKey) return { ok: false, message: '请先填写 Pexels API Key' };
      try {
        const axios = (await import('axios')).default;
        // 必须测**视频**接口：引擎用 /videos/search 取实拍片段，
        // 只测 /v1/search（图片）会出现"测试通过但出片仍无素材"的假绿。
        const resp = await axios.get('https://api.pexels.com/videos/search', {
          headers: { Authorization: apiKey },
          params: { query: 'business', per_page: 1, orientation: 'portrait' },
          timeout: 15000,
        });
        if (resp.status === 200) {
          const total = resp.data?.total_results || 0;
          return {
            ok: true,
            message: `Pexels 视频素材 ✅ 连接成功（竖屏可用 ${total.toLocaleString()} 条）`,
          };
        }
        return { ok: false, message: 'Pexels ❌ HTTP ' + resp.status };
      } catch (err) {
        const detail = err.response?.data?.error || err.response?.status === 401
          ? 'Key 无效或已过期（401）'
          : err.message;
        return { ok: false, message: 'Pexels ❌ ' + detail };
      }
    }

    return { ok: false, message: '未知测试类型: ' + type };
  });

  // ─────────────────────────────────────────────────────────────────────
  // AI 助手（P0 只读问答 + P1 受控写操作）
  //
  // 三条红线（改动前先读完 `.claude/PROGRESS.md` 的 1G 节）：
  //   ① 能力 = `electron/lib/assistant-tools.js` 里的白名单，没有「执行任意命令」这类工具；
  //   ② 写操作（改配置/改闹钟/跑任务/发布）必须用户点「执行」才落盘；
  //   ③ 每次工具调用写 `data/assistant-ledger.jsonl`，Key/密码走 redactDeep，永不进上下文。
  // 这里只做"怎么执行"，不做"能不能执行"（那是纯逻辑层的事，有单测守）。
  // ─────────────────────────────────────────────────────────────────────

  const assistantLedgerFile = () => path.join(DATA_DIR, 'data', 'assistant-ledger.jsonl');

  function assistantLedger(line) {
    try {
      fs.ensureDirSync(path.join(DATA_DIR, 'data'));
      fs.appendFileSync(assistantLedgerFile(), `${JSON.stringify(line)}\n`, 'utf-8');
    } catch (e) {
      addLog('error', `AI 助手审计写入失败：${e.message}`);
    }
  }

  /** 定时任务列表（供预览显示"旧的几点 → 新的几点"） */
  function readScheduleJobs() {
    try {
      const file = scheduleFile();
      return fs.existsSync(file) ? fs.readJsonSync(file) : [];
    } catch (_) {
      return [];
    }
  }

  /** 最近一次运行的 cost.json（和「历史」页同源） */
  function latestCostInfo() {
    const outputDir = path.join(DATA_DIR, 'output');
    try {
      if (!fs.existsSync(outputDir)) return null;
      const day = fs.readdirSync(outputDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()[0];
      if (!day) return null;
      const dayDir = path.join(outputDir, day);
      const session = fs.readdirSync(dayDir).filter((s) => {
        try { return fs.statSync(path.join(dayDir, s)).isDirectory(); } catch (_) { return false; }
      }).sort().reverse()[0];
      if (!session) return null;
      const costFile = path.join(dayDir, session, 'cost.json');
      if (!fs.existsSync(costFile)) return { date: day, session, note: '这次运行没有 cost.json' };
      return { date: day, session, ...fs.readJsonSync(costFile) };
    } catch (e) {
      return { note: `读不到花费：${e.message}` };
    }
  }

  /** 某天的采集证据（日报页黄条同源）：判断"今天到底采到没有" */
  function collectEvidence(date) {
    const dir = path.join(DATA_DIR, 'output', date);
    try {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter((f) => /^collect-\d{4}\.json$/.test(f))
        .sort()
        .map((f) => {
          try {
            const j = fs.readJsonSync(path.join(dir, f));
            return { at: f.replace(/^collect-|\.json$/g, ''), ok: j.ok, total: j.total, collected: j.collected, insufficient: j.insufficient };
          } catch (_) {
            return { at: f, ok: null };
          }
        });
    } catch (_) {
      return [];
    }
  }

  /** 下一个要跑的闹钟 */
  function nextEnabledJob() {
    const jobs = readScheduleJobs().filter((j) => j && j.enabled !== false);
    if (!jobs.length) return null;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const mins = jobs.map((j) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(j.time || ''));
      const t = m ? Number(m[1]) * 60 + Number(m[2]) : 0;
      return { job: j, t, delta: (t - nowMin + 1440) % 1440 };
    }).sort((a, b) => a.delta - b.delta);
    const n = mins[0];
    return n ? { id: n.job.id, time: n.job.time, label: n.job.label || n.job.mode, account: n.job.account, inMinutes: n.delta } : null;
  }

  /** 读日志尾部（调度器为主，应用日志补上应用自己的事件） */
  function readRecentLogs({ level = 'error', limit = 60 } = {}) {
    const date = localDateStr();
    const files = [
      path.join(DATA_DIR, 'logs', `scheduler-${date}.log`),
      path.join(DATA_DIR, 'logs', `app-${date}.log`),
    ];
    const lines = [];
    for (const f of files) {
      if (!fs.existsSync(f)) continue;
      try {
        const raw = fs.readFileSync(f, 'utf-8').split('\n');
        for (const line of raw) {
          const t = line.trim();
          if (!t) continue;
          if (level === 'error' && !/❌|Error:|FAILED|timed out|失败：/.test(t)) continue;
          if (level === 'warn' && !/⚠|🚫|warn/i.test(t)) continue;
          lines.push(t);
        }
      } catch (_) { /* 单个文件读不到不影响另一个 */ }
    }
    return lines.slice(-Math.min(Number(limit) || 60, 200));
  }

  /** 把失败会话的原始证据取出来（AI 分析失败原因用） */
  function readFailureEvidence({ date, session } = {}) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : localDateStr();
    const dayDir = path.join(DATA_DIR, 'output', day);
    const out = [];
    try {
      if (!fs.existsSync(dayDir)) return { date: day, failures: [], note: '这一天没有输出目录' };
      const sessions = fs.readdirSync(dayDir).filter((s) => {
        if (session && s !== session) return false;
        try { return fs.statSync(path.join(dayDir, s)).isDirectory(); } catch (_) { return false; }
      });
      for (const s of sessions) {
        const failedFile = path.join(dayDir, s, 'FAILED');
        if (!fs.existsSync(failedFile)) continue;
        let info = {};
        try { info = fs.readJsonSync(failedFile); } catch (_) { info = { note: 'FAILED 文件坏了' }; }
        let logTail = [];
        const logFile = path.join(dayDir, s, 'publish.log');
        if (fs.existsSync(logFile)) {
          try { logTail = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean).slice(-25); } catch (_) { logTail = []; }
        }
        out.push({
          session: s,
          published: info.published === true,
          stage: String(info.stage || info.publishStage || ''),
          reason: String(info.reason || '').slice(0, 400),
          logTail,
        });
      }
    } catch (e) {
      return { date: day, failures: out, note: e.message };
    }
    return { date: day, failures: out.slice(0, 6), total: out.length };
  }

  /** 数据日报：直接查 analytics.db（和日报页同一个库、同一张表） */
  async function dailyReportFor(date) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : localDateStr();
    const dbPath = path.join(DATA_DIR, 'data', 'analytics.db');
    if (!fs.existsSync(dbPath)) return { date: day, note: '还没有 analytics.db（从没采集过）', metrics: null };
    const { openDB } = await import('../src/db.js');
    const db = await openDB(dbPath, { readonly: true });
    try {
      const dates = db.all('SELECT DISTINCT date FROM daily_stats ORDER BY date DESC LIMIT 10').map((r) => r.date);
      const rows = db.all(
        'SELECT metric, SUM(value) AS total, COUNT(*) AS rows FROM daily_stats WHERE date = ? AND (platform IS NULL OR platform != \'\') GROUP BY metric',
        [day],
      );
      const metrics = {};
      for (const r of rows) metrics[r.metric] = r.total;
      return {
        date: day,
        availableDates: dates,
        metrics,
        note: Object.keys(metrics).length ? '' : '这一天库里没有数据（可能是没采集到，不代表 0）',
        collectEvidence: collectEvidence(day),
      };
    } finally {
      try { db.close(); } catch (_) { /* 关不掉不影响结果 */ }
    }
  }

  /** 执行一个工具（AI 说"要做什么"，这里负责"真的做"） */
  async function assistantExec(name, args = {}) {
    const today = localDateStr();
    const outDir = path.join(DATA_DIR, 'output');

    switch (name) {
      case 'get_status': {
        const st = getEngineStatus();
        const pub = buildPublishDay(today);
        let pendingCount = 0;
        let skipped = '';
        try {
          const r = scanUnpublished({ outputDir: outDir, today, onlyToday: true, maxCount: 0 });
          pendingCount = r.items.length;
          skipped = summarizeSkips(r.skipped || []);
        } catch (_) { /* 输出目录还没有 */ }
        return {
          ok: true,
          summary: `今天已发 ${pub.published} / 未确认 ${pub.unconfirmed} / 失败 ${pub.failed}，待发 ${pendingCount}`,
          engine: { running: st.running, configured: st.configured, consecutiveFailures: st.consecutiveFailures, recentErrors: st.recentErrors },
          scheduler: { running: st.schedulerRunning },
          today: { date: today, published: pub.published, unconfirmed: pub.unconfirmed, failed: pub.failed, sessions: pub.sessions },
          pendingCount,
          skipped,
          nextJob: nextEnabledJob(),
        };
      }
      case 'get_today_publish': {
        const pub = buildPublishDay(args.date || today);
        return { ok: true, summary: `${pub.date}：已发 ${pub.published} / 未确认 ${pub.unconfirmed} / 失败 ${pub.failed}（共 ${pub.sessions} 场）`, ...pub };
      }
      case 'get_pending': {
        const r = scanUnpublished({
          outputDir: outDir,
          today,
          onlyToday: args.includeOld === true ? false : true,
          maxCount: 0,
        });
        return {
          ok: true,
          summary: `待发 ${r.items.length} 条${args.includeOld === true ? '（含历史日期）' : '（只算当天）'}`,
          includeOld: args.includeOld === true,
          count: r.items.length,
          items: r.items.slice(0, 10).map((i) => ({ date: i.date, session: i.session, title: String(i.title || '').slice(0, 40) })),
          skipped: summarizeSkips(r.skipped || []),
        };
      }
      case 'get_schedule': {
        const jobs = readScheduleJobs()
          .filter((j) => (args.onlyEnabled ? j.enabled !== false : true))
          .map((j) => ({ id: j.id, time: j.time, mode: j.mode, label: j.label, account: j.account, enabled: j.enabled !== false }))
          .sort((a, b) => String(a.time).localeCompare(String(b.time)));
        const on = jobs.filter((j) => j.enabled).length;
        return { ok: true, summary: `共 ${jobs.length} 个闹钟，启用 ${on} 个`, jobs, nextJob: nextEnabledJob() };
      }
      case 'get_accounts': {
        // 复用账号页那条 IPC（同一份登录态判定，不另写一套）
        const r = await ACTIONS.get('accounts:list')(null);
        if (!r || r.ok === false) return { ok: false, error: r?.message || '读不到账号列表' };
        const rows = (r.accounts || r.list || []).map((a) => ({
          env: a.env,
          name: a.name || a.env,
          username: a.username || '',
          region: a.region || '',
          loggedIn: a.loggedIn,
          followers: a.followers,
          lastPublish: a.lastPublish || a.publishedAt || '',
          note: a.note || '',
        }));
        const out = rows.filter((a) => a.loggedIn === false);
        return {
          ok: true,
          summary: `${rows.length} 个账号${out.length ? `，其中 ${out.length} 个掉登录：${out.map((a) => a.env).join('、')}` : '，登录态都正常'}`,
          accounts: rows,
        };
      }
      case 'get_logs':
        return { ok: true, summary: `取了最近 ${readRecentLogs(args).length} 行日志`, lines: readRecentLogs(args) };
      case 'get_cost': {
        const c = latestCostInfo();
        return c ? { ok: true, summary: `最近一次（${c.date}/${c.session}）花费 ¥${c.total ?? c.cost ?? '?'}`, ...c } : { ok: true, summary: '还没有花费记录', cost: null };
      }
      case 'get_daily_report': {
        const d = await dailyReportFor(args.date);
        return { ok: true, summary: d.metrics && Object.keys(d.metrics).length ? `${d.date} 有数据` : `${d.date} 没采到数据`, ...d };
      }
      case 'explain_failures': {
        const e = readFailureEvidence(args);
        return {
          ok: true,
          summary: e.failures?.length ? `${e.date} 有 ${e.total ?? e.failures.length} 个失败会话` : `${e.date} 没有失败记录`,
          ...e,
        };
      }

      case 'update_config': {
        const v = validateConfigPatch(args.patch);
        if (!v.ok) return { ok: false, error: v.error };
        const config = loadConfig();
        const next = { ...config, ...v.patch };
        saveConfig(next);   // 与配置页「保存配置」同一份实现
        addLog('info', `🤖 AI 助手修改配置：${Object.keys(v.patch).join(', ')}${args.reason ? `（${args.reason}）` : ''}`);
        return { ok: true, summary: `已改 ${Object.keys(v.patch).join(', ')}`, applied: v.patch };
      }
      case 'schedule_action': {
        const jobs = readScheduleJobs();
        const idx = jobs.findIndex((j) => String(j.id) === String(args.id));
        if (idx < 0) return { ok: false, error: `没有 id=${args.id} 的定时任务（先用 get_schedule 查）` };
        const job = jobs[idx];
        if (args.op === 'delete') {
          jobs.splice(idx, 1);
        } else if (args.op === 'enable' || args.op === 'disable') {
          jobs[idx] = { ...job, enabled: args.op === 'enable' };
        } else if (args.op === 'update') {
          const patch = {};
          for (const k of ['time', 'mode', 'label', 'account', 'enabled', 'topic']) {
            if (args.patch && args.patch[k] !== undefined) patch[k] = args.patch[k];
          }
          if (patch.time && !/^\d{1,2}:\d{2}$/.test(String(patch.time))) return { ok: false, error: 'time 必须是 HH:MM' };
          jobs[idx] = { ...job, ...patch };
        } else {
          return { ok: false, error: `不支持的 op：${args.op}` };
        }
        const saved = await ACTIONS.get('schedule:save')(null, jobs);
        if (!saved || saved.ok === false) return { ok: false, error: saved?.message || '保存定时表失败' };
        addLog('info', `🤖 AI 助手${args.op === 'delete' ? '删除' : args.op === 'enable' ? '启用' : args.op === 'disable' ? '停用' : '修改'}定时任务 ${job.time} ${job.label || job.mode}`);
        return { ok: true, summary: `定时任务 ${job.time} 已${args.op === 'delete' ? '删除' : args.op === 'enable' ? '启用' : args.op === 'disable' ? '停用' : '修改'}`, jobs: saved.jobs?.length };
      }

      case 'run_engine': {
        // 不 await：一轮生成要 5~15 分钟，等它结束对话就卡死了
        Promise.resolve(ACTIONS.get('engine:run')(null, args.mode, args.topic || '', {})).catch((e) => {
          addLog('error', `AI 助手启动生成失败：${e.message}`);
        });
        addLog('info', `🤖 AI 助手启动${args.mode === 'text' ? '文案' : '视频'}生成${args.topic ? `（主题：${args.topic}）` : ''}`);
        return { ok: true, summary: `已启动${args.mode === 'text' ? '文案' : '视频'}生成，进度在控制台/日志页`, started: true };
      }
      case 'run_publish': {
        const maxCount = clampPublishCount(args.maxCount);
        Promise.resolve(ACTIONS.get('publish:run')(null, { maxCount, includeOld: args.includeOld === true })).catch((e) => {
          addLog('error', `AI 助手启动发布失败：${e.message}`);
        });
        addLog('info', `🤖 AI 助手启动发布（最多 ${maxCount} 条${args.includeOld ? '，含历史日期' : ''}）`);
        return { ok: true, summary: `已启动发布，最多 ${maxCount} 条`, started: true, maxCount };
      }
      case 'run_collect': {
        const list = String(args.accounts || '').split(',').map((x) => x.trim()).filter(Boolean);
        Promise.resolve(ACTIONS.get('collect:run')(null, list)).catch((e) => {
          addLog('error', `AI 助手启动采集失败：${e.message}`);
        });
        addLog('info', `🤖 AI 助手启动数据采集${list.length ? `（${list.join(',')}）` : ''}`);
        return { ok: true, summary: '已启动采集（约 2~3 分钟）', started: true };
      }
      default: {
        const def = getToolDef(name);
        return { ok: false, error: def ? `工具 ${name} 还没接执行器` : `未知工具 ${name}` };
      }
    }
  }

  /** 问模型（axios，不能用 OpenAI SDK：主进程里它的 fetch 必挂，见 CLAUDE.md） */
  async function assistantCallModel(messages) {
    const config = loadConfig();
    const apiKey = String(config.deepseekApiKey || '').trim();
    if (!apiKey) throw new Error('还没配 DeepSeek API Key（配置页 → DeepSeek）');
    const model = String(config.deepseekModel || '').trim() || 'deepseek-chat';
    const maxTokens = Number(config.deepseekMaxTokens) || 4096;
    const axios = (await import('axios')).default;
    const started = Date.now();
    const r = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model,
        messages,
        tools: publicTools(),
        tool_choice: 'auto',
        max_tokens: maxTokens,
        temperature: 0.3,
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 120000,
        validateStatus: () => true,
      },
    );
    if (r.status >= 400) {
      const e = new Error(r.data?.error?.message || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    const message = r.data?.choices?.[0]?.message || {};
    const usage = r.data?.usage || null;
    if (usage) {
      addLog('info', `🤖 AI 助手：${r.data?.model || model} ${Date.now() - started}ms · ${usage.prompt_tokens}+${usage.completion_tokens} tokens`);
    }
    return { message, usage };
  }

  let assistantSession = null;
  let assistantSessionKey = '';

  /** 会话按「日期 + 模型 + 版本」重建（日期/模型变了，系统提示里的口径也要跟着变） */
  function ensureAssistantSession() {
    const config = loadConfig();
    const today = localDateStr();
    const model = String(config.deepseekModel || '').trim() || 'deepseek-chat';
    const key = `${today}|${model}|${app.getVersion()}`;
    if (assistantSession && assistantSessionKey === key) return assistantSession;
    const systemPrompt = buildSystemPrompt({ today, appVersion: app.getVersion(), model });
    assistantSession = createAssistantSession({
      callModel: assistantCallModel,
      exec: assistantExec,
      systemPrompt,
      previewCtx: () => ({ config: loadConfig(), jobs: readScheduleJobs() }),
      onLedger: assistantLedger,
      log: (m) => addLog('info', m),
    });
    assistantSessionKey = key;
    addLog('info', `🤖 AI 助手就绪（模型 ${model}，工具 ${publicTools().length} 个）`);
    return assistantSession;
  }

  handle('assistant:send', async (_event, text) => {
    const r = await ensureAssistantSession().send(text);
    return r;
  });
  handle('assistant:answer', async (_event, approvals) => {
    const r = await ensureAssistantSession().answer(approvals);
    return r;
  });
  handle('assistant:state', () => ensureAssistantSession().snapshot());
  handle('assistant:reset', () => {
    const s = ensureAssistantSession();
    s.reset();
    return { ok: true };
  });

  // 测试指纹浏览器（FoxProfile）连接
  // 默认只做只读检查（健康 + 环境列表 + 账号里配的环境名是否存在），
  // 只有显式传 opts.openEnv === true 才真的启动环境（有副作用）。
  ipcMain.handle('config:testBit', async (_event, apiKey, opts = {}) => {
    const wantOpen = !!(opts && opts.openEnv === true);
    const base = String(loadConfig().foxApiBase || 'http://127.0.0.1:8000/api/v1').replace(/\/+$/, '');
    try {
      const axios = (await import('axios')).default;

      // ① 健康检查
      let health;
      try {
        health = (await axios.get(`${base}/health`, { timeout: 5000 })).data;
      } catch (e) {
        const hint = e.code === 'ECONNREFUSED'
          ? 'FoxProfile 没在运行，请先双击桌面「FoxProfile 指纹浏览器」'
          : e.message;
        addLog('error', `❌ FoxProfile 连接失败: ${hint}`);
        return { ok: false, message: `FoxProfile ❌ ${hint}` };
      }
      addLog('info', `🔍 FoxProfile 健康检查: ${JSON.stringify(health)}`);

      // ② 环境列表
      const profiles = ((await axios.get(`${base}/profiles`, { timeout: 10000 })).data)?.profiles || [];
      addLog('info', `🔍 环境 ${profiles.length} 个: ${profiles.map((p) => p.name).join(', ') || '无'}`);
      if (!profiles.length) {
        return { ok: false, message: 'FoxProfile 已连接，但一个环境也没有。请先在 FoxProfile 里新建环境。' };
      }

      // ③ 校验配置里的环境名是否真实存在
      const envs = (loadConfig().accounts || [])
        .map((a) => String(a.browserEnv || a.bitEnvId || '').trim())
        .filter(Boolean);
      const known = new Set(profiles.map((p) => p.name));
      const good = [...new Set(envs)].filter((n) => known.has(n));
      const bad = [...new Set(envs)].filter((n) => !known.has(n));
      for (const b of bad) addLog('warning', `  ⚠️ 配置里的环境名不存在: ${b}`);

      if (!wantOpen) {
        const allNames = profiles.map((p) => p.name).join(', ');
        if (good.length) {
          let running = [];
          try {
            running = ((await axios.get(`${base}/browser`, { timeout: 8000 })).data)?.running || [];
          } catch (_) { /* 忽略 */ }
          const parts = [
            `FoxProfile ✅ 已连接`,
            `${profiles.length} 个环境`,
            `已配置 ${good.length} 个（${good.join(', ')}）`,
          ];
          if (running.length) parts.push(`当前运行中 ${running.length} 个`);
          if (bad.length) parts.push(`⚠️ 有 ${bad.length} 个环境名不存在: ${bad.join(', ')}`);
          return {
            ok: true,
            message: parts.join('，'),
            profiles: profiles.map((p) => p.name),
            envs: good,
            badEnvs: bad,
          };
        }
        if (bad.length) {
          return {
            ok: false,
            message: `FoxProfile 已连接，但配置的环境名都不存在（${bad.join(', ')}）。现有环境: ${allNames}`,
            profiles: profiles.map((p) => p.name),
            badEnvs: bad,
          };
        }
        return {
          ok: true,
          message: `FoxProfile ✅ 已连接，${profiles.length} 个环境可用（${allNames}），但还没给账号指定环境`,
          profiles: profiles.map((p) => p.name),
        };
      }

      // ④ 显式要求打开：真的启动一个环境
      const target = good[0] || profiles[0].name;
      try {
        await axios.post(`${base}/browser/${encodeURIComponent(target)}/launch?wait=true`, {}, { timeout: 180000 });
        addLog('info', `✅ 环境 ${target} 已打开`);
        return { ok: true, message: `FoxProfile ✅ 环境 ${target} 已打开`, env: target };
      } catch (e) {
        addLog('error', `❌ 打开环境 ${target} 失败: ${e.message}`);
        return { ok: false, message: `FoxProfile 可连接，但打开环境 ${target} 失败: ${e.message}` };
      }
    } catch (err) {
      return { ok: false, message: 'FoxProfile ❌ ' + err.message };
    }
  });

  // 列出 FoxProfile 环境（配置页下拉用）
  ipcMain.handle('config:foxProfiles', async () => {
    const base = String(loadConfig().foxApiBase || 'http://127.0.0.1:8000/api/v1').replace(/\/+$/, '');
    try {
      const axios = (await import('axios')).default;
      const [p, b] = await Promise.all([
        axios.get(`${base}/profiles`, { timeout: 10000 }),
        axios.get(`${base}/browser`, { timeout: 8000 }).catch(() => ({ data: { running: [] } })),
      ]);
      const running = new Set((b.data && b.data.running) || []);
      const list = (p.data?.profiles || []).map((x) => ({
        name: x.name,
        running: running.has(x.name),
        proxy: x.proxy || '',
      }));
      return { ok: true, list, base };
    } catch (e) {
      const hint = e.code === 'ECONNREFUSED' ? 'FoxProfile 未运行' : e.message;
      return { ok: false, message: hint, list: [] };
    }
  });


  // ─────────────────── 账号页（批量登录可视化） ───────────────────
  // 登录逻辑只有一份：scripts/tk-login-batch.mjs，界面只是把它 spawn 起来并读 stdout，
  // 避免「界面一套、命令行一套」的最后不一致。
  const LOGIN_STATES = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'];
  const loginScriptPath = () =>
    app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'tk-login-batch.mjs')
      : path.join(ROOT, 'scripts', 'tk-login-batch.mjs');
  const syncScriptPath = () =>
    app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'tk-profile-sync.mjs')
      : path.join(ROOT, 'scripts', 'tk-profile-sync.mjs');
  const editScriptPath = () =>
    app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'tk-profile-edit.mjs')
      : path.join(ROOT, 'scripts', 'tk-profile-edit.mjs');
  const profilesFile = () => path.join(DATA_DIR, 'data', 'account-profiles.json');
  const avatarFile = (env) => path.join(DATA_DIR, 'data', 'avatars', `${env}.jpg`);
  const readProfiles = () => {
    try {
      return JSON.parse(fs.readFileSync(profilesFile(), 'utf8')) || {};
    } catch (_) {
      return {};
    }
  };
  // 收件箱 / 截图 / 备份 / 报告统一放到数据目录：装在 Program Files 里也能写，升级不丢
  const accountDirs = () => ({
    inbox: path.join(DATA_DIR, 'import', 'accounts'),
    shots: path.join(DATA_DIR, 'output', 'login-shots'),
    backups: path.join(DATA_DIR, 'backups', 'cookies'),
    reports: path.join(DATA_DIR, 'output'),
  });
  const envForLoginChild = () => {
    const d = accountDirs();
    return {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      XNOWPOST_INBOX: d.inbox,
      XNOWPOST_SHOTS: d.shots,
      XNOWPOST_BACKUPS: d.backups,
      XNOWPOST_REPORTS: d.reports,
    };
  };
  const accountsStateFile = () => path.join(DATA_DIR, 'data', 'env-accounts.json');
  // FoxProfile 环境数据根目录（/profiles 返回的 data_dir 优先，这里只是兜底）
  const FOX_DATA_DIR = () => process.env.FOXPROFILE_DATA || 'E:/software/FoxProfile/camoufox_data';
  const readAccountsState = () => {
    try {
      return JSON.parse(fs.readFileSync(accountsStateFile(), 'utf8')) || {};
    } catch (_) {
      return {};
    }
  };
  let loginChild = null;
  let syncChild = null;
  let editChild = null;

  // 账号列表：环境 · 用户名 · 登录态 · 出口 IP · 是否运行
  handle('accounts:list', async () => {
    const cfg = loadConfig();
    const base = String(cfg.foxApiBase || 'http://127.0.0.1:8000/api/v1').replace(/\/+$/, '');
    const state = readAccountsState();
    const profileMap2 = readProfiles();
    try {
      const axios = (await import('axios')).default;
      const [p, b] = await Promise.all([
        axios.get(`${base}/profiles`, { timeout: 10000 }),
        axios.get(`${base}/browser`, { timeout: 8000 }).catch(() => ({ data: { running: [] } })),
      ]);
      const running = new Set((b.data && b.data.running) || []);
      const profileMap = new Map();
      for (const x of p.data?.profiles || []) profileMap.set(x.name, x);

      const cfgAccounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
      const envSet = new Set([
        ...cfgAccounts.map((a) => String(a.bitEnvId || a.browserEnv || '').toUpperCase()).filter(Boolean),
        ...profileMap.keys(),
      ]);
      const envs = [...envSet].sort();
      // 诊断快照：界面显示「0 个环境」时先看这个文件，能立刻分清是主进程没拿到
      // FoxProfile 数据、还是渲染层没拿到 IPC 结果。
      const debug = { base, profiles: profileMap.size, cfgAccounts: cfgAccounts.length, envs: envs.length };
      try {
        fs.ensureDirSync(path.join(DATA_DIR, 'data'));
        fs.writeFileSync(
          path.join(DATA_DIR, 'data', '_accounts-debug.json'),
          JSON.stringify({ at: new Date().toISOString(), ok: true, ...debug }, null, 2),
        );
      } catch (_) {
        /* 诊断文件写不进去不影响功能 */
      }

      // 登录态直接读环境的 cookie 库（毫秒级）。
      // 不要用 GET /profiles/{env}/cookies 来判断：那个接口每调用一次约 4 秒
      // （FoxProfile 会拉起进程导出），10 个环境要 40 秒，界面等不起。
      let DatabaseSync = null;
      try {
        ({ DatabaseSync } = await import('node:sqlite'));
      } catch (_) {
        DatabaseSync = null; // 老版本 Node 没有这个模块，退回「未知」
      }

      const readCookieState = (prof, env) => {
        const dir = prof.data_dir || path.join(FOX_DATA_DIR(), env);
        const dbFile = path.join(dir, 'cookies.sqlite');
        const out = { cookies: 0, loggedIn: null, lastActive: '', note: '' };
        if (!fs.existsSync(dbFile)) {
          out.note = '没有 cookie 库';
          return out;
        }
        try {
          const stat = fs.statSync(dbFile);
          out.lastActive = stat.mtime.toISOString();
        } catch (_) {
          /* 忽略 */
        }
        if (!DatabaseSync) {
          out.note = 'cookie 库读不了';
          return out;
        }
        try {
          const db = new DatabaseSync(dbFile, { readOnly: true });
          try {
            const row = db
              .prepare(
                `SELECT COUNT(*) AS total,
                        SUM(CASE WHEN name IN ('sessionid','sessionid_ss','sid_tt','sid_guard') THEN 1 ELSE 0 END) AS session
                   FROM moz_cookies WHERE host LIKE '%tiktok%'`,
              )
              .get();
            out.cookies = Number(row?.total || 0);
            out.loggedIn = Number(row?.session || 0) > 0;
            if (!out.loggedIn) out.note = '需登录';
          } finally {
            db.close();
          }
        } catch (e) {
          out.note = 'cookie 库被占用';
        }
        return out;
      };

      const list = envs.map((env) => {
        const acc = cfgAccounts.find((a) => String(a.bitEnvId || a.browserEnv || '').toUpperCase() === env) || {};
        const st = state[env] || {};
        const prof = profileMap.get(env) || {};
        const info = profileMap2[env] || {};
        const item = {
          env,
          username: info.username || acc.username || st.username || '',
          nickname: info.nickname || '',
          // 邮箱优先用本地导入的完整邮箱；TikTok 接口给的是 r***1@outlook.com 这种脱敏串
          email: st.email || acc.email || info.email || '',
          password: st.password || acc.password || '',
          emailPassword: st.emailPassword || acc.emailPassword || '',
          region: info.region || st.region || acc.region || '',
          followers: info.followers || '',
          following: info.following || '',
          likes: info.likes || '',
          verified: !!info.verified,
          createTime: info.createTime || '',
          profileAt: info.fetchedAt || '',
          avatarAt: info.fetchedAt || '',
          hasAvatar: !!info.avatarFile && fs.existsSync(info.avatarFile),
          proxy: prof.proxy || '',
          exists: profileMap.has(env),
          running: running.has(env),
          loggedIn: null,
          cookies: 0,
          lastActive: '',
          note: '',
        };
        if (!item.exists) {
          item.note = '环境不存在';
          return item;
        }
        const ck = readCookieState(prof, env);
        item.cookies = ck.cookies;
        item.lastActive = ck.lastActive;
        item.note = ck.note;
        // 正在运行的环境 cookie 库被锁，但既然能跑就按已登录处理
        item.loggedIn = item.running ? true : ck.loggedIn;
        if (item.running && !item.cookies) item.note = '运行中';
        return item;
      });
      return { ok: true, base, list, inbox: accountDirs().inbox, debug };
    } catch (e) {
      const hint = e.code === 'ECONNREFUSED' ? 'FoxProfile 未运行' : e.message;
      try {
        fs.ensureDirSync(path.join(DATA_DIR, 'data'));
        fs.writeFileSync(
          path.join(DATA_DIR, 'data', '_accounts-debug.json'),
          JSON.stringify({ at: new Date().toISOString(), ok: false, message: hint }, null, 2),
        );
      } catch (_) {
        /* 忽略 */
      }
      return { ok: false, message: hint, list: [] };
    }
  });

  // 选账号文件
  ipcMain.handle('accounts:pickFile', async () => {
    const r = await electron.dialog.showOpenDialog(mainWindow, {
      title: '选择账号文件（用户名｜密码｜邮箱｜邮箱密码｜2FA密钥｜地区）',
      properties: ['openFile'],
      filters: [{ name: '账号文件', extensions: ['txt', 'csv'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // 打开收件箱目录
  ipcMain.handle('accounts:openInbox', async () => {
    const d = accountDirs();
    fs.ensureDirSync(d.inbox);
    await shell.openPath(d.inbox);
    return { ok: true, inbox: d.inbox };
  });

  // 跑批量登录（流式回传日志）
  ipcMain.handle('accounts:run', async (event, opts = {}) => {
    if (loginChild) return { ok: false, message: '已有登录任务在进行中' };
    const script = loginScriptPath();
    if (!fs.existsSync(script)) return { ok: false, message: `找不到登录脚本：${script}` };
    const args = [script];
    if (opts.file) args.push('--file', String(opts.file));
    else args.push('--auto');
    if (opts.dryRun) args.push('--dry-run');
    if (opts.force) args.push('--force');
    if (opts.only) args.push('--only', String(opts.only).toUpperCase());
    if (opts.gap) args.push('--gap', String(opts.gap));
    if (opts.captchaWait) args.push('--captcha-wait', String(opts.captchaWait));

    const send = (type, text) => {
      try {
        mainWindow?.webContents.send('accounts:progress', { type, text });
      } catch (_) {
        /* 窗口已关 */
      }
    };
    send('start', `启动登录：${args.slice(1).join(' ')}`);

    const child = spawn(process.execPath, args, {
      cwd: app.isPackaged ? process.resourcesPath : ROOT,
      env: envForLoginChild(),
      windowsHide: true,
    });
    loginChild = child;

    const pump = (stream) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.replace(/\r$/, '');
          if (t.trim()) send('line', t);
        }
      });
    };
    pump(child.stdout);
    pump(child.stderr);

    const code = await new Promise((resolve) => {
      child.on('close', (c) => resolve(c ?? -1));
      child.on('error', (e) => {
        send('line', `进程启动失败：${e.message}`);
        resolve(-1);
      });
    });
    loginChild = null;
    send('done', String(code));
    return { ok: code === 0, code };
  });

  // 复制到系统剪贴板（渲染进程里 navigator.clipboard 在某些上下文不可靠，走主进程最稳）
  ipcMain.handle('accounts:copy', (_e, text) => {
    try {
      const { clipboard } = _require('electron');
      clipboard.writeText(String(text ?? ''));
      return { ok: true };
    } catch (e) {
      return { ok: false, message: String(e.message || e) };
    }
  });

  /**
   * 导入账号文件里的凭据（用户名/密码/邮箱/地区）到状态文件。
   * 只读文件、不登录 —— 界面上要显示并复制密码，就必须先把这些字段落盘。
   * 格式：用户名｜密码｜邮箱｜邮箱密码｜2FA密钥｜地区（兼容半角 | / 制表符 / 逗号）
   */
  ipcMain.handle('accounts:import', async (_e, file) => {
    try {
      if (!file || !fs.existsSync(file)) return { ok: false, message: '找不到账号文件' };
      const raw = fs.readFileSync(file, 'utf8');
      const rows = [];
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || /^[#/]|用户名|username|账号密码/i.test(t)) continue;
        const parts = t
          .split(/[｜|,\t]/)
          .map((s) => s.trim())
          .filter((s) => s !== '');
        if (parts.length < 2) continue;
        const [username, password, email, emailPassword, totpSecret, region] = parts;
        if (!username || !password) continue;
        rows.push({ username, password, email: email || '', emailPassword: emailPassword || '', totpSecret: totpSecret || '', region: region || '' });
      }
      if (!rows.length) return { ok: false, message: '文件里没解析出账号（第一列用户名、第二列密码）' };

      const state = readAccountsState();
      const envOf = (n) => `TK${String(n).padStart(2, '0')}`;
      const used = new Set(Object.keys(state).filter((k) => state[k] && state[k].username));
      const taken = new Set([...used].map((e) => (state[e].username || '').toLowerCase()));
      const mapping = [];
      rows.forEach((row, i) => {
        const env = envOf(i + 1);
        // 用户名已经登记过的环境保持不变（别把 TK03 的资料写到 TK01 上）
        let target = env;
        for (const [e, v] of Object.entries(state)) {
          if ((v.username || '').toLowerCase() === row.username.toLowerCase()) {
            target = e;
            break;
          }
        }
        state[target] = {
          ...(state[target] || {}),
          username: row.username,
          password: row.password,
          email: row.email,
          emailPassword: row.emailPassword,
          // 2FA 密钥必须落盘（2026-10-19 审查发现：这里以前解析了却**没写**，
          // 于是账号文件一删、密钥就再也找不回来，掉登录后无法重登）
          totpSecret: row.totpSecret || (state[target] || {}).totpSecret || '',
          region: row.region || (state[target] || {}).region || '',
          at: new Date().toISOString(),
        };
        mapping.push({ env: target, username: row.username });
      });
      fs.mkdirSync(path.dirname(accountsStateFile()), { recursive: true });
      fs.writeFileSync(accountsStateFile(), JSON.stringify(state, null, 2));
      return { ok: true, count: rows.length, mapping };
    } catch (e) {
      return { ok: false, message: String(e.message || e) };
    }
  });

  // 头像：读本地 jpg 转 data URI（渲染进程不用开 file:// 权限，也不依赖外网 CDN）
  ipcMain.handle('accounts:avatar', (_e, env) => {
    try {
      const info = readProfiles()[env];
      const file = (info && info.avatarFile) || avatarFile(env);
      if (!fs.existsSync(file)) return null;
      const buf = fs.readFileSync(file);
      if (!buf.length) return null;
      const ext = path.extname(file).toLowerCase() === '.png' ? 'png' : 'jpeg';
      return `data:image/${ext};base64,${buf.toString('base64')}`;
    } catch (_) {
      return null;
    }
  });

  // 拉取账号资料（头像/昵称/粉丝/关注/赞/注册时间）。和登录一样 spawn 脚本 + 流式回传。
  ipcMain.handle('accounts:syncProfiles', async (_event, opts = {}) => {
    if (syncChild) return { ok: false, message: '资料拉取正在进行中' };
    const script = syncScriptPath();
    if (!fs.existsSync(script)) return { ok: false, message: `找不到脚本：${script}` };
    const args = [script];
    if (opts.only) args.push('--only', String(opts.only).toUpperCase());
    if (opts.stale) args.push('--stale', String(opts.stale));
    if (opts.gap != null) args.push('--gap', String(opts.gap));
    if (opts.gap == null) args.push('--gap', '3');

    const send = (type, text) => {
      try {
        mainWindow?.webContents.send('accounts:progress', { type, text });
      } catch (_) {
        /* 窗口已关 */
      }
    };
    send('start', `拉取资料：${args.slice(1).join(' ')}`);

    const child = spawn(process.execPath, args, {
      cwd: app.isPackaged ? process.resourcesPath : ROOT,
      env: envForLoginChild(),
      windowsHide: true,
    });
    syncChild = child;

    const pump = (stream) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.replace(/\r$/, '');
          if (t.trim()) send('line', t);
        }
      });
    };
    pump(child.stdout);
    pump(child.stderr);

    const code = await new Promise((resolve) => {
      child.on('close', (c) => resolve(c ?? -1));
      child.on('error', (e) => {
        send('line', `进程启动失败：${e.message}`);
        resolve(-1);
      });
    });
    syncChild = null;
    send('done', String(code));
    return { ok: code === 0, code };
  });

  // 选一张图片（头像）
  ipcMain.handle('accounts:pickImage', async (event) => {
    const { dialog, BrowserWindow } = _require('electron');
    const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow || undefined;
    try {
      const r = await dialog.showOpenDialog(owner, {
        title: '选择头像图片',
        buttonLabel: '用这张',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      return { ok: true, path: r.filePaths[0], name: path.basename(r.filePaths[0]) };
    } catch (e) {
      return { ok: false, message: String(e.message || e) };
    }
  });

  // 把选中的图片读成 data URI 给界面做预览（渲染进程没有 file:// 权限）
  ipcMain.handle('accounts:imagePreview', (_e, file) => {
    try {
      if (!file || !fs.existsSync(file)) return { ok: false, message: '文件不存在' };
      const st = fs.statSync(file);
      if (st.size > 16 * 1024 * 1024) return { ok: false, message: '图片太大（>16MB）' };
      const ext = path.extname(file).toLowerCase();
      const mime = ext === '.png' ? 'png' : ext === '.webp' ? 'webp' : 'jpeg';
      const buf = fs.readFileSync(file);
      return { ok: true, uri: `data:image/${mime};base64,${buf.toString('base64')}`, name: path.basename(file), size: st.size };
    } catch (e) {
      return { ok: false, message: String(e.message || e) };
    }
  });

  /**
   * 批量/单个修改账号资料（头像 / 名字 / 用户名 / 简介）。
   * 界面把每个环境要写的最终值算好传进来，这里只负责落成 job 文件并 spawn 脚本。
   */
  ipcMain.handle('accounts:editProfiles', async (_event, opts = {}) => {
    if (editChild) return { ok: false, message: '资料修改任务正在进行中' };
    const jobs = Array.isArray(opts.jobs) ? opts.jobs.filter((j) => j && j.env) : [];
    if (!jobs.length) return { ok: false, message: '没有要修改的账号' };
    const script = editScriptPath();
    if (!fs.existsSync(script)) return { ok: false, message: `找不到脚本：${script}` };

    const workDir = path.join(DATA_DIR, 'data', 'edit-jobs');
    fs.mkdirSync(workDir, { recursive: true });
    const jobFile = path.join(workDir, `job-${Date.now()}.json`);
    fs.writeFileSync(jobFile, JSON.stringify({ dryRun: !!opts.dryRun, jobs }, null, 2));

    const send = (type, text) => {
      try {
        mainWindow?.webContents.send('accounts:progress', { type, text });
      } catch (_) {
        /* 窗口已关 */
      }
    };
    send('start', `修改资料：${jobs.length} 个环境${opts.dryRun ? '（演练，不保存）' : ''}`);

    const args = [script, '--job', jobFile, '--gap', String(opts.gap ?? 4)];
    if (opts.dryRun) args.push('--dry-run');

    const child = spawn(process.execPath, args, {
      cwd: app.isPackaged ? process.resourcesPath : ROOT,
      env: envForLoginChild(),
      windowsHide: true,
    });
    editChild = child;

    const pump = (stream) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.replace(/\r$/, '');
          if (t.trim()) send('line', t);
        }
      });
    };
    pump(child.stdout);
    pump(child.stderr);

    const code = await new Promise((resolve) => {
      child.on('close', (c) => resolve(c ?? -1));
      child.on('error', (e) => {
        send('line', `进程启动失败：${e.message}`);
        resolve(-1);
      });
    });
    editChild = null;
    send('done', String(code));
    return { ok: code === 0, code };
  });

  ipcMain.handle('accounts:cancel', () => {
    if (!loginChild && !syncChild && !editChild) return { ok: false, message: '没有正在进行的任务' };
    for (const c of [loginChild, syncChild, editChild]) {
      if (!c) continue;
      try {
        c.kill();
      } catch (_) {
        /* 已退出 */
      }
    }
    return { ok: true };
  });

  // 备份 cookie（换机器 / 环境坏了可直接导入恢复，不用重登）
  // 2026-10-19 审查：原来的实现先 ensureDir 再请求，全部失败时只留下**空目录**、
  // 日志里一个字都没有 → 用户以为备份好了，其实 0/10 环境。
  // 现在：只在真有结果时建目录；没有 sessionid 视为失败；逐个环境打 ✅/❌；14 天自动清。
  ipcMain.handle('accounts:backup', async (_e, envs) => {
    const cfg = loadConfig();
    const base = String(cfg.foxApiBase || 'http://127.0.0.1:8000/api/v1').replace(/\/+$/, '');
    const axios = (await import('axios')).default;
    const day = localDateStr();
    const dir = path.join(accountDirs().backups, day);
    const targets = Array.isArray(envs) && envs.length ? envs : (cfg.accounts || []).map((a) => a.bitEnvId);
    const out = [];
    const gotCookies = {};
    const SESSION_NAMES = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'];
    for (const env of targets) {
      if (!env) continue;
      try {
        const r = await axios.get(`${base}/profiles/${env}/cookies`, {
          params: { format: 'json' },
          timeout: 12000,
        });
        if (!Array.isArray(r.data)) throw new Error('返回格式不对');
        if (!r.data.length) throw new Error('cookie 是空的（这个环境没登录？）');
        const hasSession = r.data.some((c) => c && SESSION_NAMES.includes(String(c.name)));
        if (!hasSession) throw new Error('没有 sessionid，导出了也恢复不了登录态');
        fs.ensureDirSync(dir);
        const file = path.join(dir, `${env}.json`);
        fs.writeFileSync(file, JSON.stringify(r.data, null, 2));
        const bytes = fs.statSync(file).size;
        if (!bytes) throw new Error('写出来是 0 字节');
        gotCookies[env] = r.data;
        out.push({ env, ok: true, count: r.data.length, bytes });
        addLog('success', `✅ 备份 ${env} cookies（${r.data.length} 项，${(bytes / 1024).toFixed(1)} KB）`);
      } catch (e) {
        out.push({ env, ok: false, message: String(e.message || e) });
        addLog('error', `❌ 备份 ${env} cookies 失败：${e.message}`);
      }
    }
    // 导出的 cookie 同时并进今天的加密凭据包（明文那份留在 backups/cookies/<日期>/，14 天清掉）
    if (Object.keys(gotCookies).length) autoBackupSecrets({ cookies: gotCookies });
    pruneBackupDateDirs(accountDirs().backups, 'cookie 备份');
    const okCount = out.filter((x) => x.ok).length;
    addLog(
      okCount ? 'info' : 'warning',
      `${okCount ? '📦' : '⚠️'} cookie 备份完成：${okCount}/${out.length} 个环境成功${okCount ? '' : '（全部失败，看看环境是否已启动/已登录）'}`,
    );
    return { ok: true, dir, out };
  });

  // 启动 / 停止单个环境（窗口顶到前台，方便人工拖滑块）
  // ── 环境窗口标题带环境名（见 scripts/env-title-watch.ps1）─────────────
  // 用户实测痛点：手动开两个环境后，窗口标题/任务栏全是 TikTok 页面标题，
  // 分不清哪个窗口是 TK04、哪个是 TK05。
  // 用常驻 PowerShell 看护进程改窗口标题（SetWindowText），而不是往页面注入：
  // Firefox 的窗口标题跟随**前台标签页**，注入打不到它；强行 select 又会切走用户的标签页。
  let envTitleWatcher = null;

  function startEnvTitleWatcher() {
    try {
      if (envTitleWatcher && !envTitleWatcher.killed) return;
      const dir = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : ROOT;
      const script = path.join(dir, 'scripts', 'env-title-watch.ps1');
      if (!fs.existsSync(script)) {
        addLog('warning', `找不到窗口标题看护脚本: ${script}`);
        return;
      }
      envTitleWatcher = spawn(
        'powershell.exe',
        ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, '-IntervalSec', '2', '-ParentPid', String(process.pid)],
        { windowsHide: true, stdio: 'ignore', detached: false },
      );
      envTitleWatcher.on('error', (e) => addLog('warning', `窗口标题看护进程启动失败: ${e.message}`));
      envTitleWatcher.on('exit', () => { envTitleWatcher = null; });
    } catch (e) {
      addLog('warning', `窗口标题看护进程异常: ${e.message}`);
    }
  }

  app.on('will-quit', () => {
    try {
      if (envTitleWatcher) envTitleWatcher.kill();
    } catch (_) { /* 已经退了 */ }
    envTitleWatcher = null;
  });

  startEnvTitleWatcher();


  ipcMain.handle('accounts:launch', async (_e, env, action = 'launch') => {
    const cfg = loadConfig();
    const base = String(cfg.foxApiBase || 'http://127.0.0.1:8000/api/v1').replace(/\/+$/, '');
    try {
      const axios = (await import('axios')).default;
      const url =
        action === 'stop'
          ? `${base}/browser/${encodeURIComponent(env)}/stop`
          : `${base}/browser/${encodeURIComponent(env)}/launch?wait=true&focus=true`;
      const r = await axios.post(url, null, { timeout: action === 'stop' ? 30000 : 180000 });
      return { ok: true, data: r.data };
    } catch (e) {
      return { ok: false, message: String(e.message || e) };
    }
  });

  // 获取待发布内容列表
  // 待发布列表（界面展示用）：走 src/output-scan.js 统一实现，
  // 这样"列表里有什么"和"发布器会发什么"永远是同一套规则（以前是三份不同的实现）。
  ipcMain.handle('publish:pending', () => {
    const outDir = path.join(DATA_DIR, 'output');
    if (!fs.existsSync(outDir)) return [];
    const { pending } = scanUnpublished({
      outputDir: outDir,
      today: localDateStr(),
      onlyToday: false,   // 展示全部（含老会话），但要标出来
      maxCount: 0,
    });
    return pending;
  });

  // 发布单条内容（抽出来，便于批量发布与单条隔离失败）
  async function publishOne(item, { envId, apiKey, budgetMs }) {
    const { publishToTikTok } = await import('../src/publisher/tiktok.js');
    const files = fs.readdirSync(item.path);
    const videoFile = files.find(f => f.endsWith('.mp4'));
    if (!videoFile) return { ok: false, message: '没有可用于发布的 mp4' };

    addLog('info', `  🎬 视频: ${videoFile}`);
    const url = await publishToTikTok({
      sessionPath: item.path,
      videoFile: path.join(item.path, videoFile),
      imageFiles: [],
      titleFile: path.join(item.path, '文案.txt'),
      envId,
      apiKey,
      budgetMs,   // 发布器用它给内部等待循环设上限，避免被宿主中途杀掉
    });

    // 标记已发布：tiktok.js 在「确认点到 Post 按钮」时已写过该标记，
    // 这里只做兜底。⚠️ 兜底一律写成 **未确认** ——
    // 发布器返回值正常却没有任何标记，说明无法证明真的点到过按钮，
    // 写成「成功」等于又造一个假成功（P0-3 的成因）。
    const publishedFile = path.join(item.path, '.published');
    if (!fs.existsSync(publishedFile)) {
      fs.writeJsonSync(publishedFile, {
        publishedAt: new Date().toISOString(),
        platform: 'tiktok',
        url: url || '',
        confirmed: false,
        note: 'post-clicked-unconfirmed',
        unconfirmedReason: '发布器未写入标记，主进程兜底写为未确认',
      }, { spaces: 2 });
    }
    let marker = {};
    try { marker = fs.readJsonSync(publishedFile); } catch (_) { /* ignore */ }
    // P2-5 新语义：confirmed === false = 「点过 Post 但结果未确认」。
    // 这不是成功 —— 但也不能重试（会重复上传），必须交给人确认。
    if (marker.confirmed === false) {
      addLog('warning', `  ⚠️ 已点击发布按钮但结果未确认（${marker.unconfirmedReason || '未知原因'}）—— 不再重试，请人工核对`);
      return { ok: false, unconfirmed: true, message: '已点击发布但结果未确认，请人工核对' };
    }
    addLog('success', `  ✅ 发布成功 (标记于 ${marker.publishedAt || '未知'}${marker.url ? `, ${marker.url}` : ''})`);
    return { ok: true, url };
  }

  // 手动触发发布
  handle('publish:run', async (_event, opts = {}) => {
    const started = Date.now();
    // 发布预算：一条视频从上传到确认公开最长可能超过 30 分钟。
    // 原实现宿主超时只有 15 分钟 → 发布中途被杀、比特窗口残留、.published 未写 → 下轮重复上传。
    const budgetMs = Number(opts?.budgetMs) || Number(process.env.XNOWPOST_PUBLISH_TIMEOUT_MS) || 40 * 60 * 1000;
    // 每轮发布条数上限：积压几十条时一次全推出去，容易被判定为批量营销。
    // 默认 3 条，可用 opts.maxCount 或环境变量覆盖（0/负数=不限）。
    const envMax = Number(process.env.XNOWPOST_PUBLISH_MAX_PER_RUN);
    const defaultMax = Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_PER_RUN;
    const reqMax = Number(opts?.maxCount);
    const maxCount = Number.isFinite(reqMax) && reqMax > 0 ? reqMax : defaultMax;
    try {
      addLog('info', `📤 手动发布开始（预算 ${Math.round(budgetMs / 60000)} 分钟）...`);
      const config = loadConfig();
      const envId = String(config.accounts?.[0]?.browserEnv || config.accounts?.[0]?.bitEnvId || '').trim();
      const apiKey = config.bitApiKey || '';

      if (!envId) {
        addLog('error', '❌ 未配置指纹浏览器环境名，请在配置页设置账号');
        return { ok: false, message: '未配置指纹浏览器环境名' };
      }

      const outDir = path.join(DATA_DIR, 'output');
      if (!fs.existsSync(outDir)) return { ok: true, published: 0 };

      // 扫描走 src/output-scan.js（唯一实现）：默认只发当天、跳过 FAILED、跳过已发布/未确认，
      // 老的积压会话只在显式 --any-date / includeOld 时才进候选（2026-10-19 P0-1）。
      const { items: candidates, skipped: skippedRows } = scanUnpublished({
        outputDir: outDir,
        today: localDateStr(),
        onlyToday: opts?.includeOld === true ? false : true,
        maxCount: 0,
      });
      const unpublished = candidates;
      if (opts?.includeOld === true) {
        addLog('warning', '⚠️ 本次允许发布非当天的旧会话（includeOld=true），请确认内容仍然有效');
      }

      if (skippedRows.length) {
        // 积压几十条时会有一堆 old-date（旧日期）/published，按原因聚合成一行，
        // 只把"需要人管"的明细（未确认 / 合成失败 / 标记损坏）逐条打出来。
        addLog('info', `⏭️ 跳过 ${skippedRows.length} 条：${summarizeSkips(skippedRows)}`);
        const needAttention = skippedRows.filter((s) => ['unconfirmed', 'failed-synthesize', 'failed-broken'].includes(s.reason));
        for (const s of needAttention.slice(0, 8)) {
          addLog('warning', `   · ${s.date}/${s.session}: ${s.detail || s.reason}`);
        }
        if (needAttention.length > 8) addLog('warning', `   · …另有 ${needAttention.length - 8} 条同类，见「运行日志」`);
      }

      if (unpublished.length === 0) {
        addLog('info', '📭 没有未发布的内容');
        return { ok: true, published: 0 };
      }

      // 🔴 原先这里写死 unpublished[0]，所以「发布全部」实际只发 1 条。
      const todo = maxCount === Infinity ? unpublished : unpublished.slice(0, maxCount);
      addLog('info', `📋 待发布 ${unpublished.length} 条，本轮处理 ${todo.length} 条`);

      let published = 0;
      const failures = [];
      for (const item of todo) {
        const remaining = budgetMs - (Date.now() - started);
        if (remaining <= 60_000) {
          addLog('warning', `⏰ 发布预算不足（剩余 ${Math.round(remaining / 1000)}s），本轮提前结束；剩余条目下轮继续（未写 .published 会自动重试）`);
          break;
        }
        addLog('info', `📤 发布: ${item.date}/${item.session}`);
        try {
          const r = await publishOne(item, { envId, apiKey, budgetMs: remaining });
          if (r.ok) published += 1;
          else failures.push(`${item.session}: ${r.message}`);
        } catch (err) {
          // 单条失败不影响后续；.published 未写，下轮会自动重试
          failures.push(`${item.session}: ${err.message}`);
          addLog('error', `  ❌ 发布失败: ${err.message}`);
        }
      }

      invalidateHistoryCache();
      invalidatePublishTimes();
      // 推送一次最新发布时间：账号页不用等下一次轮询
      pushPublishTimes();
      if (failures.length) {
        addLog('warning', `⚠️ 本轮成功 ${published} 条，失败 ${failures.length} 条`);
        notifyFailure({
          title: `XNOWPost 手动发布：成功 ${published} 条，失败 ${failures.length} 条`,
          body: failures.slice(0, 3).join('\n'),
          key: `publish-run|${failures.length}|${failures[0] || ''}`,
        });
        return { ok: published > 0, published, failures, message: `${failures.length} 条失败` };
      }
      return { ok: true, published };
    } catch (err) {
      addLog('error', `❌ 发布失败: ${err.message}`);
      notifyFailure({ title: 'XNOWPost 手动发布失败', body: err.message, key: `publish-run|${err.message}` });
      return { ok: false, message: err.message };
    }
  });

  // 手动触发采集（可选指定账号列表）
  handle('collect:run', async (_event, accounts) => {
    try {
      // 🔴 重入保护：原实现完全无追踪，连点几次就会并发跑多个采集器，
      //    抢同一个浏览器环境、互相覆盖写 analytics.db。
      if (collectProcess) {
        addLog('warning', '采集已在进行中，忽略本次请求');
        return { ok: false, message: '采集已在进行中' };
      }

      const list = Array.isArray(accounts) ? accounts.filter(a => typeof a === 'string') : [];
      addLog('info', `📊 手动采集开始...${list.length ? ' (账号: ' + list.join(', ') + ')' : ''}`);

      return await new Promise((resolve) => {
        const engineRoot = app.isPackaged
          ? path.join(process.resourcesPath, 'app.asar.unpacked')
          : ROOT;
        const scriptPath = path.join(engineRoot, 'src', 'collector', 'index.js');

        const args = [scriptPath];
        if (list.length) args.push('--accounts', list.join(','));

        const proc = spawn(NODE_EXE, args, {
          cwd: engineRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            XNOWPOST_DATA_DIR: DATA_DIR,
          },
        });
        collectProcess = proc;

        // 采集超时兜底（spawn 的 timeout 选项不可靠，且原先完全没设）
        const COLLECT_TIMEOUT = Number(process.env.XNOWPOST_COLLECT_TIMEOUT_MS) || 30 * 60 * 1000;
        const collectTimer = setTimeout(() => {
          addLog('error', `⏰ 采集超时(${Math.round(COLLECT_TIMEOUT / 60000)}分钟)，强制终止`);
          killProcessTree(proc);
        }, COLLECT_TIMEOUT);

        // error 与 close 都可能触发，必须只结算一次
        let settled = false;
        const finish = (code, errorMessage) => {
          if (settled) return;
          settled = true;
          clearTimeout(collectTimer);
          if (collectProcess === proc) collectProcess = null;
          invalidateHistoryCache();
          if (code === 0 && !errorMessage) {
            addLog('success', '✅ 数据采集完成');
            resolve({ ok: true });
          } else {
            const msg = errorMessage || `进程异常退出 (code: ${code})`;
            addLog('error', `采集失败: ${msg}`);
            resolve({ ok: false, message: msg });
          }
        };

        let stdoutBuf = '';
        proc.stdout.on('data', (chunk) => {
          stdoutBuf += chunk.toString();
          const lines = stdoutBuf.split('\n');
          stdoutBuf = lines.pop() || '';
          for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            if (t.includes('❌') || t.includes('失败')) addLog('error', t);
            else if (t.includes('✅') || t.includes('完成')) addLog('success', t);
            else addLog('info', t);
          }
        });

        let stderrBuf = '';
        proc.stderr.on('data', (chunk) => {
          stderrBuf += chunk.toString();
          const lines = stderrBuf.split('\n');
          stderrBuf = lines.pop() || '';
          for (const line of lines) {
            if (line.trim()) addLog('warning', line.trim());
          }
        });

        proc.on('close', (code) => {
          if (stdoutBuf.trim()) addLog('info', stdoutBuf.trim());
          finish(code);
        });
        proc.on('error', (err) => {
          addLog('error', `采集启动失败: ${err.message}`);
          finish(-1, `采集启动失败: ${err.message}`);
        });
      });
    } catch (err) {
      addLog('error', `❌ 采集失败: ${err.message}`);
      return { ok: false, message: err.message };
    }
  });

  // 取消采集
  ipcMain.handle('collect:cancel', () => {
    if (!collectProcess) return { ok: false, message: '没有运行中的采集' };
    killProcessTree(collectProcess);
    collectProcess = null;
    addLog('warning', '采集已被用户取消');
    return { ok: true, message: '已取消' };
  });

  // 获取最近采集数据
  ipcMain.handle('collect:latest', async () => {
    try {
      const { openDB } = await import('../src/db.js');
      const dbPath = path.join(DATA_DIR, 'data', 'analytics.db');
      if (!fs.existsSync(dbPath)) return null;

      const db = await openDB(dbPath, { readonly: true });

      const rows = db.all(
        'SELECT date, platform, metric, value FROM daily_stats WHERE date = (SELECT MAX(date) FROM daily_stats) ORDER BY platform, metric'
      );
      db.close();

      if (!rows.length) return null;

      const platforms = {};
      for (const r of rows) {
        if (!platforms[r.platform]) platforms[r.platform] = {};
        platforms[r.platform][r.metric] = r.value;
      }

      return { date: rows[0].date, platforms };
    } catch (e) {
      console.error('读取采集数据失败:', e.message);
      return null;
    }
  });

  // 根据平台和用户名生成个人主页 URL
  function profileUrlFor(platform, cleanUsername) {
    if (!cleanUsername) return '';
    const urls = {
      tiktok: `https://www.tiktok.com/@${cleanUsername}`,
      xiaohongshu: `https://www.xiaohongshu.com/user/profile/${cleanUsername}`,
      facebook: `https://facebook.com/${cleanUsername}`,
      instagram: `https://instagram.com/${cleanUsername}`,
      youtube: `https://youtube.com/@${cleanUsername}`,
      x: `https://x.com/${cleanUsername}`,
    };
    return urls[platform] || '';
  }

  /**
   * 读某天最后一轮采集的证据（output/<日期>/collect-HHMM.json，由 collector/index.js 写）
   * 返回 null 表示那天没跑过采集。
   */
  function readCollectEvidence(date) {
    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
      const cdir = path.join(DATA_DIR, 'output', date);
      if (!fs.existsSync(cdir)) return null;
      const files = fs.readdirSync(cdir).filter(f => /^collect-\d{4}\.json$/.test(f)).sort();
      if (!files.length) return null;
      const ev = fs.readJsonSync(path.join(cdir, files[files.length - 1]));
      const fails = Array.isArray(ev.failures) ? ev.failures : [];
      return {
        at: ev.atLocal || ev.at || '',
        ok: !!ev.ok,
        total: Number(ev.total) || 0,
        collected: Number(ev.collected) || 0,
        insufficient: Number(ev.insufficient) || 0,
        reason: fails.length === 0 ? '' : fails.length === 1
          ? fails[0].reason
          : `${fails.length} 个账号（${fails[0].reason} 等）`,
      };
    } catch (_) {
      return null;
    }
  }

  // 获取日报数据（含昨日对比 + 可用日期列表）
  ipcMain.handle('report:daily', async (_event, targetDate) => {
    try {
      const { openDB } = await import('../src/db.js');
      const dbPath = path.join(DATA_DIR, 'data', 'analytics.db');
      if (!fs.existsSync(dbPath)) return null;

      const db = await openDB(dbPath, { readonly: true });

      // 可用日期列表（降序）
      const dateRows = db.all('SELECT DISTINCT date FROM daily_stats ORDER BY date DESC');
      const availableDates = dateRows.map(r => r.date);
      if (!availableDates.length) {
        // 一行数据都没有：不能只返回 null（界面会显示"暂无数据"，看不出是"采集没采到"还是"没跑过"）
        db.close();
        const t = targetDate || new Date().toLocaleDateString('sv-SE');
        return {
          date: t,
          yesterday: '',
          availableDates: [],
          accounts: {},
          accountMeta: {},
          collectedAt: '',
          collect: readCollectEvidence(t),
          collectToday: null,
          today: new Date().toLocaleDateString('sv-SE'),
          configAccounts: (loadConfig().accounts || [])
            .filter((a) => a && a.name && !a.disabled)
            .map((a) => ({ name: String(a.name), platform: a.platform || 'tiktok', username: String(a.username || '').replace(/^@/, '') })),
        };
      }

      // 目标日期
      const date = targetDate || availableDates[0];
      // 昨日
      const d = new Date(date);
      d.setDate(d.getDate() - 1);
      const yesterday = d.toISOString().split('T')[0];

      // 当日数据（含 account）
      const todayRows = db.all(
        'SELECT account, platform, metric, value FROM daily_stats WHERE date = ? ORDER BY account, platform, metric',
        [date]
      );

      // 昨日数据
      const yesterdayRows = db.all(
        'SELECT account, platform, metric, value FROM daily_stats WHERE date = ? ORDER BY account, platform, metric',
        [yesterday]
      );

      db.close();

      // 按账号 → 平台分组
      const accounts = {};
      for (const r of todayRows) {
        if (!accounts[r.account]) accounts[r.account] = {};
        if (!accounts[r.account][r.platform]) accounts[r.account][r.platform] = { stats: {}, yesterday: {} };
        accounts[r.account][r.platform].stats[r.metric] = r.value;
      }
      for (const r of yesterdayRows) {
        if (!accounts[r.account]) accounts[r.account] = {};
        if (!accounts[r.account][r.platform]) accounts[r.account][r.platform] = { stats: {}, yesterday: {} };
        accounts[r.account][r.platform].yesterday[r.metric] = r.value;
      }

      // 加载账号元数据：从配置取（用户名/主页链接），无则从 auto-save 文件补
      const configAccountsRaw = loadConfig().accounts || [];
      let accountMeta = {};
      // 先从配置文件读取用户名
      for (const a of configAccountsRaw) {
        if (a.name && a.username) {
          const clean = a.username.replace(/^@/, '');
          const profileUrl = profileUrlFor(a.platform, clean);
          accountMeta[a.name] = { platform: a.platform, username: a.username, profileUrl };
        }
      }
      // 再从自动保存文件补充（配置未填的账号）
      try {
        const metaPath = path.join(DATA_DIR, 'data', 'account-meta.json');
        if (fs.existsSync(metaPath)) {
          const autoMeta = fs.readJsonSync(metaPath);
          for (const [k, v] of Object.entries(autoMeta)) {
            if (!accountMeta[k]) accountMeta[k] = v;
          }
        }
      } catch (_) {}

      // 配置里的全部账号：日报要能把"没采到数据的号"也列出来，
      // 否则用户只会看到 1 个号，以为「这软件只能看一个账号」（2026-10-19 反馈）
      const configAccounts = (configAccountsRaw || [])
        .filter((a) => a && a.name && !a.disabled)
        .map((a) => ({ name: String(a.name), platform: a.platform || 'tiktok', username: String(a.username || '').replace(/^@/, '') }));

      // 采集时间戳
      let collectedAt = '';
      try {
        const cmPath = path.join(DATA_DIR, 'data', 'collect-meta.json');
        if (fs.existsSync(cmPath)) {
          const cm = fs.readJsonSync(cmPath);
          collectedAt = cm.collectedAtLocal || cm.collectedAt || '';
        }
      } catch (_) {}

      // 本轮采集的结果（读 output/<日期>/collect-HHMM.json 里最新那份）
      // 作用：这一页显示的是"历史某天的数据"，如果当天采集其实没拿到数据，
      // 必须明说，不能让人以为这就是今天的成果（2026-10-19 事故）
      const collect = readCollectEvidence(date);
      // 今天的采集结果：看的是历史日期时，也要能说清"今天到底采到没有"
      const todayLocal = new Date().toLocaleDateString('sv-SE');
      const collectToday = todayLocal === date ? null : readCollectEvidence(todayLocal);

      return { date, yesterday, availableDates, accounts, accountMeta, collectedAt, collect, collectToday, today: todayLocal, configAccounts };
    } catch (e) {
      console.error('读取日报数据失败:', e.message);
      return null;
    }
  });

  // 获取趋势数据（最近 N 天）
  // 某一天的「发布侧」结果（日报页用，2026-10-19 P0-3 配套）：
  // 数据型日报在账号没数据时全是「—」，但"今天发了 N 条、失败 M 条"永远是实话，
  // 而且这是用户每天真正想知道的东西。
  // 成功来自发布账本（publish-ledger.jsonl），失败/未确认来自会话目录里的 FAILED 标记。
  // 发布日结果（发布账本 + FAILED 目录）。抽成函数：AI 助手要复用同一份口径。
  const buildPublishDay = (day) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? String(day) : localDateStr();
    const out = { date, published: 0, unconfirmed: 0, failed: 0, failures: [], accounts: [], sessions: 0 };
    try {
      const ledger = path.join(DATA_DIR, 'data', 'publish-ledger.jsonl');
      if (fs.existsSync(ledger)) {
        for (const line of fs.readFileSync(ledger, 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          let row = null;
          try { row = JSON.parse(line); } catch (_) { continue; }
          const d = row.date || String(row.at || '').slice(0, 10);
          if (d !== date) continue;
          out.published += 1;
          out.accounts.push({ env: row.env || '', session: row.session || '', title: String(row.title || '').slice(0, 60) });
        }
      }
    } catch (_) { /* 账本读不到就当 0 */ }
    try {
      const dayDir = path.join(DATA_DIR, 'output', date);
      if (fs.existsSync(dayDir)) {
        for (const s of fs.readdirSync(dayDir)) {
          const sp = path.join(dayDir, s);
          try { if (!fs.statSync(sp).isDirectory()) continue; } catch (_) { continue; }
          out.sessions += 1;
          const failedFile = path.join(sp, 'FAILED');
          if (fs.existsSync(failedFile)) {
            let f = {};
            try { f = fs.readJsonSync(failedFile); } catch (_) { f = {}; }
            if (f.published === true) {
              out.unconfirmed += 1;
              if (out.failures.length < 20) out.failures.push({ session: s, stage: '发布未确认', reason: String(f.reason || '').slice(0, 160), unconfirmed: true });
            } else {
              out.failed += 1;
              if (out.failures.length < 20) out.failures.push({ session: s, stage: String(f.stage || ''), reason: String(f.reason || '').slice(0, 160) });
            }
          }
        }
      }
    } catch (_) { /* 目录读不到不抛 */ }
    return out;
  };

  ipcMain.handle('report:publishDay', (_event, day) => buildPublishDay(day));

  ipcMain.handle('report:trend', async (_event, days) => {
    try {
      const { openDB } = await import('../src/db.js');
      const dbPath = path.join(DATA_DIR, 'data', 'analytics.db');
      if (!fs.existsSync(dbPath)) return null;

      const db = await openDB(dbPath, { readonly: true });
      const limit = Math.min(days || 7, 30);

      // 获取最近 N 天的所有数据
      const rows = db.all(
        'SELECT date, account, platform, metric, value FROM daily_stats ORDER BY date ASC'
      );

      db.close();

      // 按账号+平台+日期分组
      const series = {};
      for (const r of rows) {
        const key = r.account + '|' + r.platform;
        if (!series[key]) series[key] = { account: r.account, platform: r.platform, dates: {}, metrics: {} };
        if (!series[key].dates[r.date]) series[key].dates[r.date] = {};
        series[key].dates[r.date][r.metric] = r.value;
      }

      // 横轴 = 真实日历的近 N 天（含今天），不是"最近 N 个有数据的日期"
      // 为什么改：旧实现按"有数据的日期"取 7 个，于是 2026-07-22 和 2026-10-18 这两段
      // 相隔 3 个月的日期被等间距排在一起、还连成一条线，看着像"这 7 天都是 0"。
      const allDates = [];
      const end = new Date();
      for (let i = limit - 1; i >= 0; i--) {
        const d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
        allDates.push(d.toLocaleDateString('sv-SE'));   // YYYY-MM-DD，本地时区
      }

      // 格式化输出
      const result = {};
      for (const [key, s] of Object.entries(series)) {
        for (const metric of ['followers', 'views', 'likes']) {
          const data = allDates.map(d => s.dates[d]?.[metric] ?? null);
          if (data.some(v => v !== null)) {
            const sk = key + '|' + metric;
            result[sk] = { account: s.account, platform: s.platform, metric, dates: allDates, values: data };
          }
        }
      }
      return result;
    } catch (e) {
      console.error('读取趋势数据失败:', e.message);
      return null;
    }
  });

  // 手动推送日报到 TG
  ipcMain.handle('report:push', async (_event, targetDate) => {
    try {
      const { openDB } = await import('../src/db.js');
      const dbPath = path.join(DATA_DIR, 'data', 'analytics.db');
      if (!fs.existsSync(dbPath)) {
        addLog('error', '❌ 暂无日报数据，无法推送');
        return { ok: false, message: '暂无日报数据' };
      }

      const db = await openDB(dbPath, { readonly: true });
      const dateRows = db.all('SELECT DISTINCT date FROM daily_stats ORDER BY date DESC');
      if (!dateRows.length) { db.close(); addLog('error', '❌ 暂无日报数据'); return { ok: false, message: '暂无日报数据' }; }

      const date = targetDate || dateRows[0].date;
      const d = new Date(date); d.setDate(d.getDate() - 1);
      const yesterday = d.toISOString().split('T')[0];

      const todayRows = db.all('SELECT account, platform, metric, value FROM daily_stats WHERE date = ?', [date]);
      const yesterdayRows = db.all('SELECT account, platform, metric, value FROM daily_stats WHERE date = ?', [yesterday]);

      // 按账号分组
      const accounts = {};
      for (const r of todayRows) {
        if (!accounts[r.account]) accounts[r.account] = {};
        if (!accounts[r.account][r.platform]) accounts[r.account][r.platform] = { stats: {}, yesterday: {} };
        accounts[r.account][r.platform].stats[r.metric] = r.value;
      }
      for (const r of yesterdayRows) {
        if (!accounts[r.account]) accounts[r.account] = {};
        if (!accounts[r.account][r.platform]) accounts[r.account][r.platform] = { stats: {}, yesterday: {} };
        accounts[r.account][r.platform].yesterday[r.metric] = r.value;
      }
      db.close();

      // 加载账号元数据（用户名/主页链接）
      const configAccounts = loadConfig().accounts || [];
      let pushMeta = {};
      for (const a of configAccounts) {
        if (a.name && a.username) pushMeta[a.name] = a.username;
      }
      try {
        const metaPath = path.join(DATA_DIR, 'data', 'account-meta.json');
        if (fs.existsSync(metaPath)) {
          const autoMeta = fs.readJsonSync(metaPath);
          for (const [k, v] of Object.entries(autoMeta)) {
            if (!pushMeta[k]) pushMeta[k] = v.username || '';
          }
        }
      } catch (_) {}
      // 采集时间
      let pushTime = '';
      try {
        const cmPath = path.join(DATA_DIR, 'data', 'collect-meta.json');
        if (fs.existsSync(cmPath)) {
          const cm = fs.readJsonSync(cmPath);
          pushTime = cm.collectedAtLocal || '';
        }
      } catch (_) {}

      // 组装日报文本
      const platformEmoji = { tiktok: '🎵', xiaohongshu: '📕', facebook: '📘', instagram: '📸', youtube: '▶️', x: '𝕏' };
      const metricLabels = { followers: '粉', views: '播', likes: '赞', comments: '评', shares: '转', profile_views: '主页', reach: '触达', engagement: '互动' };
      const platformNames = { tiktok: 'TikTok', xiaohongshu: '小红书', facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', x: 'X' };

      const lines = [`━━━━━━━━━━━━━━━━━━━━━━━━`, `📊 XNOW 数据日报 · ${date}${pushTime ? ` 🕐${pushTime}` : ''}`, `━━━━━━━━━━━━━━━━━━━━━━━━`, ``];

      for (const [account, platforms] of Object.entries(accounts)) {
        if (Object.keys(accounts).length > 1) {
          const user = pushMeta[account] || '';
          lines.push(`👤 ${account}${user ? ` · ${user}` : ''}`);
        }
        for (const [platform, pd] of Object.entries(platforms)) {
          const emoji = platformEmoji[platform] || '📡';
          const name = platformNames[platform] || platform;
          const parts = [`${emoji} ${name}`];
          for (const [metric, value] of Object.entries(pd.stats)) {
            const label = metricLabels[metric] || metric;
            const val = value >= 10000 ? (value/10000).toFixed(1)+'万' : value >= 1000 ? (value/1000).toFixed(1)+'K' : String(value);
            if (pd.yesterday[metric] !== undefined) {
              const diff = value - pd.yesterday[metric];
              const arrow = diff >= 0 ? '↑' : '↓';
              const diffStr = Math.abs(diff) >= 10000 ? (Math.abs(diff)/10000).toFixed(1)+'万' : Math.abs(diff) >= 1000 ? (Math.abs(diff)/1000).toFixed(1)+'K' : String(Math.abs(diff));
              parts.push(`${label} ${val} ${arrow}${diffStr}`);
            } else {
              parts.push(`${label} ${val}`);
            }
          }
          lines.push(parts.join(' | '));
        }
      }
      lines.push(``, `━━━━━━━━━━━━━━━━━━━━━━━━`);
      const text = lines.join('\n');

      // 调用 TG 推送
      // ⚠️ sendMessage 在「没配 token」时返回 null 而**不抛错**，旧代码照样记 ✅ 已推送 ——
      //    和采集的"假成功"同一个坑。这里先判配置，再判返回值。
      const { sendMessage, isTelegramConfigured } = await import('../src/notifier.js');
      if (!isTelegramConfigured()) {
        addLog('warn', '⚠️ 日报未推送：TG 未配置（缺 TG_BOT_TOKEN）');
        return { ok: false, skipped: true, message: 'TG 未配置（缺 TG_BOT_TOKEN），日报没有推送' };
      }
      const res = await sendMessage(text);
      if (!res) {
        addLog('warn', `⚠️ 日报 ${date} 未确认送达：TG 没有返回响应`);
        return { ok: false, message: 'TG 没有返回响应，未确认送达' };
      }
      addLog('success', `✅ 日报 ${date} 已推送到 TG`);
      return { ok: true };
    } catch (err) {
      addLog('error', `❌ 日报推送失败: ${err.message}`);
      return { ok: false, message: err.message };
    }
  });

  // === 自动更新 ===
  ipcMain.handle('update:check', () => {
    checkForUpdates();
    return { ok: true };
  });
  ipcMain.handle('update:download', () => {
    downloadUpdate();
    return { ok: true };
  });
  ipcMain.handle('update:install', () => {
    quitAndInstall();
    return { ok: true };
  });
}   // ← setupIPC() 到此结束（原先这个大括号在第 984 行提前闭合，
    //    导致 publish/collect/report/update 共 10 个 handler 落在模块顶层，
    //    在 app.whenReady 之前、甚至单实例锁失败时就被注册了）

function getTodayDir() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// === 环境自检 ===
async function healthCheck() {
  const issues = [];

  // Node 版本
  const nodeVer = process.version;
  const major = parseInt(nodeVer.slice(1));
  if (major < 18) issues.push(`Node.js ${nodeVer}，需要 >=18`);

  // ffmpeg / ffprobe / edge-tts —— 用引擎同一套解析逻辑探测，
  // 避免「winget 装了但不在 PATH」被误报为未安装
  try {
    const { verifyMediaTools } = await import('../src/engine/tools.js');
    const tools = verifyMediaTools();
    if (!tools.ffmpeg.ok) issues.push(`ffmpeg 不可用 (${tools.ffmpeg.path}): ${tools.ffmpeg.error}`);
    if (!tools.ffprobe.ok) issues.push(`ffprobe 不可用 (${tools.ffprobe.path}): ${tools.ffprobe.error}`);
    if (!tools.edgeTts.ok) issues.push(`edge-tts 不可用 (${tools.edgeTts.path}): ${tools.edgeTts.error}`);
    // 版本对 ≠ 能用：真去合成一次（免费），挡住"烧完生图钱才发现配音 403"
    if (tools.edgeTts.ok && !tools.edgeTtsSpeech?.ok) {
      issues.push(`edge-tts 语音合成失败: ${tools.edgeTtsSpeech?.error || '未知原因'} —— 多半是客户端过期，执行 pip install -U edge-tts`);
    }
    if (tools.ffmpeg.ok) addLog('info', `🧰 ${tools.ffmpeg.version}`);
    if (tools.edgeTts.ok) addLog('info', `🧰 ${tools.edgeTts.version}`);
    if (tools.edgeTtsSpeech?.ok) addLog('success', '🔊 edge-tts 真实合成探测通过');
  } catch (e) {
    issues.push(`外部工具检查失败: ${e.message}`);
  }

  if (issues.length > 0) {
    addLog('warning', `⚠️ 环境检查发现 ${issues.length} 个问题:`);
    issues.forEach(i => addLog('warning', `  · ${i}`));
  } else {
    addLog('success', '✅ 环境检查通过');
  }
}

// === 自动备份 ===
function autoBackup() {
  const today = localDateStr();   // 备份目录也按本地日期（UTC 会在凌晨多建一个"昨天的"目录）
  const backupDir = path.join(DATA_DIR, 'backups', today);
  if (fs.existsSync(backupDir)) return; // 今天已备份

  try {
    fs.ensureDirSync(backupDir);
    // 备份配置
    if (fs.existsSync(USER_CONFIG_PATH())) {
      fs.copyFileSync(USER_CONFIG_PATH(), path.join(backupDir, 'user.json'));
    }
    // 备份数据库
    const dbPath = path.join(DATA_DIR, 'data', 'analytics.db');
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, path.join(backupDir, 'analytics.db'));
    }
    addLog('info', `💾 已备份到 backups/${today}`);
  } catch (e) {
    addLog('warning', `⚠️ 自动备份失败: ${e.message}`);
  }
}

// === 凭据加密备份（2026-10-19 全盘审查 P0-4）===
// 问题：10 个号的用户名/密码/邮箱密码只存在 data/env-accounts.json **一份**里，没有任何备份；
//       cookie 备份目录是空的（0/10 环境）；2FA 密钥全盘检索命中 0。
//       一次误删/写坏/坏盘 = 10 个号彻底失联，而且没有恢复路径。
// 做法：每天写一份**加密**包 `backups/secrets/<本地日期>/secrets.enc`（Windows 走 DPAPI，
//       只有当前 Windows 用户能解），启动时如果关键文件丢了/坏了，就从最新的一份补回来。
// 硬规则：safeStorage 不可用时**跳过，绝不写明文备份**。
function secretsRootDir() {
  return path.join(DATA_DIR, 'backups', 'secrets');
}

function secretsDayDir(day = localDateStr()) {
  return path.join(secretsRootDir(), day);
}

function secretsBundlePath(day = localDateStr()) {
  return path.join(secretsDayDir(day), BUNDLE_FILE);
}

function safeStorageOrNull() {
  try {
    const ss = electron.safeStorage;
    if (!ss || typeof ss.isEncryptionAvailable !== 'function') return null;
    if (!ss.isEncryptionAvailable()) return null;
    return ss;
  } catch (_) {
    return null;
  }
}

/** 读要备份的文件原文（读不到就跳过，不让一个坏文件毁掉整次备份） */
function readSecretSources() {
  const files = {};
  for (const item of SECRET_FILES) {
    try {
      const p = path.join(DATA_DIR, item.rel);
      if (!fs.existsSync(p)) continue;
      files[item.rel] = fs.readFileSync(p, 'utf-8');
    } catch (_) { /* 单个文件读不了不影响其它 */ }
  }
  return files;
}

/**
 * 读最近一天的 cookie 备份（`backups/cookies/<日期>/<环境>.json`）并进加密包。
 * 为什么需要：启动时的凭据包原先只有 5 个配置文件、**没有登录态** ——
 * 换机器/环境坏了照样得重登（重登就要 2FA，2FA 又可能没落盘）。
 * 这里只取**最新一天**：凭据包本来就是「当前状态」的快照，历史 cookie 留着也没用。
 */
function readLatestCookieBackups() {
  const out = {};
  try {
    const root = path.join(DATA_DIR, 'backups', 'cookies');
    if (!fs.existsSync(root)) return out;
    const days = fs
      .readdirSync(root)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    const latest = days[days.length - 1];
    if (!latest) return out;
    const dir = path.join(root, latest);
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      try {
        const list = fs.readJsonSync(path.join(dir, f));
        if (Array.isArray(list) && list.length) out[path.basename(f, '.json')] = list;
      } catch (_) { /* 单个坏文件跳过 */ }
    }
  } catch (_) { /* 目录读不到就当没有 */ }
  return out;
}

/** 当前状态：ok / missing / corrupt（json 类才校验能不能解析） */
function probeSecretState(rel) {  const p = path.join(DATA_DIR, rel);
  try {
    if (!fs.existsSync(p)) return 'missing';
    const text = fs.readFileSync(p, 'utf-8');
    if (!text.trim()) return 'corrupt';
    if (String(rel).endsWith('.json')) JSON.parse(text);
    return 'ok';
  } catch (_) {
    return 'corrupt';
  }
}

/** 解密今天已有的包（用来把后导出的 cookie 并进去） */
function readTodaySecretsBundle(ss) {
  try {
    const p = secretsBundlePath();
    if (!fs.existsSync(p)) return null;
    return parseBundle(ss.decryptString(fs.readFileSync(p)));
  } catch (_) {
    return null;
  }
}

function pruneBackupDateDirs(rootDir, label) {
  try {
    if (!fs.existsSync(rootDir)) return 0;
    const doomed = pickOldDateDirs(fs.readdirSync(rootDir), { today: localDateStr(), days: SECRET_KEEP_DAYS });
    let n = 0;
    for (const name of doomed) {
      try {
        fs.removeSync(path.join(rootDir, name));
        n++;
      } catch (_) { /* 单个失败不影响其它 */ }
    }
    if (n) addLog('info', `🧹 清理 ${SECRET_KEEP_DAYS} 天前的${label} ${n} 份`);
    return n;
  } catch (_) {
    return 0;
  }
}

/**
 * 写今天的凭据加密包（幂等：同一天多次调用会与已有内容合并 cookie）。
 * 关键：**写盘后必须解密读回校验**，对不上就删掉并报错 —— 不能"写了就算成功"。
 */
function autoBackupSecrets({ cookies = {} } = {}) {
  const ss = safeStorageOrNull();
  if (!ss) {
    addLog('warning', '⚠️ 凭据备份跳过：系统加密存储不可用（safeStorage），不写明文备份');
    return { ok: false, reason: 'no-safestorage' };
  }
  try {
    // 启动时调用方没传 cookie → 用已落盘的最近一天 cookie 备份补上（保证包是自包含的）
    const cookieMap = Object.keys(cookies || {}).length ? cookies : readLatestCookieBackups();
    let bundle = buildBundle({ files: readSecretSources(), cookies: cookieMap, version: app.getVersion() });
    const existing = readTodaySecretsBundle(ss);
    if (existing) {
      bundle = { ...bundle, cookies: { ...(existing.cookies || {}), ...(bundle.cookies || {}) } };
    }
    if (isEmptyBundle(bundle)) {
      addLog('warning', '⚠️ 凭据备份跳过：一个文件都没读到（数据目录不对？）');
      return { ok: false, reason: 'empty' };
    }
    const text = JSON.stringify(bundle);
    const enc = ss.encryptString(text);
    fs.ensureDirSync(secretsDayDir());
    const target = secretsBundlePath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, enc);
    const back = parseBundle(ss.decryptString(fs.readFileSync(tmp)));
    const s = summarizeBundle(bundle);
    if (!back || summarizeBundle(back).fileCount !== s.fileCount) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      addLog('error', '❌ 凭据备份校验失败：加密包读回来对不上，已丢弃（这几个文件现在没有备份）');
      return { ok: false, reason: 'verify' };
    }
    fs.renameSync(tmp, target);
    const cookiePart = s.cookieEnvs.length ? ` + cookie ${s.cookieEnvs.length} 个环境` : '';
    addLog('success', `🔐 凭据备份 ${s.fileCount} 个文件 / ${describeBytes(s.bytes)}${cookiePart}（加密，backups/secrets/${localDateStr()}）`);
    const missing = missingSecretLabels(bundle);
    if (missing.length) {
      addLog('warning', `⚠️ 凭据备份缺：${missing.join('、')}（缺账号凭据 = 换机器/坏盘后无法重登）`);
    }
    pruneBackupDateDirs(secretsRootDir(), '凭据备份');
    return { ok: true, fileCount: s.fileCount, bytes: s.bytes };
  } catch (e) {
    addLog('error', `❌ 凭据备份失败：${e.message}`);
    return { ok: false, reason: e.message };
  }
}

/**
 * 启动自愈：只有当关键文件**丢了或坏了**时才从最新的加密包补回来。
 * 一切正常时一行日志都不写、不解密、不动任何文件。
 */
function restoreSecretsIfNeeded() {
  const ss = safeStorageOrNull();
  if (!ss) return 0;
  try {
    const root = secretsRootDir();
    if (!fs.existsSync(root)) return 0;
    // 先看有没有东西真的坏了（没有就不解密）
    const broken = SECRET_FILES.filter((item) => probeSecretState(item.rel) !== 'ok');
    if (!broken.length) return 0;
    const days = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
    for (const day of days) {
      const p = path.join(root, day, BUNDLE_FILE);
      if (!fs.existsSync(p)) continue;
      let bundle = null;
      try {
        bundle = parseBundle(ss.decryptString(fs.readFileSync(p)));
      } catch (_) {
        continue;   // 这一份解不开（换过 Windows 账户/损坏）→ 看上一份
      }
      if (!bundle) continue;
      const plan = planRestore(bundle, probeSecretState);
      if (!plan.length) return 0;
      let n = 0;
      const restored = [];
      for (const item of plan) {
        try {
          const target = path.join(DATA_DIR, item.rel);
          fs.ensureDirSync(path.dirname(target));
          fs.writeFileSync(target, bundle.files[item.rel], 'utf-8');
          n++;
          restored.push(item.label);
        } catch (_) { /* 单个失败继续 */ }
      }
      if (n) {
        addLog('success', `🛠️ 已从 ${day} 的加密备份恢复 ${n} 个文件：${restored.join('、')}`);
        return n;
      }
      return 0;
    }
  } catch (e) {
    addLog('warning', `⚠️ 凭据恢复检查失败：${e.message}`);
  }
  return 0;
}

// === 单实例锁（防重复启动） ===
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// === 调度器（定时任务后台进程） ===
// schedulerProcess 已在文件上方的状态区声明
let schedulerRestartTimer = null;

// 防抖重启：error 与 exit 可能各触发一次，去重后只排一个定时器，
// 否则会同时拉起两个调度器进程。
function scheduleSchedulerRestart() {
  if (schedulerRestartTimer) return;
  schedulerRestartTimer = setTimeout(() => {
    schedulerRestartTimer = null;
    startScheduler();
  }, 10_000);
}

function startScheduler() {
  // 安装版用解包目录，开发版用项目目录
  const schedulerRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : ROOT;
  const scriptPath = path.join(schedulerRoot, 'src', 'scheduler.js');
  if (!fs.existsSync(scriptPath)) {
    console.warn('scheduler.js 不存在，跳过调度器启动');
    return;
  }

  schedulerProcess = spawn(NODE_EXE, [scriptPath], {
    cwd: schedulerRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,  // 不弹 CMD 窗口
    env: {
      ...process.env,
      XNOWPOST_DATA_DIR: DATA_DIR,
    },
  });

  // 任务开始/结束的判定。
  // 之前用 includes('run') 这类子串匹配，任何含 "run" 的行都会把状态灯点亮；
  // 这里改成带词边界的正则，降低误判。
  const START_RE = /(▶️|开始执行|任务开始|engine start|job start|\brun(ning)?\b|\bbegin\b)/i;
  const DONE_RE = /(✅|❌|完成|失败|已取消|\bdone\b|\bfail(ed)?\b|\bcomplete(d)?\b|\bcancel(led)?\b)/i;

  const handleLine = (line) => {
    // 失败/超时/未确认的定时任务行按 error 记账（原来一律记 info，导致
    // 界面「错误 N 条」永远是 0，昨天的 115 条 ❌ 一条都没算进去）。
    const isFailure = /❌|⏱️|⚠️.*未确认/.test(line);
    addLog(isFailure ? 'error' : 'info', `⏰ ${line}`);
    // 单行的意外异常不能让同一 chunk 里的其余日志一起丢失
    try {
      if (START_RE.test(line)) {
        schedulerRunning = true;
        // 北京时间（UTC+8），不用 toISOString（那是 UTC）
        schedulerLastRun = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
        pushEngineStatus();
      } else if (DONE_RE.test(line)) {
        schedulerRunning = false;
        // 失败 / 超时未确认 / 被跳过 → 弹系统通知（TG 没配，这是唯一能主动找到人的通道）
        if (/❌|⏱️|⚠️.*未确认|⏭️\s*跳过/.test(line)) {
          notifyFailure({
            title: 'XNOWPost 定时任务异常',
            body: line.replace(/^\[[^\]]+\]\s*/, ''),
            key: line.slice(0, 80),
          });
        }
        pushEngineStatus();
      }
    } catch (e) {
      writeCrashLog('SCHEDULER_STATUS', e.stack || e.message);
    }
  };

  // 半行缓冲：原先直接 split('\n') 丢掉残行，会把一行日志截断或拆成两条
  let stdoutBuf = '';
  schedulerProcess.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) handleLine(line.trim());
    }
  });

  let stderrBuf = '';
  schedulerProcess.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) addLog('warning', `⏰ ${line.trim()}`);
    }
  });

  // 🔴 原先没有 'error' 监听：打包版依赖系统 node，干净机器上 ENOENT 很常见，
  //    未处理的 'error' 事件会直接抛异常，而且引用仍留在非 null，
  //    下面的 10 秒重启循环永远不会生效。
  schedulerProcess.on('error', (err) => {
    addLog('error', `⚠️ 调度器启动失败: ${err.message}，10s 后重试...`);
    schedulerProcess = null;
    schedulerRunning = false;
    scheduleSchedulerRestart();
  });

  schedulerProcess.on('exit', (code) => {
    if (stdoutBuf.trim()) { try { handleLine(stdoutBuf.trim()); } catch (_) { /* ignore */ } }
    schedulerProcess = null;
    schedulerRunning = false;
    if (code !== 0 && code !== null) {
      addLog('warning', `⚠️ 调度器异常退出 (code: ${code})，10s 后重启...`);
      scheduleSchedulerRestart();
    }
  });
}

// === 应用生命周期 ===
app.whenReady().then(async () => {
  // 安装版：DATA_DIR → userData（%APPDATA%/xnowpost），开发版沿用项目目录
  if (app.isPackaged) {
    DATA_DIR = app.getPath('userData');
  }

  // 加载配置
  let cfg = loadConfig();

  // 自定义数据目录：如果配置了 dataDir，检查目标目录是否有效
  if (cfg.dataDir && cfg.dataDir !== DATA_DIR) {
    const targetConfigPath = path.join(cfg.dataDir, 'config', 'user.json');
    if (isValidDataDir(cfg.dataDir, ROOT) && fs.existsSync(targetConfigPath)) {
      // 有效：切换到目标目录
      DATA_DIR = cfg.dataDir;
      cfg = loadConfig();
    } else {
      // 无效（路径非法 / 被更新覆盖 / 手动删除等）：清除 dataDir，回退默认目录
      console.warn(`⚠️ 自定义数据目录 ${cfg.dataDir} 不可用，回退到默认目录`);
      cfg.dataDir = '';
      try { fs.writeJsonSync(USER_CONFIG_PATH(), cfg, { spaces: 2 }); } catch (_) {}
    }
  }

  // 初始化配置文件
  try { await saveConfig(cfg); } catch {}

  // 凭据自愈：关键文件丢了/坏了就从最新的加密备份补回来（正常启动不做任何事）。
  // 放在 saveConfig 之后、prune 之前 —— 后面所有逻辑都能读到恢复好的文件。
  try { restoreSecretsIfNeeded(); } catch (_) { /* 自愈失败不阻断启动 */ }

  // 日志保留：只删 30 天前的 app-/scheduler- 日志（其它文件一概不碰）。
  // 用户问过「日志多了占不占内存」→ 内存不占（logBuffer 上限 500 行），
  // 磁盘以前是**只写不清**，这里补上。
  try {
    const logDir = path.join(DATA_DIR, 'logs');
    if (fs.existsSync(logDir)) {
      const files = fs.readdirSync(logDir).map((name) => ({ name, mtimeMs: fs.statSync(path.join(logDir, name)).mtimeMs }));
      const doomed = pickLogsToPrune(files, { nowMs: Date.now(), days: 30 });
      let freed = 0;
      for (const name of doomed) {
        const p = path.join(logDir, name);
        try {
          freed += fs.statSync(p).size;
          fs.unlinkSync(p);
        } catch (_) {}
      }
      if (doomed.length) {
        addLog('info', `🧹 清理 30 天前的日志 ${doomed.length} 个，释放 ${(freed / 1024 / 1024).toFixed(2)} MB`);
      }
    }
  } catch (e) {
    addLog('warning', `日志清理跳过：${e.message}`);
  }

  // output 保留：15 天前的会话目录里只清「中间件 + 调试产物」（_video/、expanded_debug.html），
  // video.mp4 / 封面.png / 文案 / .published / JSON 证据一律保留（用户 2026-10-19 口径）。
  try {
    const outDir = path.join(DATA_DIR, 'output');
    if (fs.existsSync(outDir)) {
      const todayStr = localDateStr();
      const oldDirs = pickOldDateDirs(fs.readdirSync(outDir), { today: todayStr, days: 15 });
      let removed = 0;
      let freed = 0;
      // 目录大小（用于日志里报"释放了多少"）
      const dirSize = (d) => {
        let n = 0;
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return 0; }
        for (const e of ents) {
          const p = path.join(d, e.name);
          try { n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } catch (_) {}
        }
        return n;
      };

      for (const day of oldDirs) {
        const dayDir = path.join(outDir, day);
        const walk = (dir) => {
          let entries = [];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
          for (const ent of entries) {
            const full = path.join(dir, ent.name);
            const rel = path.relative(dayDir, full);
            // ⚠️ 不能 `continue` 掉不可清目录：`am_0830/` 本身不清，但里面的
            //    `expanded_debug.html` 要清 —— 必须往下递归（第一版就漏了这层，
            //    结果一个文件都没删、日志也是空的）。
            if (!isCleanable(rel)) {
              if (ent.isDirectory()) walk(full);
              continue;
            }
            try {
              if (ent.isDirectory()) {
                freed += dirSize(full);
                fs.rmSync(full, { recursive: true, force: true });
                removed++;
              } else {
                freed += fs.statSync(full).size;
                fs.unlinkSync(full);
                removed++;
              }
            } catch (_) { /* 单个失败不影响其它 */ }
          }
        };
        walk(dayDir);
      }
      if (removed) {
        addLog('info', `🧹 清理 15 天前的中间文件 ${removed} 个（${oldDirs.length} 天的目录），释放 ${(freed / 1024 / 1024).toFixed(1)} MB（成片/封面/文案都保留）`);
      }
    }
  } catch (e) {
    addLog('warning', `output 清理跳过：${e.message}`);
  }

  setupIPC();
  createWindow();
  createTray();
  initUpdater(mainWindow);
  autoBackup();
  autoBackupSecrets();
  healthCheck();
  startScheduler();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 有系统托盘时，窗口关闭不退出应用（隐藏到托盘）
  if (tray) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (tray) { tray.destroy(); tray = null; }
  // 统一收掉调度器 / 引擎 / 采集器及其孙进程（FFmpeg、Chromium 等）
  killAllChildren();
});






