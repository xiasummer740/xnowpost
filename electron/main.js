import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { initUpdater, downloadUpdate, quitAndInstall, checkForUpdates } from './updater.js';
import { allocateAccountEnvs } from '../src/account-env.js';
// 发布账本 / 最后发布时间（扫描逻辑与命令行脚本共用同一份实现）
import { latestPublishByEnv, readLedger } from '../src/publish-history.js';
// 定时轮次的落盘记录（调度器写 / 这里读），纯函数 + 落盘helper，单测在 tests/unit/scheduled-run.test.js
import {
  describeScheduledRun,
  listPendingRunRecords,
  markRunReported,
  mergePublishedEvidence,
  pruneRunRecords,
  RUNS_REL,
  RUN_KEEP_DAYS,
} from '../src/scheduled-run.js';
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
import { scanUnpublished, summarizeSkips, DEFAULT_MAX_PER_RUN, sessionTime } from '../src/output-scan.js';
// 「这条发到哪个账号」唯一实现（点名账号必须命中，不许回落 accounts[0]）
import { resolvePublishTarget, describePublishTarget } from './lib/publish-target.js';
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
  makeMemoryEntry,
  mergeMemory,
  dropMemory,
  listUndoable,
  canUndo,
  describeUndo,
  UNDO_KEEP,
  SCHEDULE_MODE_LABEL,
  normalizeJobTime,
  resolvePublishSelectors,
  PUBLISH_MAX_PER_TURN,
} from './lib/assistant-tools.js';
import { nextJobId } from '../src/job-ids.js';
// 浏览器环境（FoxProfile）托管：端口分配 / 统一窗口尺寸 / 删除等
// —— 「浏览器环境」页就是靠这几个模块，别再写第二份端口分配逻辑。
// ⚠️ 2026-10-28 起代理不再走 proxy_relay + SSH + 软路由：
//    端口由内置内核 xray 一次开满 1080–1109（见 src/proxy/engine.js），
//    这里只用 nextRelayPort 算"新环境该拿哪一条"，以及 proxyUrl 拼代理串。
import { nextRelayPort, proxyUrl, localRelayPort } from '../src/collector/proxy-ports.js';
import { applyUniformScreen } from '../src/collector/uniform-screen.js';
// 内置代理内核（xray）：小白只需要粘一条 vless:// 链接，端口/内核全托给这一层
import * as proxyEngine from '../src/proxy/engine.js';
// 节点描述（`vless · host:port · 备注`）来自解析层，别再拼第二份
import { describeNode } from '../src/proxy/node.js';
// 原子写：关键状态文件（定时任务 / 凭据）必须「要么旧的、要么新的」。
// 直接覆盖写遇到断电/崩溃会留下半截 JSON；而 env-accounts.json 读失败时是 return {}，
// 等于一次断电就把所有账号的密码/2FA 从界面上清空（文件其实还在，但没人敢赌）。
// fs-atomic.js 采集器/引擎早就在用（临时文件 + rename），这里别再各写一份。
import { writeJsonAtomicSync, writeFileAtomicSync } from '../src/fs-atomic.js';
// 跨进程互斥：调度器（独立进程）与界面手动发布/采集共用一个锁文件
import * as runLock from '../src/run-lock.js';

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

/**
 * ISO/UTC 时间 → 本地「HH:MM」。
 * ⚠️ 不许再用 `new Date(x).toISOString().slice(11,16)` 直接显示：那是 UTC，
 * 北京时间会少 8 小时（2026-10-19 实测：21:43 发的作品，助手报「13:43」，
 * 而历史页/账号页显示的是本地时间 → 同一个事实两个时间）。
 */
function localHHMM(iso) {
  const d = new Date(iso || '');
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 耗时的人话：<90 秒说秒，否则说分钟（11 秒的只出文案写成「1 分钟」会让人以为跑了很久）。
 * @param {number} fromMs 起点时间戳
 */
function fmtSpent(fromMs) {
  const secs = Math.max(1, Math.round((Date.now() - Number(fromMs || 0)) / 1000));
  if (secs < 90) return `${secs} 秒`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

/**
 * 当前跑到哪一步：读今天的 app 日志尾部，取最后一个"阶段"标记。
 * 用途：用户等 2~3 分钟只想知道"现在在配音还是在传视频"，
 * 以前 get_last_task 只有「已启动 / 已发布 / 失败」三态，中间全靠猜。
 * 只读最后 80 行，不解析整个文件（一天 6000+ 行）。
 */
const STAGE_PATTERNS = [
  [/🎬 === (视频|图文|文案) ===/, '开始生成'],
  [/💬|🔄 标题|🚫 文案/, '写文案'],
  [/🗣️ 先做配音|🔊 配音|✅ 配音完成/, '配音'],
  [/📥 素材下载|🎞️ 分镜|🎨 全部分镜/, '找实拍素材'],
  [/🎨 封面|🤖 底图|✍️ 叠加/, '做封面'],
  [/🎬 合成|🎥 tiktok|✅ video\.mp4/, '合成视频'],
  [/开头封面卡/, '加封面卡'],
  [/📤 (自动发布|开始发布)|🌐 打开指纹环境/, '打开发布页'],
  [/⬆️ 上传视频|文件已提交|处理完成/, '上传视频'],
  [/📝 填写内容|✅ 标题已填/, '填文案'],
  [/⏳ 等待检查|✅ 检查已通过/, '等内容检查'],
  [/✅ 发布按钮已点击|Video published|审查完成/, '等平台审查'],
];
function currentStage() {
  try {
    const f = path.join(DATA_DIR, 'logs', `app-${localDateStr()}.log`);
    if (!fs.existsSync(f)) return null;
    const lines = fs.readFileSync(f, 'utf-8').trimEnd().split('\n').slice(-80);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      for (const [re, label] of STAGE_PATTERNS) {
        if (re.test(line)) {
          const m = line.match(/\[(\d{4}\/\d{2}\/\d{2}) (\d{2}:\d{2}:\d{2})\]/);
          return { label, at: m ? m[2].slice(0, 5) : '' };
        }
      }
    }
  } catch (_) { /* 日志读不到就不给阶段 */ }
  return null;
}

/**
 * 读一场会话目录的状态（get_last_task 的原子单元）。
 * `since` 用于过滤「本轮窗口内」的发布标记。
 */
function readSessionRow(dayDir, n, since = 0) {
  const sp = path.join(dayDir, n);
  const row = { session: n, time: sessionTime(n), hasVideo: fs.existsSync(path.join(sp, 'video.mp4')), published: null, failed: null };
  try {
    row.files = fs.readdirSync(sp).filter((f) => !f.startsWith('_') && !f.startsWith('.')).slice(0, 6);
    row.mtime = fs.statSync(sp).mtimeMs;
    row.ageMin = Math.max(0, Math.round((Date.now() - row.mtime) / 60000));
  } catch (_) { row.files = []; row.mtime = 0; row.ageMin = 0; }
  try {
    if (fs.existsSync(path.join(sp, '.published'))) {
      const m = fs.readJsonSync(path.join(sp, '.published'));
      // 标记里存的是 publishedAt（不是 at）—— 只读 m.at 会让时间窗过滤恒为真，
      // 于是「本轮发没发」可能把上一轮的作品算进来（CLAUDE.md 里记过这个坑）。
      const stamp = m.publishedAt || m.at || '';
      const at = Date.parse(stamp || '');
      if (!Number.isFinite(at) || at >= since) {
        row.published = { confirmed: m.confirmed !== false, env: m.env || '', at: stamp };
      }
    }
  } catch (_) { /* 坏标记忽略 */ }
  try {
    if (fs.existsSync(path.join(sp, 'FAILED'))) {
      const f = fs.readJsonSync(path.join(sp, 'FAILED'));
      row.failed = {
        stage: String(f.stage || ''),
        reason: String(f.reason || '').slice(0, 160),
        published: f.published === true,
        at: f.at || '',
      };
    }
  } catch (_) { /* 同上 */ }
  try {
    row.hasText = fs.existsSync(path.join(sp, '文案.txt')) && fs.statSync(path.join(sp, '文案.txt')).size > 0;
  } catch (_) { row.hasText = false; }
  return row;
}

/**
 * 一句话说清"这场会话到底怎么了"（给助手、也给人看）。
 * 关键：**没有成片也没有发布/失败标记 != 还在生成** —— 必须看它多久没动静。
 */
function describeSession(row) {
  if (!row) return '';
  const files = (row.files || []).join('、') || '空目录';
  if (row.published) {
    return `${row.session} 已发布（${row.published.env || '环境未知'}${row.published.confirmed ? '' : '，未确认'}）`;
  }
  if (row.failed) {
    return `${row.session} 失败${row.failed.stage ? ` 卡在「${row.failed.stage}」` : ''}${row.failed.reason ? ` · ${row.failed.reason}` : ''}`;
  }
  if (row.hasVideo) return `${row.session} 成片在（video.mp4），但没发出去`;
  if (row.ageMin >= 15) {
    return `${row.session} 没跑完就断了（${row.time} 开始，${row.ageMin} 分钟没动静，目录里只有 ${files}）`
      + '——多半是被取消或中途崩溃，不是"还在生成"';
  }
  return `${row.session} 可能还在跑（${row.time} 开始，约 ${row.ageMin} 分钟，还没有成片）`;
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
// 「跑完自动回报」。
// 用户口径（2026-10-19，连着问了两遍）：「发布完成后 自动返回结果状态，可以吗？
// 不然我还要一直看着时间守着」。→ 只要这一轮是**应用里发起的**（助手叫的 or 按钮点的），
// 结束时都往对话里推一条结论；只有调度器那个独立进程跑的轮次推不了（不在本进程）。
// ⚠️ 必须放在模块顶层：写它的是 setupIPC() 里的 run_engine，读它的是顶层
//    doRunEngine() 的 finish() —— 放在 setupIPC 里就形成作用域断裂（读不到）。
let assistantRunWatch = null;
/** 由 setupIPC() 注入：引擎跑完后把结果说回对话里 */
let onEngineRunDone = null;
// 手动发布的重入保护：2026-10-19 日志里 19:11:13 和 19:11:15 各跑了一次
// 「📤 手动发布开始」，两次都把 307 条历史会话完整扫了一遍 —— 按钮被点了两下。
let publishInFlight = false;
let publishLastAt = 0;
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
    // Windows 托盘气泡：告诉用户窗口缩到哪去了。每次会话只提示一次，别烦人。
    if (!globalThis.__trayHintShown && tray) {
      globalThis.__trayHintShown = true;
      try {
        tray.displayBalloon({
          title: 'XNOWPost 还在后台运行',
          content: '定时任务照常执行。单击托盘里的粉色 X 图标（或再双击桌面图标）可恢复窗口。',
        });
      } catch (_) { /* 有些系统不支持气泡，忽略 */ }
    }
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

// === FoxProfile 地址 + 小工具（模块级：守护/自检也会用到，不能放在 setupIPC 里）===
const foxBase = () =>
  String(loadConfig().foxApiBase || 'http://127.0.0.1:8000/api/v1').replace(/\/+$/, '');

/** 跑一条命令并收 stdout（Promise 版；失败返回 '' 不抛，调用方自己判） */
function execFileP(cmd, args) {
  return new Promise((resolve) => {
    let out = '';
    try {
      const c = spawn(cmd, args, { windowsHide: true });
      c.stdout?.on('data', (d) => { out += d.toString(); });
      c.stderr?.on('data', () => {});
      c.on('error', () => resolve(''));
      c.on('close', () => resolve(out));
    } catch (_) {
      resolve('');
    }
  });
}

/**
 * 自检：FoxProfile 是不是被设成了"浏览器也无窗口"。
 *
 * 2026-10-28 真实事故：为了不让用户点 × 关掉后端，我们把 FoxProfile 跑成 headless
 * （FOXPROFILE_HEADLESS=1）。但那个开关在 FoxProfile 里同时管两件事，于是 camoufox
 * 带着 `-headless` 启动 —— 进程在跑、`/page/screenshot` 也能出图，**桌面上却什么都看不到**，
 * 用户点「启动」后一脸问号（本人原话：「我没看到你打开浏览器窗口啊，是不是功能还不全」）。
 * 更糟的是无头模式下视频解码也失败，TikTok 首页一直报
 * `We're having trouble playing this video`（MediaError 4）。
 *
 * 现在 FoxProfile 把两件事拆开了（FOXPROFILE_BROWSER_HEADLESS），守护脚本会显式传 0；
 * 这里再兜一层：老服务（或别人手动起的）如果还是无头，就在没有环境运行时静默重启一次。
 * @returns {Promise<boolean>} true = 现在是"浏览器有窗口"的正常形态
 */
async function ensureFoxProfileHeaded() {
  let info = null;
  try {
    const r = await fetch(`${foxBase()}/info`, { signal: AbortSignal.timeout(4000) });
    info = await r.json();
  } catch (_) {
    return false; // 服务都没起来，交给守护脚本处理
  }
  // /info 的 headless 字段 = 浏览器是否无窗口（FoxProfile 侧语义）
  if (!info?.headless) return true;

  // 有环境开着就别动：重启服务会把它们一起关掉
  let running = [];
  try {
    const r = await fetch(`${foxBase()}/browser`, { signal: AbortSignal.timeout(4000) });
    running = (await r.json())?.running || [];
  } catch (_) {
    /* 读不到就当没有 */
  }
  if (running.length) {
    addLog('warning', `⚠️ FoxProfile 当前是"浏览器无窗口"模式，有 ${running.length} 个环境在跑，先不动它；关掉环境后会自动纠正`);
    return false;
  }

  addLog('warning', '🔧 FoxProfile 处于"浏览器无窗口"模式（点启动看不到窗口、视频也放不出来），正在纠正…');
  const isSvc = (c) => /src[\\/]main\.py|browser[\\/]runner\.py/i.test(c || '');
  const procs = [];
  for (const name of ['pythonw.exe', 'python.exe']) {
    try {
      const list = await execFileP('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='${name}'" | Where-Object { $_.CommandLine -match 'src\\\\main\\.py|browser\\\\runner\\.py' } | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`,
      ]);
      procs.push(...String(list).split(/\r?\n/).filter(Boolean).filter((l) => isSvc(l.split('|')[1])));
    } catch (_) {
      /* 没权限/没进程都跳过 */
    }
  }
  for (const line of procs) {
    const pid = Number(line.split('|')[0]);
    if (pid) {
      try { process.kill(pid); } catch (_) { /* 已退出 */ }
    }
  }
  // 残留的浏览器进程一起清（无头的那些）
  try {
    await execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process camoufox -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue']);
  } catch (_) { /* 没有就算了 */ }

  await new Promise((r) => setTimeout(r, 2500));
  startFoxProfileGuard();
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = await fetch(`${foxBase()}/info`, { signal: AbortSignal.timeout(3000) });
      const cur = await r.json();
      if (!cur?.headless) {
        addLog('success', '✅ FoxProfile 已切回"浏览器有窗口"模式（点启动就能看见浏览器）');
        return true;
      }
    } catch (_) { /* 还在重启 */ }
  }
  addLog('error', '❌ FoxProfile 仍是无窗口模式，环境可能看不到浏览器窗口（请手动执行 scripts\\foxprofile-guard.ps1）');
  return false;
}

/**
 * FoxProfile 守护（2026-10-23）：
 * FoxProfile 没有托盘，点 × 会把整个服务关掉（8000 端口的 API 一起停）→ 定时任务全废。
 * 启动应用时调一次 scripts/foxprofile-guard.ps1：
 *   ① 服务没跑就自动拉起（约 10 秒）；
 *   ② 无论谁起的，都把它的界面窗口最小化 —— 窗口不碍眼，API 照常，
 *      任务执行时浏览器照样自动打开（实测最小化后 launch 环境 8.7 秒正常）。
 * 失败只记日志，绝不阻塞应用启动。
 */
function startFoxProfileGuard() {
  try {
    const script = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'foxprofile-guard.ps1')
      : path.join(ROOT, 'scripts', 'foxprofile-guard.ps1');
    if (!fs.existsSync(script)) return;
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true,
    });
    let out = '';
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.on('error', (e) => addLog('warning', `⚠️ FoxProfile 守护启动失败: ${e.message}`));
    child.on('close', (code) => {
      const txt = out.trim().replace(/\s+/g, ' ');
      if (txt.includes('starting') && txt.includes('api-ok')) {
        addLog('info', `🧩 FoxProfile 原本没在运行，已自动拉起（${txt}）`);
      }
      if (txt.includes('minimized')) {
        addLog('info', '🗕 已把 FoxProfile 界面收进任务栏（服务照常，跑任务时会自动开浏览器）');
      }
      if (code !== 0) {
        addLog('warning', `⚠️ FoxProfile 守护未成功（退出码 ${code}）：${txt || '无输出'}`);
      }
    });
  } catch (e) {
    addLog('warning', `⚠️ FoxProfile 守护异常: ${e.message}`);
  }
}

/**
 * FoxProfile 周期巡检（每 3 分钟）。
 *
 * 2026-10-24 真实事故：FoxProfile 在 10-23 21:22 之后自己没了（flet 窗口还在，python 后端已死），
 * 于是 02:00 那轮养号 0/10、08:30–09:15 十轮发布「先花钱生成、再卡在打不开环境」、
 * 10:00 采集全废。启动时守护一次是不够的，必须一直盯着。
 */
let foxProfileWatchTimer = null;
let foxProfileDownStreak = 0;

async function foxProfileAlive() {
  try {
    const r = await fetch('http://127.0.0.1:8000/api/v1/browser', { signal: AbortSignal.timeout(3000) });
    return r.ok || r.status < 500;
  } catch (_) {
    return false;
  }
}

function startFoxProfileWatchdog() {
  if (foxProfileWatchTimer) return;
  foxProfileWatchTimer = setInterval(async () => {
    if (await foxProfileAlive()) {
      if (foxProfileDownStreak > 0) addLog('info', '✅ FoxProfile 已恢复');
      foxProfileDownStreak = 0;
      return;
    }
    foxProfileDownStreak += 1;
    // 连续 2 次（约 6 分钟）都不通才动手，避免一次抖动就重启
    if (foxProfileDownStreak < 2) return;
    foxProfileDownStreak = 0;
    addLog('warning', '⚠️ FoxProfile 没响应（连续 2 次巡检），正在自动拉起…');
    startFoxProfileGuard();
  startFoxProfileWatchdog();
  }, 3 * 60 * 1000);
  foxProfileWatchTimer.unref?.();
}

async function createTray() {
  // 托盘图标 = **程序自己的图标**（2026-10-23 用户口径：「粉色X 图标换成原图标吧」）。
  // app.getFileIcon(当前 exe) 拿到的就是资源管理器/桌面快捷方式里那个图标，永远一致；
  // 拿不到才退回上次生成过的 PNG，再不行才现场画一个绿点。
  const iconDir = path.join(DATA_DIR, 'config');
  const iconPath = path.join(iconDir, 'tray-icon.png');
  let trayIcon = nativeImage.createEmpty();
  try {
    trayIcon = await app.getFileIcon(process.execPath, { size: 'small' });
  } catch (_) {
    trayIcon = nativeImage.createEmpty();
  }
  if (!trayIcon || trayIcon.isEmpty()) {
    try {
      trayIcon = nativeImage.createFromPath(process.execPath);
    } catch (_) { /* ignore */ }
  }
  if (!trayIcon || trayIcon.isEmpty()) {
    try {
      if (fs.existsSync(iconPath)) {
        trayIcon = nativeImage.createFromPath(iconPath);
      } else {
        fs.ensureDirSync(iconDir);
        fs.writeFileSync(iconPath, generateTrayIconPNG());
        trayIcon = nativeImage.createFromPath(iconPath);
      }
    } catch (_) {
      // 极端 fallback：用 1×1 透明像素
      trayIcon = nativeImage.createEmpty();
    }
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

// === 内置代理内核（xray）===
// 为什么放在模块级：app.whenReady 里要直接调 startProxyEngine()。
// 曾经把它写在 setupIPC() 内部（v1.8.0），whenReady 里那句直接 ReferenceError，
// 被 Promise 链吞掉 → 内核没起来、界面和日志都不报，用户看到的是"浏览器全打不开网站"。
const xrayBin = () =>
  proxyEngine.resolveXrayBin({ resourcesPath: process.resourcesPath, devRoot: ROOT });

/**
 * 起内核（幂等）。没配节点时只告警，不抛错 —— 首次打开软件时用户还没粘链接。
 * @returns {Promise<{ok:boolean, message?:string, pid?:number, ports?:number[]}>}
 */
async function startProxyEngine() {
  const saved = proxyEngine.readNode(DATA_DIR);
  if (!saved) {
    addLog('warning', '🔌 还没配置代理节点（配置 → 网络节点）：环境里的浏览器打不开外网');
    return { ok: false, message: '未配置节点' };
  }
  const r = await proxyEngine.startEngine({
    dataDir: DATA_DIR,
    bin: xrayBin(),
    ports: proxyEngine.ENGINE_PORTS,
  });
  if (r.ok) {
    addLog('success', `🔌 代理内核已启动（${describeNode(saved.node)}，端口 1080–1109）`);
  } else {
    addLog('error', `🔌 代理内核启动失败：${r.message}`);
  }
  return r;
}

// === IPC 处理器 ===
function setupIPC() {
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
    // 这一轮的开始时间（跑完自动回报要算耗时；也用于"太久了不是这一轮"的判定）
    const runStartedAt = Date.now();
    // mode 只认这三种，其它一律当 auto（引擎不认识的参数等于没传）。
    // ⚠️ 'text' 曾经没有映射 → 助手说"只出文案约 ¥0.01"，实际跑了 auto（视频+图文，
    //    ¥0.03、3 分钟）。2026-10-19 22:29 实测踩到，现在 --text-only 是真的。
    const args = mode === 'video' ? ['--video-only']
      : mode === 'post' ? ['--post-only']
        : mode === 'text' ? ['--text-only']
          : [];
    if (topic) { args.push('--topic'); args.push(topic); }
    // 绑定账号：引擎本来就支持 `--account NN --auto-publish`（定时任务一直这么跑），
    // 只是手动/助手这条路以前没接上 → 生成完不知道发哪，最后都落到账号 01。
    const bindAccount = String(options.account || '').trim();
    if (bindAccount) {
      args.push('--account', bindAccount);
      if (options.autoPublish !== false) args.push('--auto-publish');
    }
    engineCancelRequested = false;   // 新任务开始，清掉上一次的取消标记
    addLog('info', `🚀 引擎启动 — 模式: ${mode}${topic ? ` | 主题: ${topic}` : ''}${bindAccount ? ` | 发到账号 ${bindAccount}` : ''}`);

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
        // 这一轮跑完 → 主动把结果说回对话（用户不用守着时间问「OK 了吗」）。
        // 助手叫的、按钮点的都报；调度器那个独立进程不经过这里（它的进度在日志/调度进度里）。
        try {
          if (onEngineRunDone) {
            onEngineRunDone(
              cancelled ? 'cancelled' : (code === 0 && !errorMessage ? 'ok' : 'fail'),
              errorMessage || '',
              { at: runStartedAt, mode, topic, account: options.account || '', autoPublish: options.autoPublish !== false },
            );
          }
        } catch (_) { /* 回报失败不影响任务结果 */ }
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
  handle('logs:clear', () => {
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
          /*
           * 发布状态一并带出去（2026-10-19 加）：
           * 历史页原来只有「标题 + 视频/图文」，想知道"这条到底发出去没"必须回首页看，
           * 而首页那张「今日产出」卡片已经下放到这里 —— 所以状态必须在这里给全。
           * 判据只有文件：.published（含 confirmed:false = 未确认）、FAILED。
           */
          let published = false;
          let confirmOk = false;
          let publishEnv = '';
          let publishedAt = '';
          if (files.includes('.published')) {
            published = true;
            confirmOk = true;   // 老标记没有 confirmed 字段，按已确认算
            try {
              const meta = JSON.parse(fs.readFileSync(path.join(sp, '.published'), 'utf-8'));
              confirmOk = meta.confirmed !== false;
              publishEnv = meta.env || '';
              publishedAt = meta.publishedAt || '';
            } catch (e) { /* 坏标记按已发布处理，别当成没发 */ }
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
            published,
            confirmOk,
            publishEnv,
            publishedAt,
            failed: !published && files.includes('FAILED'),
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


  /**
   * 首页任务表（用户 2026-10-23：「首页能不能加个任务表，这样看得比较清楚」）。
   *
   * 分两段返回，因为「今天全跑完了」是最常见的情况（13:22 实测 22 条全跑完），
   * 那时候最该看的是**接下来**（哪怕在明天凌晨），而不是一张空表：
   *   upcoming —— 还没到的，按距现在排序，含明天；status 只有 pending / running
   *   done     —— 今天已经跑过的，带结论（ok / partial / failed / …）和耗时
   *
   * 数据只认落盘证据：
   *   1. data/runs/<今天>-<HHMM>-<jobId>.json   今天的结论
   *   2. 调度器日志最后一条「🚀 … 任务开始」没收尾  → running
   *   3. 时间过了、今天没记录 → 不进 upcoming，也不进 done（它今天确实没跑）
   */
  ipcMain.handle('schedule:plan', () => {
    const nowD = new Date();
    const today = nowD.toLocaleDateString('sv-SE');   // 本地日期，和调度器日志/记录同名
    const nowMin = nowD.getHours() * 60 + nowD.getMinutes();
    const pad = (n) => String(n).padStart(2, '0');
    const out = { today, now: pad(nowD.getHours()) + ':' + pad(nowD.getMinutes()), upcoming: [], done: [] };

    // ① 今天的轮次记录（同一任务多条时取最后一条）
    const byJob = new Map();
    try {
      const dir = path.join(DATA_DIR, RUNS_REL);
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!name.startsWith(today) || !name.endsWith('.json')) continue;
        try {
          const rec = fs.readJsonSync(path.join(dir, name));
          const id = Number(rec.jobId);
          if (!Number.isInteger(id)) continue;
          const prev = byJob.get(id);
          if (!prev || Number(rec.finishedAtMs || 0) >= Number(prev.finishedAtMs || 0)) byJob.set(id, rec);
        } catch (_) {
          /* 坏记录跳过，不影响整张表 */
        }
      }
    } catch (_) {
      /* 记录目录读不到就当今天没跑过 */
    }

    // ② 正在跑的是哪条（日志最后一条 🚀 还没有收尾行）
    let runningAt = '';
    try {
      const logFile = path.join(DATA_DIR, 'logs', 'scheduler-' + today + '.log');
      if (fs.existsSync(logFile)) {
        const st = fs.statSync(logFile);
        const from = Math.max(0, st.size - 200 * 1024);
        const fd = fs.openSync(logFile, 'r');
        const buf = Buffer.alloc(st.size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        fs.closeSync(fd);
        const lines = buf.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
        const START = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s*🚀\s*.+?\s*任务开始/;
        const END = /(✅\s*.+?完成|❌\s*.+?失败|⚠️\s*.+?(未确认|部分完成)|⏱️|⏭️\s*跳过|进程结束)/;
        let idx = -1;
        for (let k = lines.length - 1; k >= 0; k--) {
          if (START.test(lines[k])) { idx = k; break; }
        }
        if (idx >= 0 && !lines.slice(idx + 1).some((l) => END.test(l))) {
          const m = lines[idx].match(START);
          if (m) runningAt = m[1].slice(11, 16);
        }
      }
    } catch (_) {
      /* 日志读不到就不标「执行中」 */
    }

    // ③ 组表
    let jobs = [];
    try {
      jobs = fs.existsSync(scheduleFile()) ? fs.readJsonSync(scheduleFile()) : [];
    } catch (_) {
      jobs = [];
    }
    const MODE_TEXT = { auto: '视频+图文', video: '仅视频', text: '仅图文', batch: '批量生成+发布', warmup: '养号', collect: '数据采集', post: '发布' };
    const str = (v) => (v === undefined || v === null ? '' : String(v));

    for (const j of Array.isArray(jobs) ? jobs : []) {
      if (!j || !/^\d{1,2}:\d{2}$/.test(str(j.time))) continue;
      if (j.enabled === false) continue;
      const [h, m] = str(j.time).split(':').map(Number);
      const at = h * 60 + m;
      const mode = str(j.mode) || 'auto';
      const warm = str(j.warmupAccounts).split(',').map((x) => x.trim()).filter(Boolean);
      // 养号 / 批量 = 一个闹钟一串账号；其它模式只有一个「发到哪个号」
      const multi = mode === 'warmup' || mode === 'batch';
      const accs = multi ? warm : (str(j.account) ? [str(j.account)] : []);
      const base = {
        id: Number(j.id) || 0,
        time: str(j.time),
        label: str(j.label) || MODE_TEXT[mode] || mode,
        modeText: MODE_TEXT[mode] || mode,
        accounts: accs,
        accountsText: multi
          ? (accs.length ? accs.length + ' 个号：' + accs.join(',') : '没勾账号')
          : (accs[0] ? '账号 ' + accs[0] : '仅生成'),
        durationText: mode === 'warmup' && Number(j.warmupMinutesMax) > 0
          ? '每号随机 ' + (Number(j.warmupMinutesMin) || Number(j.warmupMinutesMax)) + '~' + Number(j.warmupMinutesMax) + ' 分钟'
          : '',
      };

      const rec = byJob.get(base.id);
      if (rec) {
        // 今天跑过了 —— 结论进 done（就算时间还没到，也说明它真跑过，按记录说话）
        out.done.push({
          ...base,
          status: str(rec.result) || 'failed',
          finishedAt: rec.finishedAt
            ? new Date(rec.finishedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
            : '',
          tookSec: Math.round(Number(rec.durationMs || 0) / 1000),
          reason: str(rec.reason),
        });
      }

      // 「接下来」= 这条任务的**下一次**是什么时候。
      // 注意：今天跑过的任务下一次是明天 —— 2026-10-23 13:30 实测当天 22 条全跑完，
      // 旧写法这时候「接下来」是空的，用户看到一张空表，等于白做。
      const running = runningAt && runningAt === base.time;
      if (running) {
        out.upcoming.push({ ...base, day: '今天', status: 'running', minsFromNow: 0 });
      } else if (!rec && at > nowMin) {
        out.upcoming.push({ ...base, day: '今天', status: 'pending', minsFromNow: at - nowMin });
      } else {
        // 有记录（今天已跑）或今天这个点已过却没记录 → 下一次都在明天同一时刻
        out.upcoming.push({ ...base, day: '明天', status: 'pending', minsFromNow: 24 * 60 - nowMin + at });
      }
    }

    out.upcoming.sort((a, b) => a.minsFromNow - b.minsFromNow || a.time.localeCompare(b.time));
    out.done.sort((a, b) => b.time.localeCompare(a.time));
    return out;
  });

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
      writeJsonAtomicSync(file, fixed, 2);
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

  // ── 长期记忆（`data/assistant-memory.json`）──────────────────────────
  // 跨对话保留用户习惯。注意：记忆会拼进**每一轮**的系统提示词，
  // 所以条数和长度都有上限（`MEMORY_LIMIT` / `MEMORY_MAX_TEXT`），超了丢最老的。
  const assistantMemoryFile = () => path.join(DATA_DIR, 'data', 'assistant-memory.json');

  function readMemory() {
    try {
      const file = assistantMemoryFile();
      if (!fs.existsSync(file)) return [];
      const j = fs.readJsonSync(file);
      if (Array.isArray(j)) return j.filter((x) => x && x.text);
      return Array.isArray(j?.items) ? j.items.filter((x) => x && x.text) : [];
    } catch (e) {
      addLog('warning', `AI 助手记忆读不出来（当空处理，不覆盖原文件）：${e.message}`);
      return [];
    }
  }

  function writeMemory(list) {
    try {
      fs.ensureDirSync(path.join(DATA_DIR, 'data'));
      fs.writeJsonSync(assistantMemoryFile(), Array.isArray(list) ? list : [], { spaces: 2 });
      return true;
    } catch (e) {
      addLog('error', `AI 助手记忆写不进去：${e.message}`);
      return false;
    }
  }

  // ── 写操作快照 / 撤销 ────────────────────────────────────────────────
  // 只快照会被改的那几个小 JSON（config/user.json、config/schedule.json）。
  // 撤销 = 原样盖回去，比"再执行一次反向操作"可靠（反向操作遇到中间态会改出新花样）。
  // 边界：撤销只在本进程内有效（重启后记录不再提供），窗口 30 分钟。
  const assistantUndoDir = () => path.join(DATA_DIR, 'data', 'assistant-undo');
  let undoStack = [];

  function assistantTxBegin(label, relPaths) {
    const id = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const dir = path.join(assistantUndoDir(), id);
    const files = [];
    try {
      fs.ensureDirSync(dir);
      relPaths.forEach((rel, i) => {
        const abs = path.join(DATA_DIR, rel);
        if (fs.existsSync(abs)) {
          const backup = path.join(dir, `${i}.bak`);
          fs.copyFileSync(abs, backup);
          files.push({ rel, abs, backup, existed: true });
        } else {
          files.push({ rel, abs, backup: '', existed: false });
        }
      });
    } catch (e) {
      addLog('warning', `AI 助手快照失败（这次改动将不可撤销）：${e.message}`);
      return null;
    }
    const tx = { id, at: Date.now(), label, files, undone: false };
    undoStack.unshift(tx);
    undoStack = undoStack.slice(0, UNDO_KEEP);
    // 清掉被挤出窗口的快照目录（否则每次改配置都留一份备份，一个月能攒几百个）
    try {
      const root = assistantUndoDir();
      for (const d of fs.readdirSync(root)) {
        if (undoStack.some((t) => t.id === d)) continue;
        fs.rmSync(path.join(root, d), { recursive: true, force: true });
      }
    } catch (_) { /* 清理失败不影响撤销 */ }
    return tx;
  }

  async function assistantUndo(id) {
    const tx = undoStack.find((t) => String(t.id) === String(id));
    if (!tx) return { ok: false, error: '找不到这条可撤销记录（可能已过期，或应用重启过）' };
    if (!canUndo(tx)) return { ok: false, error: tx.undone ? '这一步已经撤销过了' : '超过 30 分钟，已经不能撤销' };
    const restored = [];
    for (const f of tx.files) {
      try {
        if (f.existed && f.backup && fs.existsSync(f.backup)) {
          fs.ensureDirSync(path.dirname(f.abs));
          fs.copyFileSync(f.backup, f.abs);
          restored.push(f.rel);
        } else if (!f.existed && fs.existsSync(f.abs)) {
          fs.rmSync(f.abs, { force: true });
          restored.push(`${f.rel}（删掉新增文件）`);
        }
      } catch (e) {
        return { ok: false, error: `恢复 ${f.rel} 失败：${e.message}` };
      }
    }
    tx.undone = true;
    if (restored.some((r) => r.startsWith('config/user.json'))) {
      try {
        saveConfig(loadConfig()); // 回滚后要把 Key 等环境变量重新同步一遍
      } catch (e) {
        addLog('warning', `回滚后同步配置失败：${e.message}`);
      }
    }
    addLog('info', `↩️ AI 助手撤销：${tx.label}（${restored.join('、') || '无实际改动'}）`);
    assistantLedger({
      at: new Date().toISOString(),
      tool: 'undo',
      level: 'write',
      confirmed: true,
      ok: true,
      ms: 0,
      args: { id: tx.id },
      brief: `撤销：${tx.label}`,
    });
    return { ok: true, label: tx.label, restored, message: `已撤销：${tx.label}` };
  }

  /** 让系统提示词里的记忆段立刻生效（不重建会话，保留当前对话） */
  function refreshAssistantPrompt() {
    if (!assistantSession) return;
    const config = loadConfig();
    const model = String(config.deepseekModel || '').trim() || 'deepseek-chat';
    assistantSession.updateSystemPrompt(
      buildSystemPrompt({ today: localDateStr(), appVersion: app.getVersion(), model, memory: readMemory() }),
    );
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
        let pendingOld = 0;
        let skipped = '';
        try {
          // 口径必须和界面「待发布内容」一致（含历史日期）。
          // 以前只传 onlyToday:true → 助手答「待发 0」，而首页卡片写着「27 项」，
          // 用户会以为队列空了（2026-10-19 实测）。
          // ⚠️ 用 `pending` 而不是 `items`：`items` 是"本轮能发的候选"（已按 onlyToday 过滤，
          //    且不含 FAILED 待重试），`pending` 才是界面那张列表的同一份数据，
          //    `old` 标记也只在 pending 里有。
          const r = scanUnpublished({ outputDir: outDir, today, onlyToday: false, maxCount: 0 });
          const all = r.pending || [];
          pendingCount = all.filter((i) => !i.old).length;
          pendingOld = all.length - pendingCount;
          skipped = summarizeSkips(r.skipped || []);
        } catch (_) { /* 输出目录还没有 */ }
        return {
          ok: true,
          summary: `今天已发 ${pub.published} / 未确认 ${pub.unconfirmed} / 失败 ${pub.failed}，`
            + `待发 当天 ${pendingCount} 条${pendingOld ? `（另有历史 ${pendingOld} 条未发，要在界面勾「含旧会话」才发得出去）` : ''}`,
          engine: { running: st.running, configured: st.configured, consecutiveFailures: st.consecutiveFailures, recentErrors: st.recentErrors },
          scheduler: { running: st.schedulerRunning },
          today: { date: today, published: pub.published, unconfirmed: pub.unconfirmed, failed: pub.failed, sessions: pub.sessions },
          pendingCount,
          pendingOld,
          pendingTotal: pendingCount + pendingOld,
          stage: currentStage(),
          skipped,
          nextJob: nextEnabledJob(),
        };
      }
      case 'get_today_publish': {
        const pub = buildPublishDay(args.date || today);
        return { ok: true, summary: `${pub.date}：已发 ${pub.published} / 未确认 ${pub.unconfirmed} / 失败 ${pub.failed}（共 ${pub.sessions} 场）`, ...pub };
      }
      // ── 「刚才那次到底成没成」：三处证据合起来给一个三态结论 ─────────────────
      // 起因（2026-10-19 用户截图）：助手跑完 run_publish 只回「发布已启动」，用户不知道发没发出去。
      // 「已启动」≠「已发布」，所以这里只认落盘证据：发布账本 / .published / FAILED / 进程还在不在。
      case 'get_last_task': {
        const minutes = Math.min(Math.max(Number(args.minutes) || 40, 5), 240);
        const since = Date.now() - minutes * 60 * 1000;
        const isAlive = (p) => !!(p && !p.killed && p.exitCode === null);

        const running = [];
        if (isAlive(engineProcess)) running.push('生成（引擎）');
        if (isAlive(collectProcess)) running.push('采集');
        if (schedulerRunning) running.push('调度器任务');

        // ① 发布账本：唯一能证明"真的发出去了"的东西
        const publishedRows = [];
        try {
          const f = path.join(DATA_DIR, 'data', 'publish-ledger.jsonl');
          if (fs.existsSync(f)) {
            for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
              if (!line.trim()) continue;
              let row = null;
              try { row = JSON.parse(line); } catch (_) { continue; }
              const at = Date.parse(row.at || '');
              if (!Number.isFinite(at) || at < since) continue;
              publishedRows.push({
                at: new Date(at).toISOString(),
                env: row.env || '',
                session: row.session || '',
                title: String(row.title || '').slice(0, 50),
              });
            }
          }
        } catch (_) { /* 账本读不到就当没有 */ }

        // ② 当天最近 3 场会话：.published / FAILED / 有没有成片
        const sessions = [];
        try {
          const dayDir = path.join(DATA_DIR, 'output', today);
          if (fs.existsSync(dayDir)) {
            const names = fs.readdirSync(dayDir)
              .filter((n) => { try { return fs.statSync(path.join(dayDir, n)).isDirectory(); } catch (_) { return false; } })
              .sort((a, b) => sessionTime(a).localeCompare(sessionTime(b)))
              .slice(-3)
              .reverse();
            for (const n of names) {
              sessions.push(readSessionRow(dayDir, n, since));
            }
          }
        } catch (_) { /* 目录读不到忽略 */ }

        // ②b 点名某一轮（用户说「pm_1911 那轮跑完了吗」）：只在给了 session 时才查。
        // 没有这个参数时，助手只能看到"最近 3 场"，容易把别的场次的事情安到它头上。
        let focused = null;
        let focusedMissing = '';
        const wantSession = String(args.session || '').trim();
        if (wantSession) {
          const norm = wantSession.replace(/\.txt$/, '');
          const withDate = norm.match(/^(\d{4}-\d{2}-\d{2})[\/\\]([a-z]{2}_\d{4})$/i);
          const bare = norm.match(/^([a-z]{2}_\d{4})$/i);
          if (withDate) {
            const d = withDate[1];
            const dir = path.join(DATA_DIR, 'output', d);
            if (fs.existsSync(path.join(dir, withDate[2]))) focused = readSessionRow(dir, withDate[2], 0);
            else focusedMissing = `没有 ${d}/${withDate[2]} 这个会话目录`;
          } else if (bare) {
            // 只给 pm_1911：先查今天，再往前翻 7 天
            for (let i = 0; i < 8 && !focused; i++) {
              const d = localDateStr(new Date(Date.now() - i * 86400000));
              const dir = path.join(DATA_DIR, 'output', d);
              if (fs.existsSync(path.join(dir, bare[1]))) {
                focused = readSessionRow(dir, bare[1], 0);
                focused.date = d;
              }
            }
            if (!focused) focusedMissing = `最近 8 天没有 ${bare[1]} 这个会话目录`;
          } else {
            focusedMissing = `session 参数格式不对：「${wantSession}」，应该是 pm_1911 或 2026-10-19/pm_1911`;
          }
        }

        // ③ 裁决（优先级：真在跑 > 有新账本 > 未确认 > 失败 > 有片没发 > 断了/中断）
        const lastLedger = publishedRows[publishedRows.length - 1] || null;
        const lastSession = sessions[0] || null;
        // 当前跑到哪一步：读今天 app 日志尾部推断（用户等 2~3 分钟时最想知道的就是这个）
        const stage = currentStage();
        let verdict = 'none';
        let verdictText = '';
        if (running.length) {
          verdict = 'running';
          // 「还在跑」必须带上"跑到哪了 + 多久没动静"，否则用户只能反复问
          const st = stage ? `，当前：${stage.label}${stage.at ? `（${stage.at}）` : ''}` : '';
          verdictText = `⏳ 还在跑：${running.join('、')}${st}`;
        } else if (lastLedger) {
          verdict = 'success';
          // 账本里的 at 是 UTC。以前这里直接 toISOString().slice(11,16) → 北京时间少 8 小时
          // （2026-10-19 实测：21:43 发的，助手说 13:43）。时间一律转本地再显示。
          const t = localHHMM(lastLedger.at);
          verdictText = `✅ 已发布：${lastLedger.env || '未知环境'}${t ? ` · ${t}` : ''}${lastLedger.title ? ` · ${lastLedger.title}` : ''}`;
        } else if (lastSession && lastSession.failed && lastSession.failed.published) {
          verdict = 'unconfirmed';
          verdictText = `⚠️ 未确认：${lastSession.session} 点过发布但没能证明已公开（不重发，请到后台核对）`;
        } else if (lastSession && lastSession.failed) {
          verdict = 'failed';
          verdictText = `❌ 失败：${lastSession.session}${lastSession.failed.stage ? ` 卡在「${lastSession.failed.stage}」` : ''}${lastSession.failed.reason ? ` · ${lastSession.failed.reason}` : ''}`;
        } else if (lastSession && lastSession.published) {
          verdict = lastSession.published.confirmed ? 'success' : 'unconfirmed';
          verdictText = verdict === 'success'
            ? `✅ 已发布：${lastSession.session}${lastSession.published.env ? ` · ${lastSession.published.env}` : ''}`
            : `⚠️ 未确认：${lastSession.session}（点过发布，未能证明已公开）`;
        } else if (lastSession && lastSession.hasVideo) {
          verdict = 'not_published';
          verdictText = `📦 成片已生成但还没发：${lastSession.session}（${minutes} 分钟内没有发布记录）`;
        } else if (lastSession) {
          // 只有目录、没有成片/发布/失败标记：必须区分「真在跑」和「早就断了」。
          // 踩过（2026-10-19 21:40）：pm_1911 是 19:11 那轮，3 秒就被取消，助手却答
          // 「还在生成，没有成片、也没发布」——用户会一直等一个死掉的会话。
          const quiet = lastSession.ageMin >= 15;
          if (quiet) {
            verdict = 'stalled';
            const files = (lastSession.files || []).join('、') || '（空目录）';
            verdictText = `⚠️ ${lastSession.session} 这轮没跑完就断了：${lastSession.time} 开始，`
              + `${lastSession.ageMin} 分钟没有任何动静，也没有成片/发布/失败标记（目录里只有 ${files}）`
              + '——多半是被取消或中途崩溃，不是"还在生成"';
          } else {
            verdict = 'running';
            const st = stage ? `，当前：${stage.label}${stage.at ? `（${stage.at}）` : ''}` : '';
            verdictText = `⏳ ${lastSession.session} 还在生成（${lastSession.time} 开始，约 ${lastSession.ageMin} 分钟，还没有成片）${st}`;
          }
        } else {
          verdictText = `${minutes} 分钟内没有生成/发布/采集记录`;
        }

        // ②c 点名的那一场优先：用户问「pm_1911 那轮跑完了吗」，就必须只答那一场，
        // 不能用"最近一次发布成功"糊过去（2026-10-19 实测：助手把 21:43 的成功
        // 当成了 pm_1911 的结果，还自己编了"它只生成了文案"）。
        if (wantSession) {
          const d = focused ? describeSession(focused) : focusedMissing;
          if (focused) {
            verdict = focused.published ? (focused.published.confirmed ? 'success' : 'unconfirmed')
              : focused.failed ? (focused.failed.published ? 'unconfirmed' : 'failed')
                : (focused.ageMin >= 15 || !running.length) ? 'stalled' : 'running';
          }
          verdictText = `${focused ? '📋' : '❓'} ${d}`;
        }
        // 最近一场会话的状态始终带一句：只报"上次发布成功"会掩盖后面那一轮断掉的事实
        const sessionLine = lastSession && (!lastLedger || lastSession.session !== lastLedger.session)
          ? describeSession(lastSession) : '';

        const notes = [];
        if (verdict === 'running') notes.push('等它跑完再问一次，别把「已启动」当「已发布」');
        if (verdict === 'stalled') notes.push('这轮已经没有进程在跑了：要重跑就再起一轮，别继续等');
        if (verdict === 'unconfirmed') notes.push('未确认的重发会产生重复作品，先去 TikTok 后台看一眼');
        if (verdict === 'failed') notes.push('可以用 explain_failures 拿失败证据，或重跑一轮');
        return {
          ok: true,
          verdict,
          verdictText,
          summary: sessionLine && !wantSession ? `${verdictText}；最近一场：${sessionLine}` : verdictText,
          minutes,
          running,
          stage,
          session: wantSession ? (focused || null) : undefined,
          lastSession: lastSession || null,
          published: publishedRows.slice(-5),
          sessions,
          notes,
        };
      }
      case 'get_pending': {
        // 队列口径和界面「待发布内容」完全一致（含历史日期，按 新→旧），
        // 这样助手说的「第 N 条」和用户在界面上数的是同一条（2026-10-19 统一）。
        const r = scanUnpublished({
          outputDir: outDir,
          today,
          onlyToday: false,
          maxCount: 0,
        });
        const queue = (r.pending || []).map((p, i) => ({
          n: i + 1,
          key: `${p.date}/${p.session}`,
          date: p.date,
          session: p.session,
          time: p.time,
          title: String(p.title || '').slice(0, 40),
          old: !!p.old,
          type: p.type,
        }));
        const todayCount = queue.filter((q) => !q.old).length;
        return {
          ok: true,
          summary: `待发 ${queue.length} 条（当天 ${todayCount} 条 + 历史 ${queue.length - todayCount} 条），按生成时间新→旧`,
          includeOld: args.includeOld === true,
          count: queue.length,
          todayCount,
          // 序号 n 就是"用户说的第几条"，run_publish 的 pick 可以直接照抄
          items: queue.slice(0, 12),
          order: '新→旧（日期倒序 → 同一天 pm 先于 am → 同前缀时间倒序）',
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
      // ── 账号域（原来助手只能"看"，登录/资料都得人点界面）──────────────────────
      // 登录和拉资料要跑几分钟到几十分钟，所以这里**不 await**：起完就返回 started，
      // 结果由 get_last_task / get_logs 去查（和 run_engine 一个口径，别把对话卡死）。
      case 'manage_accounts': {
        const op = String(args.op || '');
        const only = String(args.only || '').trim().toUpperCase();
        const env = String(args.env || '').trim().toUpperCase();
        const fire = (promise, kind) => {
          Promise.resolve(promise)
            .then((r) => addLog(r && r.ok === false ? 'error' : 'info',
              `${r && r.ok === false ? '❌' : '✅'} 助手${kind}结束${r && r.ok === false ? `：${r.message || r.code || '失败'}` : ''}`))
            .catch((e) => addLog('error', `❌ 助手${kind}出错：${e.message}`));
        };
        if (op === 'login') {
          const fn = ACTIONS.get('accounts:run');
          if (!fn) return { ok: false, error: '登录功能的处理器没注册' };
          fire(fn(null, { only: only || undefined, force: args.force === true, dryRun: args.dryRun === true }), '登录');
          return {
            ok: true,
            started: true,
            summary: `已启动登录${only ? `（${only}）` : '（全部待登录账号）'}${args.dryRun === true ? '，演练不真的登录' : ''}`
              + '。它会打开浏览器，10 个号约 10~20 分钟；完事后问「登录好了吗」我用 get_last_task 查',
          };
        }
        if (op === 'sync_profiles') {
          const fn = ACTIONS.get('accounts:syncProfiles');
          if (!fn) return { ok: false, error: '拉资料的处理器没注册' };
          fire(fn(null, { only: only || undefined }), '拉资料');
          return { ok: true, started: true, summary: `已启动拉取账号资料${only ? `（${only}）` : '（所有账号）'}，约 30 秒/号` };
        }
        if (op === 'edit_profile') {
          if (!env) return { ok: false, error: 'op=edit_profile 必须给 env（如 "TK04"）' };
          if (!args.name && !args.bio) return { ok: false, error: '至少给一个要改的字段：name 或 bio' };
          const job = { env };
          if (args.name) job.name = String(args.name);
          if (args.bio) job.bio = String(args.bio);
          const fn = ACTIONS.get('accounts:editProfiles');
          if (!fn) return { ok: false, error: '改资料的处理器没注册' };
          fire(fn(null, { jobs: [job], dryRun: args.dryRun === true }), '改资料');
          const bits = [args.name ? `昵称「${args.name}」` : '', args.bio ? `简介「${String(args.bio).slice(0, 30)}」` : ''].filter(Boolean);
          return {
            ok: true,
            started: true,
            summary: `已启动改资料：${env} ${bits.join('，')}${args.dryRun === true ? '（演练，不保存）' : ''}，约 30 秒；改完我会用头像/昵称回读校验`,
          };
        }
        if (op === 'launch' || op === 'stop_env') {
          if (!env) return { ok: false, error: `op=${op} 必须给 env` };
          const fn = ACTIONS.get('accounts:launch');
          if (!fn) return { ok: false, error: '环境开关的处理器没注册' };
          const r = await fn(null, env, op === 'stop_env' ? 'stop' : 'launch');
          return r && r.ok !== false
            ? { ok: true, summary: `已${op === 'stop_env' ? '关闭' : '启动'}环境 ${env}` }
            : { ok: false, error: (r && r.message) || `环境 ${env} ${op === 'stop_env' ? '关闭' : '启动'}失败` };
        }
        return { ok: false, error: `不认识的 op：${op}` };
      }
      case 'admin_action': {
        const op = String(args.op || '');
        if (op === 'cancel_engine') {
          const r = await ACTIONS.get('engine:cancel')?.(null);
          return r && r.ok !== false ? { ok: true, summary: '已请求取消生成任务' } : { ok: false, error: r?.message || '取消失败' };
        }
        if (op === 'cancel_collect') {
          const r = await ACTIONS.get('collect:cancel')?.(null);
          return r && r.ok !== false ? { ok: true, summary: '已请求取消采集任务' } : { ok: false, error: r?.message || '取消失败' };
        }
        if (op === 'clear_logs') {
          const r = await ACTIONS.get('logs:clear')?.(null);
          return r && r.ok !== false ? { ok: true, summary: '已清空界面日志缓冲（磁盘日志保留）' } : { ok: false, error: '清空失败' };
        }
        if (op === 'push_report') {
          const r = await ACTIONS.get('report:push')?.(null, args.date || today);
          return r && r.ok !== false
            ? { ok: true, summary: `日报已推送${args.date ? `（${args.date}）` : ''}` }
            : { ok: false, error: r?.message || '推送失败（先在配置页填 Telegram Bot Token）' };
        }
        return { ok: false, error: `不认识的 op：${op}` };
      }
      case 'get_trend': {
        const days = Math.min(Math.max(Number(args.days) || 7, 1), 30);
        const r = await ACTIONS.get('report:trend')?.(null, days);
        // report:trend 的形状是 { "账号|指标": {account, platform, metric, dates[], values[]}, ... }
        const keys = r && typeof r === 'object' ? Object.keys(r) : [];
        if (!keys.length) return { ok: false, error: '还没有采集数据（analytics.db 里没有记录），趋势查不了' };
        const series = keys.slice(0, 12).map((k) => {
          const s = r[k];
          const lastIdx = Array.isArray(s.values) ? s.values.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).pop() : -1;
          const last = lastIdx >= 0 ? s.values[lastIdx] : null;
          return {
            account: s.account,
            metric: s.metric,
            last,
            lastDate: lastIdx >= 0 ? s.dates[lastIdx] : '',
            points: Array.isArray(s.values) ? s.values.filter((v) => v != null).length : 0,
          };
        });
        const dates = Array.isArray(r[keys[0]].dates) ? r[keys[0]].dates : [];
        return {
          ok: true,
          summary: `最近 ${days} 天：${series.length} 条曲线，${dates.length} 个日历天里只有 ${series.reduce((m, s) => Math.max(m, s.points), 0)} 天有数据（缺口是没采到，不是 0）`,
          days,
          dates,
          series,
        };
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
        const keys = Object.keys(v.patch).join(', ');
        // 改之前先快照（撤销用）。快照失败只告警、不拦着改
        assistantTxBegin(`改配置：${keys}`, ['config/user.json']);
        const config = loadConfig();
        const next = { ...config, ...v.patch };
        saveConfig(next);   // 与配置页「保存配置」同一份实现
        addLog('info', `🤖 AI 助手修改配置：${keys}${args.reason ? `（${args.reason}）` : ''}`);
        return { ok: true, summary: `已改 ${keys}（30 分钟内可撤销）`, applied: v.patch, undoable: true };
      }
      case 'schedule_action': {
        // ── 新建（2026-10-19 用户反馈：只能改/启停/删，做不了「帮我加 10 个闹钟」）──
        // 校验顺序刻意从便宜到贵：格式 → 账号存在 → 重复 → 才动盘。
        // 账号必须已存在：凭空造一个 `account: "11"` 的任务，调度器跑到点会发现没有这个环境。
        if (args.op === 'create') {
          // 批量：`items` = [{time, mode, account}]，最多 10 条（一次「帮我设 10 个闹钟」= 一张确认卡）
          const rawItems = Array.isArray(args.items) && args.items.length
            ? args.items
            : [{ time: args.time, mode: args.mode, account: args.account }];
          if (rawItems.length > 10) {
            return { ok: false, error: `一次最多新建 10 个任务，收到 ${rawItems.length} 条` };
          }
          const names = (loadConfig().accounts || []).map((a) => String(a.name || '')).filter(Boolean);
          const list = readScheduleJobs();
          const plan = [];
          for (const [i, raw] of rawItems.entries()) {
            const at = `第 ${i + 1} 条`;
            // 宽容输入、严格落盘：`8:30` / 全角冒号都收，写进 JSON 的永远是 `08:30`
            const time = normalizeJobTime(raw && raw.time);
            if (!time) {
              return { ok: false, error: `${at}时间不是合法的 HH:MM（24 小时制），收到「${(raw && raw.time) || ''}」` };
            }
            const mode = ['video', 'auto', 'post', 'collect'].includes(raw && raw.mode) ? raw.mode : 'video';
            const account = mode === 'collect' ? '' : String((raw && raw.account) || '').trim();
            if (mode !== 'collect') {
              if (!account) return { ok: false, error: `${at}必须指定 account（账号编号，如 "03"）` };
              if (names.length && !names.includes(account)) {
                return { ok: false, error: `${at}的账号 ${account} 不存在（现有：${names.join('、')}）` };
              }
            }
            // 重复检查：既有任务 + 本批里已经排进去的（同一批不许自撞）
            const clash = [...list, ...plan].find((j) => String(j.time) === time
              && String(j.mode || 'video') === mode
              && String(j.account || '') === account);
            if (clash) {
              return { ok: false, error: `${at}和已有任务重复了：#${clash.id || '（本批）'}（${time} · 账号 ${account || '-'}）` };
            }
            plan.push({ time, mode, account });
          }
          assistantTxBegin(
            plan.length === 1 ? `新建定时任务 ${plan[0].time}` : `批量新建 ${plan.length} 个定时任务`,
            ['config/schedule.json'],
          );
          const created = [];
          for (const p of plan) {
            const id = nextJobId(list);
            const label = SCHEDULE_MODE_LABEL[p.mode] || '仅视频';
            list.push({ id, time: p.time, mode: p.mode, label, enabled: true, account: p.account });
            created.push({ ...p, id, label });
          }
          const savedCreate = await ACTIONS.get('schedule:save')(null, list);
          if (!savedCreate || savedCreate.ok === false) {
            return { ok: false, error: `写 schedule.json 失败：${savedCreate?.message || '未知错误'}` };
          }
          for (const c of created) {
            addLog('info', `🤖 AI 助手新建定时任务：#${c.id} ${c.time} ${c.label} · 账号 ${c.account || '-'}`);
          }
          const brief = created.map((c) => `#${c.id} ${c.time} 账号 ${c.account || '-'}`).join('，');
          return {
            ok: true,
            ids: created.map((c) => c.id),
            id: created.length === 1 ? created[0].id : undefined,
            summary: created.length === 1
              ? `已新建 #${created[0].id}：每天 ${created[0].time} · ${created[0].label}${created[0].account ? ` · 账号 ${created[0].account}` : ''}（30 分钟内可撤销）`
              : `已新建 ${created.length} 个：${brief}（30 分钟内可撤销）`,
            undoable: true,
          };
        }
        if (!String(args.id || '').trim()) {
          return { ok: false, error: `op=${args.op} 必须给 id（先用 get_schedule 查）` };
        }
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
        assistantTxBegin(`定时任务 ${job.time} ${args.op}`, ['config/schedule.json']);
        const saved = await ACTIONS.get('schedule:save')(null, jobs);
        if (!saved || saved.ok === false) return { ok: false, error: saved?.message || '保存定时表失败' };
        addLog('info', `🤖 AI 助手${args.op === 'delete' ? '删除' : args.op === 'enable' ? '启用' : args.op === 'disable' ? '停用' : '修改'}定时任务 ${job.time} ${job.label || job.mode}`);
        return {
          ok: true,
          summary: `定时任务 ${job.time} 已${args.op === 'delete' ? '删除' : args.op === 'enable' ? '启用' : args.op === 'disable' ? '停用' : '修改'}（30 分钟内可撤销）`,
          jobs: saved.jobs?.length,
          undoable: true,
        };
      }

      case 'get_memory': {
        const list = readMemory();
        return {
          ok: true,
          summary: list.length ? `一共记住 ${list.length} 条` : '还没有任何记忆',
          memory: list.map((m) => ({ id: m.id, tag: m.tag, text: m.text, at: m.at })),
        };
      }
      case 'remember': {
        const list = readMemory();
        const entry = makeMemoryEntry(args.text, { tag: args.tag || '偏好', seq: list.length });
        if (!entry) return { ok: false, error: '记忆内容为空' };
        const r = mergeMemory(list, entry);
        if (!r.added && !r.duplicate) return { ok: false, error: '记忆没有变化' };
        writeMemory(r.list);
        if (r.added) addLog('info', `🧠 AI 助手记住：${entry.text}`);
        refreshAssistantPrompt(); // 立刻生效，不用等下次重建会话
        return {
          ok: true,
          summary: r.duplicate ? `这条已经记过了（更新了分类）：${entry.text}` : `已记住：${entry.text}`,
          duplicate: r.duplicate,
          total: r.list.length,
        };
      }
      case 'forget': {
        const r = dropMemory(readMemory(), args.id);
        if (!r.removed) return { ok: false, error: `没有 id=${args.id} 的记忆（先用 get_memory 查）` };
        writeMemory(r.list);
        addLog('info', `🧠 AI 助手忘掉一条记忆（id=${args.id}）`);
        refreshAssistantPrompt();
        return { ok: true, summary: `已忘掉，还剩 ${r.list.length} 条` };
      }

      case 'run_engine': {
        // 指定账号时必须先确认这个号真的存在，否则宁可不动（会花钱 + 会发错号）
        const wantAccount = String(args.account || '').trim();
        if (wantAccount) {
          const acc = (loadConfig().accounts || []).find((a) => String(a.name || '').trim() === wantAccount.padStart(2, '0'));
          if (!acc) return { ok: false, error: `配置里没有账号 ${wantAccount}（现有：${(loadConfig().accounts || []).map((a) => a.name).join('、')}）` };
        }
        // 只出文案（mode=text）没有成片可发 → 一定不自动发布，别让用户以为会发
        const isTextOnly = args.mode === 'text';
        const bindPublish = !!wantAccount && args.autoPublish !== false && !isTextOnly;
        // 记下"这一轮是助手发起的"：引擎进程结束时自动把结果推回对话，
        // 用户不用守着时间反复问「OK 了吗」。
        assistantRunWatch = {
          at: Date.now(),
          mode: isTextOnly ? 'text' : 'video',
          account: wantAccount ? wantAccount.padStart(2, '0') : '',
          autoPublish: bindPublish,
        };
        // 不 await：一轮生成要 5~15 分钟，等它结束对话就卡死了
        Promise.resolve(ACTIONS.get('engine:run')(null, args.mode, args.topic || '', {
          account: wantAccount || undefined,
          autoPublish: bindPublish,
        })).catch((e) => {
          addLog('error', `AI 助手启动生成失败：${e.message}`);
        });
        addLog('info', `🤖 AI 助手启动${isTextOnly ? '文案（只出文案）' : '视频'}生成${args.topic ? `（主题：${args.topic}）` : ''}${wantAccount ? ` → 发到账号 ${wantAccount}` : ''}`);
        return {
          ok: true,
          summary: isTextOnly
            ? `已启动「只出文案」：只调 DeepSeek（约 ¥0.01），不配音、不生图、不合成、不发布；跑完我会自动把结果发给你，不用守着问`
            : wantAccount
              ? `已启动生成，生成完会直接发到账号 ${wantAccount.padStart(2, '0')}${bindPublish ? '' : '（不自动发布）'}；跑完我会自动把结果发给你，不用守着问`
              : `已启动${args.mode === 'text' ? '文案' : '视频'}生成（账号按配置=通常 01），进度在控制台/日志页；跑完我会自动把结果发给你`,
          started: true,
          account: wantAccount || '',
        };
      }
      case 'run_publish': {
        const maxCount = clampPublishCount(args.maxCount);
        const wantAccount = String(args.account || '').trim();
        const wantEnv = String(args.env || '').trim().toUpperCase();
        // 指定了账号就校验存在性 —— 这条是 2026-10-19 发错号事故的直接护栏
        if (wantAccount) {
          const acc = (loadConfig().accounts || []).find((a) => String(a.name || '').trim() === wantAccount.padStart(2, '0'));
          if (!acc) return { ok: false, error: `配置里没有账号 ${wantAccount}` };
        }

        // 用户点名了具体哪一条 → 解析成 date/session；解析不出来就**报错**，
        // 绝不退回"那就发队列第一条"（那正是用户抱怨的"发哪条是随机的"）。
        const wantPick = (Array.isArray(args.pick) ? args.pick : (args.pick ? [args.pick] : []))
          .map((x) => String(x || '').trim()).filter(Boolean);
        let pickKeys = [];
        let pickMatched = [];
        if (wantPick.length) {
          const queue = scanUnpublished({ outputDir: outDir, today, onlyToday: false, maxCount: 0 }).pending || [];
          const res = resolvePublishSelectors(wantPick, queue);
          if (!res.ok) {
            const cands = (res.candidates || []).map((c) => `第${c.n}条 ${c.key}《${c.title}》`).join('；');
            return {
              ok: false,
              error: `${res.error}${cands ? `。可选的：${cands}` : ''}`,
              candidates: res.candidates || [],
            };
          }
          pickKeys = res.keys;
          pickMatched = res.matched;
          // 点名超过单次上限就不发，让模型（或用户）分批 —— 不静默截断
          if (pickKeys.length > PUBLISH_MAX_PER_TURN) {
            return {
              ok: false,
              error: `一次最多发 ${PUBLISH_MAX_PER_TURN} 条，你点名了 ${pickKeys.length} 条，请分批`,
              candidates: pickMatched,
            };
          }
        }

        Promise.resolve(ACTIONS.get('publish:run')(null, {
          ...(pickKeys.length ? { pick: pickKeys } : { maxCount }),
          ...(args.all === true && !pickKeys.length ? { all: true } : {}),
          includeOld: args.includeOld === true,
          ...(wantAccount ? { account: wantAccount } : {}),
          ...(wantEnv ? { env: wantEnv } : {}),
        })).catch((e) => {
          addLog('error', `AI 助手启动发布失败：${e.message}`);
        });
        const who = wantAccount ? ` → 账号 ${wantAccount}` : wantEnv ? ` → ${wantEnv}` : ' → 默认账号';
        if (pickKeys.length) {
          const list = pickMatched.map((m) => `第${m.n}条《${m.title}》`).join('、');
          addLog('info', `🤖 AI 助手启动发布（点名 ${pickKeys.length} 条：${pickKeys.join('、')}${who}）`);
          return {
            ok: true,
            summary: `已启动发布，只发点名的 ${pickKeys.length} 条${who}：${list}`,
            started: true,
            count: pickKeys.length,
            picked: pickMatched,
            account: wantAccount || '',
            env: wantEnv || '',
          };
        }
        addLog('info', `🤖 AI 助手启动发布（${args.all === true ? '当天全部' : `最多 ${maxCount} 条`}${args.includeOld ? '，含历史日期' : ''}${who}）`);
        return {
          ok: true,
          summary: args.all === true
            ? `已启动发布，发当天全部待发内容${who}`
            : `已启动发布，最多 ${maxCount} 条${wantAccount ? ` → 账号 ${wantAccount}` : wantEnv ? ` → ${wantEnv}` : '（发到默认账号 01，没指定账号）'}`,
          started: true,
          maxCount,
          account: wantAccount || '',
          env: wantEnv || '',
        };
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
    // 推理模型（v4-pro / reasoner）先想再答：上限给小了会返回空正文（CLAUDE.md 有实测）
    const reasoning = /reason|v4-pro/i.test(model);
    const maxTokens = reasoning
      ? Math.max(Number(config.deepseekMaxTokens) || 0, 8000)
      : Number(config.deepseekMaxTokens) || 4096;
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
      const think = message.reasoning_content ? `（思考 ${String(message.reasoning_content).length} 字）` : '';
      addLog('info', `🤖 AI 助手：${r.data?.model || model} ${Date.now() - started}ms · ${usage.prompt_tokens}+${usage.completion_tokens} tokens${think}`);
    }
    return { message, usage };
  }

  let assistantSession = null;
  let assistantSessionKey = '';

  /**
   * 把「助手发起的那一轮」的结果主动说回对话里。
   * 为什么不靠用户问：一轮 3~5 分钟，用户得盯着时间反复问「OK 了吗」。
   * 内容只用落盘证据（.published / FAILED / 账本 / cost.json），不用"已启动"。
   */
  /** 往对话里推一条"程序替他汇报"的消息（不是模型生成的），并把快照推给界面 */
  function pushAssistantNote(text) {
    const body = String(text || '').trim();
    if (!body) return;
    try {
      const snap = ensureAssistantSession().notify(body);
      if (snap && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('assistant:update', withUndo(snap));
      }
      addLog('info', `🤖 AI 助手自动回报：${body.slice(0, 60)}`);
    } catch (e) {
      addLog('warning', `AI 助手自动回报失败：${e.message}`);
    }
  }

  /**
   * 把「这一轮」的结果主动说回对话里（助手叫的 / 按钮点的都算）。
   * 为什么不靠用户问：一轮 3~5 分钟，用户得盯着时间反复问「OK 了吗」。
   * 内容只用落盘证据（.published / FAILED / 账本 / cost.json），不用"已启动"。
   */
  function reportEngineRun(outcome, errorMessage = '', meta = {}) {
    const startedAt = Number(meta.at) || Date.now();
    const byAssistant = !!assistantRunWatch;
    assistantRunWatch = null;      // 一次只回报一次
    if (Date.now() - startedAt > 120 * 60 * 1000) return;   // 太久了，多半不是这一轮
    const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    // 11 秒的只出文案别写成「1 分钟」（实测就是这么报的，看着像跑了很久）
    const mins = secs < 90 ? `${secs} 秒` : `${Math.round(secs / 60)} 分钟`;
    const who = byAssistant ? '' : '（手动）';
    const isText = meta.mode === 'text';
    let text = '';
    try {
      const dayDir = path.join(DATA_DIR, 'output', localDateStr());
      const names = fs.existsSync(dayDir)
        ? fs.readdirSync(dayDir)
          .filter((n) => { try { return fs.statSync(path.join(dayDir, n)).isDirectory(); } catch (_) { return false; } })
          .sort((a, b) => sessionTime(a).localeCompare(sessionTime(b)))
        : [];
      const row = names.length ? readSessionRow(dayDir, names[names.length - 1], 0) : null;
      // 花费：这一轮目录里的 cost.json
      let cost = '';
      try {
        const c = fs.readJsonSync(path.join(dayDir, row.session, 'cost.json'));
        const total = Number(c && c.total);
        if (Number.isFinite(total) && total > 0) {
          // 只出文案一轮就 ¥0.0039，两位小数会显示成「¥0.00」（看着像没花钱，其实花了）
          cost = ` · 花费约 ¥${total.toFixed(total < 0.1 ? 3 : 2)}`;
        }
      } catch (_) { /* 没有账单就不报花费 */ }
      // 标题：优先账本里那条，其次文案首行
      let title = '';
      try {
        const lines = fs.readFileSync(path.join(DATA_DIR, 'data', 'publish-ledger.jsonl'), 'utf-8').trim().split('\n');
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
          const r = JSON.parse(lines[i]);
          if (r && (!meta.account || String(r.env || '').endsWith(String(meta.account)))) { title = String(r.title || ''); break; }
        }
      } catch (_) { /* 账本坏行忽略 */ }

      // 只出文案（--text-only）：没有成片，标题从 文案.txt 首行读
      if (isText) {
        let t = '';
        try {
          t = String(fs.readFileSync(path.join(dayDir, row.session, '文案.txt'), 'utf-8')).split('\n')[0].trim();
        } catch (_) { /* 没有文案就是下面那条"没看到" */ }
        if (row && row.hasText) {
          text = `📝 文案好了（${mins}）：${row.session} 生成了《${t || '（无标题）'}》${cost}。没配音、没生图、没发布 —— 要发就说「发到 0N 号」，要重写就说主题。`;
        } else if (outcome === 'ok') {
          text = `⚠️ 进程正常退出（${mins}），但 ${row ? row.session : '这一轮'} 没写出 文案.txt —— 要我用 get_logs 看看是哪一步空转了吗？`;
        } else {
          text = `⚠️ 只出文案这一轮异常结束（${mins}）：${errorMessage || '退出码非 0'}。要我用 get_logs 翻一下吗？`;
        }
      } else if (outcome === 'cancelled') {
        text = `⏹ 停了${who}：${row ? row.session : '这一轮'} 被取消，跑了 ${mins}，没有发布。`;
      } else if (row && row.published) {
        const at = localHHMM(row.published.at);
        const env = row.published.env || '';
        text = `✅ 发布完成${who}（${mins}）：${row.session}${env ? ` → ${env}` : ''}${title ? `《${title}》` : ''}${at ? `，公开时刻 ${at}` : ''}${cost}。`;
      } else if (row && row.failed) {
        text = `❌ 失败${who}（${mins}）：${describeSession(row)}${errorMessage ? ` · ${errorMessage}` : ''}${cost}。要看证据我可以调 explain_failures。`;
      } else if (row && row.hasVideo) {
        const acc = String(meta.account || '').trim();
        text = `📦 成片出来了${who}（${mins}）：${describeSession(row)}${cost}。${acc ? `这次没发出去（目标 ${acc}），` : ''}要发到哪个账号？告诉我一声。`;
      } else if (outcome === 'ok') {
        text = `⚠️ 进程正常退出${who}（${mins}），但${row ? ` ${row.session} ` : ''}没看到成片也没看到发布记录 —— 要我用 explain_failures 查一下卡在哪吗？`;
      } else {
        text = `⚠️ 这一轮异常结束${who}（${mins}）：${errorMessage || `退出码非 0`}。要我用 get_logs 翻一下吗？`;
      }
    } catch (e) {
      text = `⚠️ 这一轮结束了（${mins}），但自动回报拼装失败：${e.message}。你问一句「刚才那条发成功了吗」我用 get_last_task 查。`;
    }
    pushAssistantNote(text);
  }

  // 把钩子挂到顶层 doRunEngine 的 finish() 上。
  // ⚠️ 必须在这里赋值，不能写在 reportEngineRun 函数体里 —— 那样只有"回报过一次"之后
  //    钩子才存在，于是永远回报不了（2026-10-19 22:30 实测：pm_2229 跑完了，一条回报都没有）。
  onEngineRunDone = reportEngineRun;

  /** 会话按「日期 + 模型 + 版本」重建（日期/模型变了，系统提示里的口径也要跟着变） */
  function ensureAssistantSession() {
    const config = loadConfig();
    const today = localDateStr();
    const model = String(config.deepseekModel || '').trim() || 'deepseek-chat';
    const key = `${today}|${model}|${app.getVersion()}`;
    if (assistantSession && assistantSessionKey === key) return assistantSession;
    const systemPrompt = buildSystemPrompt({ today, appVersion: app.getVersion(), model, memory: readMemory() });
    assistantSession = createAssistantSession({
      callModel: assistantCallModel,
      exec: assistantExec,
      systemPrompt,
      // 确认卡上要能显示"第几条《标题》"，所以把待发队列也交给预览函数
    // （只在有 pick 的工具上扫一次，别每次预览都扫目录）
    previewCtx: () => {
      const ctx = { config: loadConfig(), jobs: readScheduleJobs() };
      try {
        // 注意：这里在 ensureAssistantSession 里，`outDir` 不在作用域内（踩过一次：
        // 引用它抛 ReferenceError 被 catch 吞掉 → 确认卡永远退化成裸序号）。
        const oDir = path.join(DATA_DIR, 'output');
        ctx.pendingQueue = scanUnpublished({ outputDir: oDir, today, onlyToday: false, maxCount: 0 }).pending || [];
      } catch (_) {
        ctx.pendingQueue = [];
      }
      return ctx;
    },
      onLedger: assistantLedger,
      log: (m) => addLog('info', m),
    });
    assistantSessionKey = key;
    addLog('info', `🤖 AI 助手就绪（模型 ${model}，工具 ${publicTools().length} 个，记忆 ${readMemory().length} 条）`);
    return assistantSession;
  }

  /** 每个响应都捎上"现在能撤销什么"（界面据此显示「撤销」按钮） */
  const withUndo = (r) => ({ ...(r || {}), undo: listUndoable(undoStack) });

  handle('assistant:send', async (_event, text) => withUndo(await ensureAssistantSession().send(text)));
  handle('assistant:answer', async (_event, approvals) => withUndo(await ensureAssistantSession().answer(approvals)));
  handle('assistant:state', () => withUndo(ensureAssistantSession().snapshot()));
  handle('assistant:undo', async (_event, id) => withUndo(await assistantUndo(id)));
  handle('assistant:reset', () => {
    const s = ensureAssistantSession();
    s.reset();
    return withUndo({ ok: true });
  });

  /**
   * 给「定时轮次」记录凑落盘证据。
   *
   * ⚠️ 只用**已经发生的事**：`.published`（`confirmed:false` 不算成功）、`FAILED`、账本时间窗、
   *    `cost.json`、`collect-*.json`。读不到就返回空证据，让文案老老实实说"没看到"。
   * ⚠️ 账本必须按**本轮时间窗**过滤：publish 模式发的是历史会话，只看 `record.session` 会漏；
   *    不过滤又会把上一轮的发布算到这一轮头上。
   */
  function gatherRunEvidence(record) {
    const ev = {
      published: [],
      unconfirmedPublish: false,
      failed: null,
      hasVideo: false,
      hasText: false,
      cost: null,
      collect: null,
    };
    const startedMs = Number(record.startedAtMs) || Date.now();
    const date = record.date || localDateStr(new Date(startedMs));
    const dayDir = path.join(DATA_DIR, 'output', date);
    const from = startedMs - 60_000;
    const to = Number(record.finishedAtMs || Date.now()) + 120_000;
    // 标记 + 账本最后要按「环境 + 会话」去重：两者时间戳差 1 毫秒，
    // 直接拼会把 1 条说成「已发布 2 条」（见 src/scheduled-run.js#mergePublishedEvidence）
    const raw = [];
    const titles = new Map();        // 会话 → 文案首行（标记/账本里都可能没标题）
    try {
      if (record.session) {
        const row = readSessionRow(dayDir, record.session, 0);
        ev.hasVideo = !!row.hasVideo;
        ev.hasText = !!row.hasText;
        if (row.published) {
          if (row.published.confirmed) {
            raw.push({ env: row.published.env || '', session: record.session, at: row.published.at || '', title: '' });
          } else {
            ev.unconfirmedPublish = true;
          }
        }
        if (row.failed) ev.failed = { stage: row.failed.stage, reason: row.failed.reason };
        try {
          const c = fs.readJsonSync(path.join(dayDir, record.session, 'cost.json'));
          const total = Number(c && c.total);
          if (Number.isFinite(total) && total > 0) ev.cost = total;
        } catch (_) { /* 没有账单就不报花费 */ }
        try {
          const title = String(fs.readFileSync(path.join(dayDir, record.session, '文案.txt'), 'utf-8'))
            .split('\n')[0].trim();
          if (title) titles.set(record.session, title);
        } catch (_) { /* 没有文案就不报标题 */ }
      }
      // 账本里落在本轮时间窗内的发布（确认过的才算）
      for (const rec of readLedger(DATA_DIR)) {
        const at = Date.parse(rec.at || '');
        if (!Number.isFinite(at) || at < from || at > to) continue;
        // 账本行在「点击 Post 的瞬间」就写（confirmed:false），确认公开后才追加一条
        // confirmed:true。这里必须跳过未确认的行 —— 否则一轮被超时强杀、结果根本没确认，
        // 回报里也会说「已发布 → TKxx《…》」。
        if (rec.confirmed === false) continue;
        raw.push({ env: rec.env || '', session: rec.session || '', at: rec.at || '', title: rec.title || '' });
      }
      ev.published = mergePublishedEvidence(raw)
        .filter((p) => p.at || p.title)
        // 标题兜底：标记和账本都没标题时，用会话目录里 文案.txt 的首行
        .map((p) => (p.title || !titles.get(p.session) ? p : { ...p, title: titles.get(p.session) }));
      // 采集轮次：最近一份本轮时间窗内的 collect-*.json 才是这一轮的证据
      if (record.mode === 'collect' && fs.existsSync(dayDir)) {
        const files = fs.readdirSync(dayDir).filter((f) => /^collect-.*\.json$/.test(f)).sort();
        for (let i = files.length - 1; i >= 0; i--) {
          try {
            const c = fs.readJsonSync(path.join(dayDir, files[i]));
            const at = Date.parse(c.at || '');
            if (Number.isFinite(at) && at < from) continue;   // 不是这一轮的
            ev.collect = c;
            break;
          } catch (_) { /* 坏证据跳过 */ }
        }
      }
    } catch (_) { /* 证据读不到就不报细节，别让回报本身炸掉 */ }
    return ev;
  }

  /**
   * 监听调度器写下的轮次记录，跑完主动说进 AI 助手对话。
   *
   * 为什么需要：`reportEngineRun()` 只挂在 `doRunEngine()` 的 finish 上（界面按钮 / 助手叫的轮次），
   * 而 00:30 / 08:30 那些闹钟跑在 `src/scheduler.js` 独立进程里，结果以前只留在
   * `logs/scheduler-<日期>.log` —— 用户不问就永远不知道那一轮成没成。
   *
   * 读的是 `data/runs/*.json`（记录里带 startedAt/finishedAt，能和账本时间窗对齐），
   * 而不是去 grep 日志文本：日志是给人看的，措辞随时会改。
   */
  let runRecordTimer = null;
  function startScheduledRunReporter() {
    const dir = path.join(DATA_DIR, RUNS_REL);
    let busy = false;
    const scan = () => {
      if (busy) return;      // watch 抖动时不要并发重复回报同一批记录
      busy = true;
      try {
        for (const item of listPendingRunRecords(dir)) {
          try {
            pushAssistantNote(describeScheduledRun(item.record, gatherRunEvidence(item.record)));
          } catch (e) {
            addLog('warning', `定时轮次回报失败：${e.message}`);
          }
          markRunReported(item);   // 先推再标记：宁可能重复一次，也不能悄悄丢掉
        }
        const removed = pruneRunRecords(dir);
        if (removed) addLog('info', `🧹 清理 ${RUN_KEEP_DAYS} 天前的轮次记录 ${removed} 个`);
      } catch (e) {
        addLog('warning', `轮次记录扫描失败：${e.message}`);
      } finally {
        busy = false;
      }
    };
    try {
      fs.ensureDirSync(dir);
      fs.watch(dir, { persistent: false }, () => {
        // 先让调度器把文件写完（原子写已经保证不读半截，这里只是去抖）
        clearTimeout(runRecordTimer);
        runRecordTimer = setTimeout(scan, 800);
      });
    } catch (e) {
      addLog('warning', `轮次记录监听启动失败（改用轮询）：${e.message}`);
    }
    setInterval(scan, 30_000).unref?.();   // 兜底：watch 偶发丢事件也不会漏
    scan();                                 // 启动时补报应用重启期间写下的记录
  }

  startScheduledRunReporter();

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
  // 收件箱 / 截图 / 备份 / 报告的位置。
  // **收件箱（账号 txt）放安装目录下**：`<安装目录>\import\accounts`
  // （用户 2026-10-24 明确要求：「位置放在安装目录下面」—— 放 %APPDATA% 里他找不到）。
  // 安装目录不可写（比如装到 Program Files）时自动退回数据目录，绝不因为权限把导入弄坏。
  const INSTALL_DIR = app.isPackaged ? path.dirname(process.execPath) : ROOT;
  let inboxDirCache = '';
  const inboxDir = () => {
    if (inboxDirCache) return inboxDirCache;
    const want = [
      path.join(INSTALL_DIR, 'import', 'accounts'),
      path.join(DATA_DIR, 'import', 'accounts'),
    ];
    for (const dir of want) {
      try {
        fs.ensureDirSync(dir);
        const probe = path.join(dir, '.write-test');
        fs.writeFileSync(probe, '');
        fs.unlinkSync(probe);
        inboxDirCache = dir;
        return dir;
      } catch (_) {
        /* 不可写就看下一个 */
      }
    }
    inboxDirCache = want[want.length - 1];
    return inboxDirCache;
  };
  const accountDirs = () => ({
    inbox: inboxDir(),
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
          // 2FA 密钥也带上：凭据编辑弹窗要能读回（以前只有写没有读，弹窗一保存就会把它清空）
          totpSecret: st.totpSecret || '',
          region: info.region || st.region || acc.region || '',
          followers: info.followers || '',
          following: info.following || '',
          likes: info.likes || '',
          verified: !!info.verified,
          createTime: info.createTime || '',
          profileAt: info.fetchedAt || '',
          // 头像缓存键用**内容哈希**优先：同名同 URL 但内容变了（或被平台换回）时界面必须重载
          avatarAt: info.avatarChangedAt || info.fetchedAt || '',
          avatarSha: info.avatarSha || '',
          avatarIntendedSha: info.avatarIntendedSha || '',
          avatarReverted: !!info.avatarReverted,
          avatarRevertedAt: info.avatarRevertedAt || '',
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
  // 2026-10-24 用户口径：「新增账号的文件放一起最好，我点导入你能打开正确的路径吗」
  // → 默认就落在收件箱（<数据目录>\import\accounts）；如果他上次选的是别处，下次还去那儿。
  ipcMain.handle('accounts:pickFile', async () => {
    const d = accountDirs();
    fs.ensureDirSync(d.inbox);
    let defaultPath = d.inbox;
    try {
      const last = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'data', 'last-import.json'), 'utf8'));
      if (last && last.dir && fs.existsSync(last.dir)) defaultPath = last.dir;
    } catch {
      /* 没记录就用收件箱 */
    }
    const r = await electron.dialog.showOpenDialog(mainWindow, {
      title: '选择账号文件（用户名｜密码｜邮箱｜邮箱密码｜2FA密钥｜地区）',
      defaultPath,
      properties: ['openFile'],
      filters: [{ name: '账号文件', extensions: ['txt', 'csv'] }],
    });
    if (r.canceled) return null;
    // 记住这次选的目录，下次直接打开同一处（不要每次让用户重新翻盘）
    try {
      fs.mkdirSync(path.join(DATA_DIR, 'data'), { recursive: true });
      fs.writeFileSync(
        path.join(DATA_DIR, 'data', 'last-import.json'),
        `${JSON.stringify({ dir: path.dirname(r.filePaths[0]), at: new Date().toISOString() }, null, 2)}\n`,
      );
    } catch {
      /* 记不住也不影响导入 */
    }
    return r.filePaths[0];
  });

  // 打开收件箱目录
  ipcMain.handle('accounts:openInbox', async () => {
    const d = accountDirs();
    fs.ensureDirSync(d.inbox);
    await shell.openPath(d.inbox);
    return { ok: true, inbox: d.inbox };
  });

  // 备份账号文件：收件箱里的 txt/csv → 数据目录 + 一个 zip。
  // 收件箱按要求放在安装目录（好找），代价是**卸载/重装会跟着删掉**，所以给一个一键留底。
  ipcMain.handle('accounts:backupFiles', async () => {
    try {
      const d = accountDirs();
      if (!fs.existsSync(d.inbox)) return { ok: false, message: `收件箱还没有：${d.inbox}` };
      const files = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (/\.(txt|csv)$/i.test(e.name)) files.push(p);
        }
      };
      walk(d.inbox);
      if (!files.length) return { ok: false, message: '收件箱里没有 .txt/.csv 账号文件' };

      const stamp = `${localDateStr()}_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}`;
      const root = path.join(DATA_DIR, 'backups', 'account-files');
      const dir = path.join(root, stamp);
      fs.ensureDirSync(dir);
      let bytes = 0;
      for (const f of files) {
        // 子目录（done/）用下划线拼进文件名，避免 zip 里套目录
        const name = path.relative(d.inbox, f).replace(/[\\/]+/g, '_');
        fs.copyFileSync(f, path.join(dir, name));
        bytes += fs.statSync(f).size;
      }
      // 打 zip：用系统 Compress-Archive，不再引依赖
      let zip = '';
      try {
        const { execFileSync } = _require('child_process');
        const zipPath = `${dir}.zip`;
        execFileSync(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command',
            `Compress-Archive -Path '${dir}\\*' -DestinationPath '${zipPath}' -Force`],
          { windowsHide: true, timeout: 60000 },
        );
        if (fs.existsSync(zipPath)) zip = zipPath;
      } catch (_) {
        /* zip 失败也不要紧，目录里的副本照样能拷走 */
      }
      return { ok: true, dir, zip, count: files.length, bytes };
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    }
  });

  // 跑批量登录（流式回传日志）
  handle('accounts:run', async (event, opts = {}) => {
    if (loginChild) return { ok: false, message: '已有登录任务在进行中' };
    const script = loginScriptPath();
    if (!fs.existsSync(script)) return { ok: false, message: `找不到登录脚本：${script}` };
    const args = [script];
    // 扫码模式（opts.qr）：没有账号密码的号，靠手机 TikTok 扫二维码登录，不需要账号文件
    if (opts.qr) {
      args.push('--qr');
      if (opts.qrCount) args.push('--qr-count', String(opts.qrCount));
      if (opts.qrTimeout) args.push('--qr-timeout', String(opts.qrTimeout));
    } else if (opts.file) {
      args.push('--file', String(opts.file));
    } else {
      args.push('--auto');
    }
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
        // ⚠️ 这里**不能**过滤空串：列是按位置读的，`tk.ins｜密码｜｜｜｜gb` 里的空列一旦被丢掉，
        // 后面的 gb 就会跑到「邮箱」那一格（2026-10-24 用户要「密码+地区一起填」时发现）。
        const parts = t.split(/[｜|,\t]/).map((s) => s.trim());
        if (parts.length < 2) continue;
        const [username, password, email, emailPassword, totpSecret, region] = parts;
        if (!username || !password) continue;
        rows.push({ username, password, email: email || '', emailPassword: emailPassword || '', totpSecret: totpSecret || '', region: region || '' });
      }
      if (!rows.length) return { ok: false, message: '文件里没解析出账号（第一列用户名、第二列密码）' };

      const state = readAccountsState();
      // 账号 → 环境：已登记的用户名留在原环境，新用户名自动拿空号（TK11、TK12…）。
      // 规则只有一份，在 src/account-env.js（命令行批量登录走的是同一份）。
      const alloc = allocateAccountEnvs(rows, state);
      const mapping = [];
      alloc.forEach((a) => {
        if (a.duplicate) return; // 同一份文件里重复的号，只登记一次
        const row = rows[a.index - 1] || {};
        const target = a.env;
        state[target] = {
          ...(state[target] || {}),
          username: row.username,
          password: row.password,
          // 文件里没给邮箱时**保留原来的**：账号页要显示完整邮箱，
          // 只导入一行「用户名｜密码」补密码时不该把邮箱清空
          // （2026-10-24 扫码号补密码时发现：原来这里是直接 `row.email`，两列文件会把 email 抹掉）。
          email: row.email || (state[target] || {}).email || '',
          emailPassword: row.emailPassword || (state[target] || {}).emailPassword || '',
          // 2FA 密钥必须落盘（2026-10-19 审查发现：这里以前解析了却**没写**，
          // 于是账号文件一删、密钥就再也找不回来，掉登录后无法重登）
          totpSecret: row.totpSecret || (state[target] || {}).totpSecret || '',
          region: row.region || (state[target] || {}).region || '',
          at: new Date().toISOString(),
        };
        mapping.push({ env: target, username: row.username });
      });
      fs.mkdirSync(path.dirname(accountsStateFile()), { recursive: true });
      writeFileAtomicSync(accountsStateFile(), JSON.stringify(state, null, 2));
      // 凭据一变就重写当天加密包，别等启动/备份 cookie 那个时机
      try {
        autoBackupSecrets();
      } catch (_) {
        /* 备份失败不影响导入 */
      }
      return { ok: true, count: rows.length, mapping };
    } catch (e) {
      return { ok: false, message: String(e.message || e) };
    }
  });

  /**
   * 界面里直接改一个环境的凭据（不用再造 txt 文件）。
   * 语义：**按传入的值原样写**（空字符串 = 清空该字段）。
   * 只允许改已有环境，不允许这里新建环境 —— 建环境只发生在登录/导入流程里。
   */
  ipcMain.handle('accounts:saveCredentials', async (_e, payload = {}) => {
    try {
      const env = String(payload.env || '').toUpperCase();
      if (!/^TK\d+$/.test(env)) return { ok: false, message: `环境名不对：${payload.env || '（空）'}` };
      const state = readAccountsState();
      const prev = state[env] || {};
      const next = {
        ...prev,
        username: String(payload.username || '').trim() || prev.username || '',
        password: String(payload.password ?? ''),
        email: String(payload.email ?? '').trim(),
        emailPassword: String(payload.emailPassword ?? ''),
        totpSecret: String(payload.totpSecret ?? '').trim(),
        region: String(payload.region ?? '').trim().toLowerCase(),
        at: new Date().toISOString(),
      };
      state[env] = next;
      fs.mkdirSync(path.dirname(accountsStateFile()), { recursive: true });
      writeFileAtomicSync(accountsStateFile(), JSON.stringify(state, null, 2));
      // 凭据改了立刻重写加密备份（这就是「一键更新备份」：不用再点一次备份按钮）
      let backup = null;
      try {
        backup = autoBackupSecrets();
      } catch (_) {
        backup = { ok: false, reason: 'exception' };
      }
      return { ok: true, env, backup };
    } catch (e) {
      return { ok: false, message: String(e.message || e) };
    }
  });

  /** 手动「一键备份凭据」：把凭据/资料/闹钟等写进当天的加密包（safeStorage 加密，不落明文） */
  ipcMain.handle('accounts:backupSecrets', async () => {
    const r = autoBackupSecrets();
    return {
      ...(r || { ok: false }),
      dir: secretsDayDir(),
      file: secretsBundlePath(),
      keepDays: SECRET_KEEP_DAYS,
    };
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
  handle('accounts:syncProfiles', async (_event, opts = {}) => {
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
  handle('accounts:editProfiles', async (_event, opts = {}) => {
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

  /* ==========================================================================
   * 浏览器环境（FoxProfile 托管面） 2026-10-28
   *
   * 用户口径：「两个软件结合使用，用起来也比较麻烦，能整合成一个软件吗」
   * → FoxProfile 退成后台服务（scripts/foxprofile-guard.ps1 默认 headless，
   *   没有 Flet 窗口可关，也就不会出现「关掉窗口把 11 个环境一起弄死」）；
   *   环境的新建/删除/启动/停止/测出口全部搬到这里。
   *
   * 实现原则：**只用 FoxProfile 现成的 HTTP 接口**，不复制它的指纹逻辑：
   *   GET    /profiles                   列表
   *   POST   /profiles                   新建（proxy / os_type / timezone / locale / engine）
   *   GET    /profiles/{name}/ip-check   测出口 IP（顺带证明这条代理通不通）
   *   DELETE /profiles/{name}            删除（cookie 一起没，必须输入环境名确认）
   *   POST   /browser/{name}/launch      启动（wait=true 等到真能用）
   *   POST   /browser/{name}/stop        停止
   * ========================================================================*/
  // foxBase 已在模块级定义（守护脚本/无头自检也要用），这里不再重复定义

  /** 统一发请求：不让 axios 抛 4xx/5xx，调用方自己看 status（要能说出"FoxProfile 拒绝的原因"） */
  const foxReq = async ({ method = 'GET', url, body, timeout = 25000 }) => {
    const axios = (await import('axios')).default;
    return axios({
      method,
      url: `${foxBase()}${url}`,
      data: body,
      timeout,
      validateStatus: () => true,
    });
  };

  let sqliteModCache;
  const loadSqlite = async () => {
    if (sqliteModCache !== undefined) return sqliteModCache;
    try {
      sqliteModCache = await import('node:sqlite');
    } catch (_) {
      sqliteModCache = null; // 老 Node 没有这个模块 → 登录态显示「未知」
    }
    return sqliteModCache;
  };

  /** 读一个环境的 cookie 库判断登录态（毫秒级；不要用 /profiles/{env}/cookies，那个 4 秒） */
  const readEnvCookieState = async (prof, env) => {
    const dir = prof?.data_dir || path.join(FOX_DATA_DIR(), env);
    const dbFile = path.join(dir, 'cookies.sqlite');
    const out = { cookies: 0, loggedIn: null, lastActive: '', note: '' };
    if (!fs.existsSync(dbFile)) {
      out.note = '没有 cookie 库';
      return out;
    }
    try {
      out.lastActive = fs.statSync(dbFile).mtime.toISOString();
    } catch (_) {
      /* 忽略 */
    }
    const mod = await loadSqlite();
    if (!mod) {
      out.note = '登录态读不了';
      return out;
    }
    try {
      const db = new mod.DatabaseSync(dbFile, { readOnly: true });
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
    } catch (_) {
      out.note = 'cookie 库被占用';
    }
    return out;
  };

  /** 内核没在跑时也要能说清"哪些端口其实是通的"（可能是别的进程占着/上次没退干净） */
  const listeningEnginePorts = async () => {
    const out = [];
    await Promise.all(
      proxyEngine.ENGINE_PORTS.map(async (p) => {
        if (await proxyEngine.portListening(p)) out.push(p);
      }),
    );
    return out;
  };

  /** 环境列表 + 后台服务是否活着（界面红条就是靠 serviceOk） */
  handle('envs:list', async () => {
    const state = readAccountsState();
    let profiles = [];
    let running = [];
    let serviceOk = true;
    let serviceNote = '';
    try {
      const [p, b] = await Promise.all([
        foxReq({ url: '/profiles', timeout: 10000 }),
        foxReq({ url: '/browser', timeout: 8000 }),
      ]);
      profiles = Array.isArray(p.data?.profiles) ? p.data.profiles : [];
      running = Array.isArray(b.data?.running) ? b.data.running : [];
      if (p.status >= 400) {
        serviceOk = false;
        serviceNote = `后台服务返回 HTTP ${p.status}`;
      }
    } catch (e) {
      serviceOk = false;
      serviceNote =
        e?.code === 'ECONNREFUSED'
          ? '后台服务没在跑（127.0.0.1:8000 不通）'
          : e?.message || String(e);
    }

    // 端口活不活，现在由内置内核说了算（1080–1109 一条环境一条），
    // 不再读 proxy_relay 的配置文件 —— 那个链路要软路由+SSH，小白配不出来。
    const engineRunning = proxyEngine.isRunning();
    const enginePorts = engineRunning
      ? new Set(proxyEngine.ENGINE_PORTS)
      : new Set(await listeningEnginePorts());
    const engineNode = proxyEngine.readNode(DATA_DIR);

    const envs = await Promise.all(
      profiles.map(async (prof) => {
        const env = String(prof.name || '');
        const port = localRelayPort(prof.proxy);
        const st = state[env] || {};
        const cookie = await readEnvCookieState(prof, env);
        return {
          env,
          username: st.username || '',
          proxy: prof.proxy || '',
          port,
          portOk: port ? enginePorts.has(port) : false,
          timezone: prof.timezone || '',
          locale: prof.locale || '',
          engine: prof.engine || '',
          osType: prof.os_type || '',
          dataDir: prof.data_dir || '',
          running: running.includes(env),
          loggedIn: cookie.loggedIn,
          cookies: cookie.cookies,
          note: cookie.note,
          lastActive: cookie.lastActive,
          passwordSet: !!st.password,
          totpSet: !!st.totpSecret,
        };
      }),
    );
    envs.sort((a, b) => a.env.localeCompare(b.env, 'en', { numeric: true }));

    return {
      ok: true,
      serviceOk,
      serviceNote,
      base: foxBase(),
      proxy: {
        configured: !!engineNode,
        running: engineRunning,
        describe: engineNode ? describeNode(engineNode.node) : '未配置',
        exitIp: '',
        ports: proxyEngine.ENGINE_PORTS.length,
        logFile: proxyEngine.logFile(DATA_DIR),
      },
      envs,
      runningCount: envs.filter((e) => e.running).length,
      loggedCount: envs.filter((e) => e.loggedIn).length,
    };
  });

  /** 新建环境：分配一条独立中继端口 + 统一窗口尺寸（必须在**第一次启动之前**写指纹） */
  handle('envs:create', async (_e, payload = {}) => {
    const name = String(payload.name || '').trim();
    if (!/^[A-Za-z0-9_-]{2,24}$/.test(name)) {
      return { ok: false, message: '环境名只能是字母/数字/下划线，2–24 位（例：TK12）' };
    }
    const timezone = String(payload.timezone || '').trim();
    const locale = String(payload.locale || '').trim();

    let profiles = [];
    try {
      const p = await foxReq({ url: '/profiles', timeout: 10000 });
      profiles = Array.isArray(p.data?.profiles) ? p.data.profiles : [];
    } catch (e) {
      return {
        ok: false,
        message:
          e?.code === 'ECONNREFUSED'
            ? '后台服务没在跑，先点「启动后台服务」'
            : e?.message || String(e),
      };
    }
    if (profiles.some((p) => String(p.name || '').toLowerCase() === name.toLowerCase())) {
      return { ok: false, message: `环境 ${name} 已经存在` };
    }

    // 端口：一条环境一条，新号从 1090 起顺序递增（绝不能和别的号共用）
    const port = Number(payload.port) || nextRelayPort(profiles);
    if (!(port >= 1080 && port <= 1109)) {
      return {
        ok: false,
        message: `端口 ${port} 超出内置内核范围（1080–1109）。最多 30 条，先删掉不用的环境。`,
      };
    }
    // 端口是内核一启动就全开好的（1080–1109 一次开满），这里只需要确保内核在跑
    const eng = await startProxyEngine();
    if (!eng.ok) {
      return { ok: false, message: `代理内核没起来（${eng.message}）：先去「配置 → 网络节点」粘一条节点链接` };
    }

    const res = await foxReq({
      method: 'POST',
      url: '/profiles',
      body: {
        name,
        proxy: proxyUrl(port),
        os_type: 'windows',
        engine: 'camoufox',
        ...(timezone ? { timezone } : {}),
        ...(locale ? { locale } : {}),
      },
      timeout: 120000,
    });
    if (res.status >= 400 || res.data?.success === false) {
      return {
        ok: false,
        message: `FoxProfile 拒绝创建：${JSON.stringify(res.data || {}).slice(0, 200)}`,
      };
    }

    let screen = null;
    try {
      screen = applyUniformScreen(name);
    } catch (e) {
      screen = { ok: false, note: e?.message || String(e) };
    }
    addLog(
      'success',
      `🧩 新建浏览器环境 ${name}（代理端口 ${port}${screen?.ok ? '，窗口 1292x994' : ''}）`,
    );
    return { ok: true, env: name, port, screen };
  });

  /** 启动/停止：直接把 FoxProfile 的原话回给界面，失败不留"点了没反应" */
  handle('envs:start', async (_e, env) => {
    const name = String(env || '').trim();
    if (!name) return { ok: false, message: '没指定要启动哪个环境' };
    try {
      // 先确保浏览器是"有窗口"的形态 —— 无头模式用户什么都看不见（2026-10-28 事故）
      await ensureFoxProfileHeaded().catch(() => false);
      const res = await foxReq({
        method: 'POST',
        url: `/browser/${encodeURIComponent(name)}/launch?wait=true&focus=true`,
        timeout: 200000,
      });
      if (res.status >= 400 || res.data?.success === false) {
        return {
          ok: false,
          message: String(res.data?.message || res.data?.detail || `HTTP ${res.status}`),
        };
      }
      // 接口说成功不等于真起来了：回读一次 running（以前会出现"提示已启动、但桌面上什么都没有"）
      const chk = await foxReq({ url: '/browser', timeout: 15000 });
      const running = Array.isArray(chk.data?.running) ? chk.data.running : [];
      if (!running.includes(name)) {
        return {
          ok: false,
          message: `接口回了成功，但 ${name} 不在运行列表里（浏览器可能刚崩溃）——再点一次「启动」试试`,
        };
      }
      addLog('info', `🌐 打开浏览器环境 ${name}`);
      return { ok: true, env: name };
    } catch (e) {
      return {
        ok: false,
        message:
          e?.code === 'ECONNREFUSED'
            ? '后台服务没在跑，先点「启动后台服务」'
            : e?.message || String(e),
      };
    }
  });

  handle('envs:stop', async (_e, env) => {
    const name = String(env || '').trim();
    if (!name) return { ok: false, message: '没指定要停止哪个环境' };
    try {
      const res = await foxReq({
        method: 'POST',
        url: `/browser/${encodeURIComponent(name)}/stop`,
        timeout: 90000,
      });
      if (res.status >= 400 || res.data?.success === false) {
        return {
          ok: false,
          message: String(res.data?.message || res.data?.detail || `HTTP ${res.status}`),
        };
      }
      addLog('info', `🧹 关闭浏览器环境 ${name}`);
      return { ok: true, env: name };
    } catch (e) {
      return { ok: false, message: e?.message || String(e) };
    }
  });

  /** 测出口 IP：顺带证明这条端口的代理链路通不通（502 那类事故一眼能看出来） */
  handle('envs:ipCheck', async (_e, env) => {
    const name = String(env || '').trim();
    if (!name) return { ok: false, message: '没指定环境' };
    try {
      const res = await foxReq({
        url: `/profiles/${encodeURIComponent(name)}/ip-check`,
        timeout: 90000,
      });
      if (res.status >= 400) {
        return {
          ok: false,
          message: String(res.data?.detail || res.data?.message || `HTTP ${res.status}`),
        };
      }
      const d = res.data || {};
      // 真实返回形如：
      //   { exit_ip, country, sources:[{ip,country,city}...], warnings:[{code,message}] }
      // 城市只在 sources 里，出口 IP 在 exit_ip，两个都要拼出来，不然界面只显示一个「US」。
      const src = Array.isArray(d.sources) ? d.sources : [];
      const pick = (k) => {
        for (const s of src) if (s && s[k]) return s[k];
        return '';
      };
      const ip = String(d.exit_ip || pick('ip') || '');
      const place = [d.country || pick('country'), pick('city')].filter(Boolean).join(' / ');
      const warnings = (Array.isArray(d.warnings) ? d.warnings : [])
        .map((w) => (w && w.message) || '')
        .filter(Boolean);
      return { ok: true, env: name, ip, place, warnings };
    } catch (e) {
      return { ok: false, message: e?.message || String(e) };
    }
  });

  /** 删除环境：不可恢复（cookie 一起没），所以要求把环境名原样打一遍 */
  handle('envs:delete', async (_e, payload = {}) => {
    const name = String(payload.env || '').trim();
    const confirm = String(payload.confirm || '').trim();
    if (!name) return { ok: false, message: '没指定要删哪个环境' };
    if (confirm !== name) return { ok: false, message: '确认名不一致，没有删除' };
    try {
      const b = await foxReq({ url: '/browser', timeout: 8000 }).catch(() => ({ data: {} }));
      const running = Array.isArray(b.data?.running) ? b.data.running : [];
      if (running.includes(name)) {
        return { ok: false, message: `环境 ${name} 正在运行，先「停止」再删` };
      }
      const res = await foxReq({
        method: 'DELETE',
        url: `/profiles/${encodeURIComponent(name)}`,
        timeout: 60000,
      });
      if (res.status >= 400) {
        return {
          ok: false,
          message: String(res.data?.detail || res.data?.message || `HTTP ${res.status}`),
        };
      }
      addLog('warning', `🗑️ 已删除浏览器环境 ${name}（cookie 一起删掉了）`);
      return { ok: true, env: name };
    } catch (e) {
      return { ok: false, message: e?.message || String(e) };
    }
  });

  /** 后台服务（FoxProfile）没起来时的一键修复：跑 headless 守护脚本，然后等 API */
  handle('envs:ensureService', async () => {
    const script = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'foxprofile-guard.ps1')
      : path.join(ROOT, 'scripts', 'foxprofile-guard.ps1');
    if (!fs.existsSync(script)) return { ok: false, message: `找不到守护脚本：${script}` };
    try {
      spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, stdio: 'ignore', detached: false },
      );
    } catch (e) {
      return { ok: false, message: `启动守护脚本失败：${e?.message || e}` };
    }
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const h = await foxReq({ url: '/health', timeout: 4000 });
        if (h.status < 400) {
          addLog('success', '🧩 浏览器后台服务已就绪');
          return { ok: true };
        }
      } catch (_) {
        /* 还没起来，继续等 */
      }
    }
    return { ok: false, message: '60 秒内后台服务没起来，去「日志」页看看' };
  });

  /* ==========================================================================
   * 内置代理内核（xray） 2026-10-28
   *
   * 用户口径：「软件要给到其它用户使用，用户都是小白……用户只有一个 vless:// 节点」
   * → 安装包自带 xray.exe，用户只做一件事：把节点粘进「配置 → 网络节点」。
   *   内核在本机开 30 条 socks（1080–1109），一条环境一条，全自动。
   *   旧的 SSH + 软路由 + proxy_relay.py 链路对小白不现实（要维护四样东西）。
   * ========================================================================*/
  // xrayBin / startProxyEngine 定义在模块级（setupIPC 外面）—— app.whenReady 里要直接调它们。
  // 踩过的坑：定义在 setupIPC 内部时，whenReady 里那句 startProxyEngine() 抛 ReferenceError，
  // 被 Promise 链吞掉 → 内核根本没起来，界面和日志一个字都不报（v1.8.0 实测）。

  handle('proxy:status', async () => {
    const s = await proxyEngine.status({ dataDir: DATA_DIR, bin: xrayBin() });
    return { ok: true, ...s };
  });

  /** 粘一条链接就用：解析 → 保存 → 重起内核 → 实测出口 IP */
  handle('proxy:importNode', async (_e, payload = {}) => {
    const url = String(payload.url || '').trim();
    if (!url) return { ok: false, message: '先把节点链接粘进来' };
    const r = await proxyEngine.importNode({
      dataDir: DATA_DIR,
      bin: xrayBin(),
      url,
      ports: proxyEngine.ENGINE_PORTS,
    });
    if (!r.ok) {
      addLog('error', `🔌 节点导入失败：${r.message}`);
      return { ok: false, message: r.message };
    }
    addLog(
      r.exitIp ? 'success' : 'warning',
      r.exitIp
        ? `🔌 节点已生效：${r.describe} → 出口 ${r.exitIp}`
        : `🔌 节点已保存，但没测到出口 IP：${r.probeError || '未知原因'}`,
    );
    return r;
  });

  /** 只测出口（不换节点）：证明"现在的配置到底能不能出网" */
  handle('proxy:test', async () => {
    const saved = proxyEngine.readNode(DATA_DIR);
    if (!saved) return { ok: false, message: '还没配置节点' };
    if (!proxyEngine.isRunning()) {
      const r = await startProxyEngine();
      if (!r.ok) return { ok: false, message: r.message };
    }
    const probe = await proxyEngine.probeExitIp(proxyEngine.ENGINE_PORTS[0]);
    return probe.ok
      ? { ok: true, ip: probe.ip }
      : { ok: false, message: `${probe.error}（点「重启内核」再试一次）` };
  });

  handle('proxy:restart', async () => {
    const saved = proxyEngine.readNode(DATA_DIR);
    if (!saved) return { ok: false, message: '还没配置节点' };
    const r = await proxyEngine.restartEngine({
      dataDir: DATA_DIR,
      bin: xrayBin(),
      ports: proxyEngine.ENGINE_PORTS,
      outbound: saved.outbound,
    });
    if (!r.ok) return { ok: false, message: r.message };
    const probe = await proxyEngine.probeExitIp(proxyEngine.ENGINE_PORTS[0]);
    return { ok: true, ip: probe.ok ? probe.ip : '', probeError: probe.ok ? '' : probe.error };
  });

  handle('proxy:clear', async () => {
    await proxyEngine.stopEngine();
    proxyEngine.clearNode(DATA_DIR);
    addLog('warning', '🔌 已清除代理节点配置（内核已停止）');
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


  handle('accounts:launch', async (_e, env, action = 'launch') => {
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
    // 手动勾选的条数：>0 表示"只发这几条"（逐条显式指定，优先于 maxCount）
    const pickCount = Array.isArray(opts?.pick) ? opts.pick.length : 0;
    // 🔴 重入保护 + 3 秒去抖（用户双击/连点）：重复触发会重复扫描 300+ 会话，
    //    最坏情况两条并发上传同一个会话 → 重复作品。判断放在最前面，日志都不写。
    if (publishInFlight) {
      addLog('warning', '⚠️ 已经在发布中，本次点击已忽略');
      return { ok: false, message: '发布已在进行中' };
    }
    if (Date.now() - publishLastAt < 3000) {
      return { ok: false, message: '刚刚点过一次（3 秒内不重复执行）' };
    }
    // 跨进程互斥（2026-10-29 审查发现）：调度器是独立进程，它的锁文件在这里也要看。
    // 两边同时开同一个 FoxProfile 环境时，openFoxPage 会把对方的浏览器直接关掉。
    {
      const lockFile = runLock.lockFile(DATA_DIR);
      const held = runLock.readLock(lockFile);
      const verdict = runLock.canTakeOver(held, { selfPid: process.pid });
      if (!verdict.take && held && held.kind !== 'publish') {
        const who = runLock.describeHolder(held);
        addLog('warning', `⚠️ ${who} 正在运行，先等它结束再发布（避免抢同一个指纹环境）`);
        return { ok: false, message: `${who} 正在运行，请等它结束后再点发布` };
      }
      const got = runLock.tryAcquire(lockFile, { kind: 'publish' });
      if (!got.ok) {
        return { ok: false, message: `${runLock.describeHolder(got.holder)} 正在运行，请稍后再试` };
      }
    }
    publishInFlight = true;
    publishLastAt = Date.now();
    try {
      addLog('info', `📤 手动发布开始（预算 ${Math.round(budgetMs / 60000)} 分钟${pickCount ? `，勾选 ${pickCount} 条` : ''}）...`);
      const config = loadConfig();
      // 目标账号：2026-10-19 用户实测事故 —— 让助手"发 TK02"，结果发到了 TK01。
      // 根因是这条链路**只认 accounts[0]**（连 opts 都不看）。判定逻辑抽到
      // electron/lib/publish-target.js（纯函数 + 9 条单测）：点名就必须命中，命中不了就失败。
      const target = resolvePublishTarget(config.accounts, { account: opts?.account, env: opts?.env });
      if (!target.ok) {
        addLog('error', `❌ ${target.error}，已中止（不会退回发到账号 01）`);
        return { ok: false, message: target.error };
      }
      const envId = target.envId;
      const targetName = target.name;
      const apiKey = config.bitApiKey || '';
      addLog('info', `🎯 发布目标：${describePublishTarget(target)}${target.explicit ? '' : ' —— 没指定账号，按配置里第一个发'}`);

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

      // 手动勾选：界面上一条条点出来的（`date/session` 或 `session` 都认）。
      // 这是**逐条显式指定**，所以它优先于 includeOld / maxCount ——
      // 用户点的是哪条就发哪条，不再"按顺序抓前 3 条"（2026-10-19 用户提问
      // 「不能选择性发布吗，非要发 3 条或者随机？」）。
      const pickedRaw = Array.isArray(opts?.pick) ? opts.pick : [];
      const pickKeys = pickedRaw
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .map((x) => (x.includes('/') ? x : `/${x}`));   // 只给 session 时按后缀匹配
      let picked = null;
      if (pickKeys.length) {
        const all = scanUnpublished({ outputDir: outDir, today: localDateStr(), onlyToday: false, maxCount: 0 }).pending;
        picked = all
          .filter((p) => pickKeys.some((k) => (k.startsWith('/') ? `/${p.session}` === k : `${p.date}/${p.session}` === k)))
          .sort((a, b) => (a.date === b.date ? (a.time < b.time ? -1 : 1) : (a.date < b.date ? -1 : 1)));
        const missing = pickKeys.length - picked.length;
        if (picked.length === 0) {
          addLog('error', '❌ 勾选的条目已经不在待发列表里（可能刚被发过），本轮不动');
          return { ok: false, message: '勾选的条目不在待发列表里' };
        }
        addLog('info', `🎯 手动勾选 ${picked.length} 条${missing > 0 ? `（另有 ${missing} 条已不可发，已忽略）` : ''}：`
          + picked.map((p) => `${p.session}《${p.title || '无标题'}》`).join('、'));
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

      if (picked) {
        addLog('info', `📋 待发布 ${unpublished.length} 条，本轮只发勾选的 ${picked.length} 条`);
      } else {
        if (unpublished.length === 0) {
          addLog('info', '📭 没有未发布的内容');
          return { ok: true, published: 0 };
        }
        addLog('info', `📋 待发布 ${unpublished.length} 条`);
      }

      // 顺序是**确定的**：日期倒序 → 同一天 pm 先于 am → 同前缀时间倒序（src/output-scan.js），不随机。
      // 原先这里写死 unpublished[0]，所以「发布全部」其实只发 1 条。
      const todo = picked
        ? picked
        : (maxCount === Infinity || opts?.all === true ? unpublished : unpublished.slice(0, maxCount));
      addLog('info', `📤 本轮实际发 ${todo.length} 条：${todo.map((t) => t.session).join('、')}`);

      let published = 0;
      const failures = [];
      const doneSessions = [];
      for (const item of todo) {
        const remaining = budgetMs - (Date.now() - started);
        if (remaining <= 60_000) {
          addLog('warning', `⏰ 发布预算不足（剩余 ${Math.round(remaining / 1000)}s），本轮提前结束；剩余条目下轮继续（未写 .published 会自动重试）`);
          break;
        }
        addLog('info', `📤 发布: ${item.date}/${item.session}`);
        try {
          const r = await publishOne(item, { envId, apiKey, budgetMs: remaining });
          if (r.ok) { published += 1; doneSessions.push(item); }
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
        // 发布完自动回报（用户在界面点了发布就该看到结论，不用守着问）
        pushAssistantNote(`⚠️ 发布完成（手动，${fmtSpent(started)}）：成功 ${published} 条、失败 ${failures.length} 条，目标 ${envId}。\n失败：${failures.slice(0, 3).join('；')}`);
        return { ok: published > 0, published, failures, message: `${failures.length} 条失败` };
      }
      if (published > 0) {
        const titles = doneSessions.slice(0, 3).map((t) => `《${t.title || t.session}》`).join('、');
        pushAssistantNote(`✅ 发布完成（手动，${fmtSpent(started)}）：${published} 条 → ${envId}${titles ? `，${titles}` : ''}。`);
      }
      return { ok: true, published };
    } catch (err) {
      addLog('error', `❌ 发布失败: ${err.message}`);
      notifyFailure({ title: 'XNOWPost 手动发布失败', body: err.message, key: `publish-run|${err.message}` });
      pushAssistantNote(`❌ 发布失败（手动，${fmtSpent(started)}）：${err.message}`);
      return { ok: false, message: err.message };
    } finally {
      publishInFlight = false;
      try { runLock.release(runLock.lockFile(DATA_DIR)); } catch (_) { /* ignore */ }
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
      // 跨进程互斥：调度器同一时刻只能开一个环境，手动采集也要抢同一把锁
      {
        const lockFile = runLock.lockFile(DATA_DIR);
        const verdict = runLock.canTakeOver(runLock.readLock(lockFile), { selfPid: process.pid });
        if (!verdict.take && verdict.holder) {
          const who = runLock.describeHolder(verdict.holder);
          addLog('warning', `⚠️ ${who} 正在运行，先等它结束再采集（避免抢同一个指纹环境）`);
          return { ok: false, message: `${who} 正在运行，请等它结束后再采集` };
        }
        const got = runLock.tryAcquire(lockFile, { kind: 'collect' });
        if (!got.ok) return { ok: false, message: `${runLock.describeHolder(got.holder)} 正在运行，请稍后再试` };
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
          try { runLock.release(runLock.lockFile(DATA_DIR)); } catch (_) { /* ignore */ }
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
    try { runLock.release(runLock.lockFile(DATA_DIR)); } catch (_) { /* ignore */ }
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

  handle('report:trend', async (_event, days) => {
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
  handle('report:push', async (_event, targetDate) => {
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
} else {
  // 第二次启动（用户双击桌面图标想找回窗口）→ 把已经藏到托盘的窗口显示出来。
  // 没有这个处理器时，第二个进程直接退出，用户会觉得"点了图标没反应"。
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    if (tray) tray.displayBalloon?.({ title: 'XNOWPost', content: '窗口已恢复（程序一直在后台运行，定时任务没停）' });
  });
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

/**
 * 素材库自动补（v1.6.52）。
 *
 * 用户口径：「素材库你会自动更新自动补吗，这样我以后就不用手动补了」。
 * 每个应用启动后 **90 秒**（避开启动高峰）检查一次：今天没补过就跑一次后台补库，
 * 最多补 6 段（1~2 分钟，只下 Pexels 免费素材，不花 API 费）。
 *
 * 为什么 spawn 脚本而不是直接 import：补库要下几十 MB、算 4 道闸，必须脱离主进程跑，
 * 否则界面会卡；用 CLI 也保证「手动跑」和「自动跑」是同一份实现。
 * 失败只写日志，绝不打扰用户、绝不影响出片。
 */
function scheduleBrollGrow() {
  const timer = setTimeout(async () => {
    try {
      const { grownToday, markGrownToday } = await import('../src/broll-store.js');
      if (grownToday()) return;
      let key = '';
      try {
        key = fs.readJsonSync(path.join(DATA_DIR, 'config', 'user.json')).pexelsApiKey || '';
      } catch (_) { return; }
      if (!key) return; // 没配 Pexels Key 就别白跑
      const base = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : ROOT;
      const script = path.join(base, 'scripts', 'grow-broll-library.mjs');
      if (!fs.existsSync(script)) {
        writeLogToFile({ time: new Date().toLocaleString('sv-SE'), type: 'warn', message: '素材库自动补跳过：找不到 grow-broll-library.mjs' });
        return;
      }
      writeLogToFile({ time: new Date().toLocaleString('sv-SE'), type: 'info', message: '📚 素材库自动补开始（每天一次，最多 6 段）' });
      const child = spawn(NODE_EXE, [script, '--max', '6', '--per-tag', '3'], {
        cwd: base,
        windowsHide: true,
        env: { ...process.env, XNOWPOST_DATA_DIR: DATA_DIR, PEXELS_API_KEY: key },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { out += d.toString(); });
      child.on('close', (code) => {
        markGrownToday({ code, at: new Date().toISOString() });
        const okLine = out.split('\n').reverse().find((l) => l.includes('入库')) || '';
        writeLogToFile({
          time: new Date().toLocaleString('sv-SE'),
          type: code === 0 ? 'info' : 'warn',
          message: `📚 素材库自动补结束（退出码 ${code}）${okLine ? '：' + okLine.trim() : ''}`,
        });
      });
    } catch (e) {
      writeLogToFile({ time: new Date().toLocaleString('sv-SE'), type: 'warn', message: `素材库自动补失败（不影响出片）: ${e.message}` });
    }
  }, 90 * 1000);
  if (timer.unref) timer.unref();
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

  // ⚠️ 必须把数据目录同步进 process.env：
  // src/paths.js 的 resolveDataDir() 只认 XNOWPOST_DATA_DIR，而主进程以前只给**子进程**传，
  // 自己在主进程里 import 的模块（broll-store 等）就会退回 path.resolve('.') = 启动时的工作目录。
  // 2026-10-20 实测踩到：从仓库目录启动安装版，「今天已补过素材库」的戳写进了仓库 data\。
  process.env.XNOWPOST_DATA_DIR = DATA_DIR;

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
  await createTray();
  startFoxProfileGuard();
  initUpdater(mainWindow);
  autoBackup();
  autoBackupSecrets();
  healthCheck();
  startScheduler();
  scheduleBrollGrow();
  // 内置代理内核（xray）：配过节点就静默起来，没配就等用户在「配置 → 网络节点」里粘链接。
  // 这不是可选优化：环境内所有浏览器都走 127.0.0.1:1080…1109，内核不在 = 全都不通。
  // 失败要留痕（曾因静默 ReferenceError 导致"内核悄悄没起来"，排查了半天）
  startProxyEngine().catch((e) =>
    addLog('error', `🔌 代理内核自动启动异常：${e?.message || e}`),
  );

  // FoxProfile 万一还是"浏览器无窗口"模式（老服务/别人手动起的），静默纠正一次。
  // 用户点「启动」看不到窗口 = 以为功能没做完（2026-10-28 原话），这是必须自愈的问题。
  setTimeout(() => {
    ensureFoxProfileHeaded().catch(() => false);
  }, 6000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((e) => {
  // 🔴 2026-10-29 审查发现：这条启动链原来是裸的 `.then()` —— 中间任何一步抛错都会被
  //    当成未处理 rejection（只写进 crash.log），而 startScheduler() 在链条靠后的位置，
  //    于是会出现「界面一切正常、闹钟永远不会触发」这种最难查的形态。
  const msg = (e && e.message) || String(e);
  try { addLog('error', `❌ 应用启动流程失败：${msg}`); } catch (_) { /* 日志都没起来就只剩控制台 */ }
  try { console.error('启动流程失败:', e); } catch (_) { /* ignore */ }
  try { notifyFailure({ title: 'XNOWPost 启动异常', body: msg, key: `boot|${msg}` }); } catch (_) { /* ignore */ }
  // 定时器是这个软件的命脉：即使前面某步失败，也再试一次把调度器拉起来
  try {
    startScheduler();
    addLog('warning', '⚠️ 启动流程出错，已单独尝试拉起定时调度器（请检查上面的报错）');
  } catch (e2) {
    try { addLog('error', `❌ 定时调度器也没能启动：${(e2 && e2.message) || e2}`); } catch (_) { /* ignore */ }
  }
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





