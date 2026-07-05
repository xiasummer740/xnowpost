import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { initUpdater, downloadUpdate, quitAndInstall, checkForUpdates } from './updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
// 用 createRequire 加载 electron（ESM 的 import 在 Electron 中不可靠）
const electron = _require('electron');
const { app, BrowserWindow, ipcMain, shell, screen } = electron;
const ROOT = path.resolve(__dirname, '..');

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

// 全局未捕获异常处理（写入日志文件，防止静默崩溃）
process.on('uncaughtException', (err) => {
  const logDir = path.join(ROOT, 'logs');
  try {
    fs.ensureDirSync(logDir);
    fs.appendFileSync(path.join(logDir, 'crash.log'),
      `[${new Date().toISOString()}] UNCAUGHT: ${err.stack || err.message}\n`);
  } catch (_) {}
  console.error('未捕获异常:', err);
});
process.on('unhandledRejection', (reason) => {
  const logDir = path.join(ROOT, 'logs');
  try {
    fs.ensureDirSync(logDir);
    fs.appendFileSync(path.join(logDir, 'crash.log'),
      `[${new Date().toISOString()}] UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack : reason}\n`);
  } catch (_) {}
  console.error('未处理的 Promise 拒绝:', reason);
});
// 数据目录：安装版 → %APPDATA%/xnowpost，开发版 → 项目根目录
let DATA_DIR = ROOT;

// 配置文件路径
const USER_CONFIG_PATH = () => path.join(DATA_DIR, 'config', 'user.json');

// 默认配置
const DEFAULT_CONFIG = {
  deepseekApiKey: '',
  siliconflowApiKey: '',
  pexelsApiKey: '',
  tgBotToken: '',
  tgChannelId: '@your_channel',
  cdpEndpoint: 'http://localhost:9222',
  bitApiKey: '',
};

// 窗口引用
let mainWindow = null;
let engineProcess = null;
let logBuffer = [];
let schedulerRunning = false;  // 调度器是否正在执行引擎任务
let schedulerLastRun = '';     // 最近一次调度执行时间

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

function writeLogToFile(entry) {
  try {
    const logDir = path.join(DATA_DIR, 'logs');
    const logFile = path.join(logDir, `app-${new Date().toISOString().split('T')[0]}.log`);
    fs.ensureDirSync(logDir);
    const line = `[${entry.time}] [${entry.type.toUpperCase()}] ${entry.message}\n`;
    fs.appendFileSync(logFile, line);
  } catch (e) { /* 日志文件写失败不影响主流程 */ }
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
  } else {
    // fallback: 开发模式连 Vite 服务器
    mainWindow.loadURL('http://localhost:5173');
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.center();
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

  // 窗口关闭时保存状态 + 杀死运行中的引擎子进程
  mainWindow.on('close', () => {
    saveWinState(mainWindow);
    if (engineProcess && !engineProcess.killed) {
      try {
        engineProcess.kill('SIGTERM');
        try { process.kill(-engineProcess.pid, 'SIGTERM'); } catch (e) {}
      } catch (e) {}
    }
  });

  // DevTools: 需要时按 F12 打开，不自动弹出
  // 如需自动打开，设环境变量 DEBUG=true
}

// === IPC 处理器 ===
function setupIPC() {
  // 诊断
  ipcMain.handle('ping', () => ({ ok: true, time: Date.now() }));

  // 获取配置
  ipcMain.handle('config:get', () => {
    return loadConfig();
  });

  // 保存配置
  ipcMain.handle('config:save', async (event, config) => {
    try {
      await saveConfig(config);
      addLog('success', '配置已保存');
      return { ok: true };
    } catch (e) {
      addLog('error', '保存配置失败: ' + e.message);
      return { ok: false, message: e.message };
    }
  });

  // 引擎执行队列
  const engineQueue = [];
  let engineRunning = false;

  function doRunEngine(mode, topic) {
    const args = mode === 'video' ? ['--video-only'] : mode === 'post' ? ['--post-only'] : [];
    if (topic) { args.push('--topic'); args.push(topic); }
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
        },
      });
      engineProcess = proc;
      // 手动超时：spawn 的 timeout 不可靠，用 setTimeout 兜底
      const ENGINE_TIMEOUT = 15 * 60 * 1000;
      let engineTimer = setTimeout(() => {
        if (!proc.killed) {
          addLog('error', `⏰ 引擎执行超时(${ENGINE_TIMEOUT/60000}分钟)，强制终止`);
          proc.kill('SIGTERM');
          try { process.kill(-proc.pid, 'SIGTERM'); } catch (_) {}
        }
      }, ENGINE_TIMEOUT);
      let output = '';

      let stdoutBuf = '';
      proc.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        output += chunk.toString();
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
        output += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (t) addLog('warning', t);
        }
      });

      proc.on('close', (code) => {
        clearTimeout(engineTimer);
        engineProcess = null;
        if (stdoutBuf.trim()) addLog('info', stdoutBuf.trim());
        if (code === 0) {
          addLog('success', '✅ 引擎执行完成');
          resolve({ ok: true, output });
        } else {
          addLog('error', `引擎异常退出 (code: ${code})`);
          resolve({ ok: false, message: `进程异常退出 (code: ${code})` });
        }
        processQueue();
      });

      proc.on('error', (err) => {
        clearTimeout(engineTimer);
        engineProcess = null;
        addLog('error', `引擎启动失败: ${err.message}`);
        resolve({ ok: false, message: err.message });
        processQueue();
      });
    });
  }

  function processQueue() {
    if (engineQueue.length === 0) { engineRunning = false; return; }
    engineRunning = true;
    const { mode, topic, resolve } = engineQueue.shift();
    const queueLeft = engineQueue.length;
    if (queueLeft > 0) addLog('info', `⏳ 队列还有 ${queueLeft} 个任务待执行`);
    doRunEngine(mode, topic).then(resolve);
  }

  // 执行引擎（支持排队 + 用户主题）
  ipcMain.handle('engine:run', async (_event, mode = 'auto', topic = '') => {
    if (engineRunning || engineProcess) {
      addLog('info', `⏳ 已加入队列（当前有任务运行中），完成后自动执行`);
      return new Promise((resolve) => {
        engineQueue.push({ mode, topic, resolve });
      });
    }
    engineRunning = true;
    return doRunEngine(mode, topic);
  });

  // 取消引擎
  ipcMain.handle('engine:cancel', () => {
    // 清空排队中的任务
    while (engineQueue.length > 0) {
      const item = engineQueue.shift();
      item.resolve({ ok: false, message: '已取消' });
    }
    if (engineProcess && !engineProcess.killed) {
      try {
        engineProcess.kill('SIGTERM');
        try { process.kill(-engineProcess.pid, 'SIGTERM'); } catch (e) { }
      } catch (e) {
        addLog('error', `取消进程失败: ${e.message}`);
        return { ok: false, message: e.message };
      }
      addLog('warning', '引擎已被用户取消');
      return { ok: true, message: '已取消' };
    }
    return { ok: false, message: '没有运行中的引擎' };
  });

  // 获取日志
  ipcMain.handle('logs:get', () => {
    return logBuffer.slice(-200);
  });

  // 清空日志
  ipcMain.handle('logs:clear', () => {
    logBuffer = [];
    return { ok: true };
  });

  // 历史产出（30 秒缓存，避免频繁全量扫描）
  let historyCache = null;
  let historyCacheTime = 0;
  const HISTORY_CACHE_TTL = 30_000;

  ipcMain.handle('history:list', () => {
    const now = Date.now();
    if (historyCache && (now - historyCacheTime) < HISTORY_CACHE_TTL) {
      return historyCache;
    }

    const outputDir = path.join(DATA_DIR, 'output');
    if (!fs.existsSync(outputDir)) { historyCache = []; historyCacheTime = now; return []; }

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
          } catch (e) {}
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
  ipcMain.handle('session:read', async (_event, sessionDir) => {
    try {
      if (!fs.existsSync(sessionDir)) return null;

      const files = fs.readdirSync(sessionDir);

      // 读文案
      let text = '';
      const txtFile = files.find(f => f === '文案.txt');
      if (txtFile) text = fs.readFileSync(path.join(sessionDir, txtFile), 'utf-8');

      // 读图片（转 base64，限制数量 9 张 + 单张 2MB 避免卡 UI）
      const images = files
        .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
        .slice(0, 9)
        .filter(f => fs.statSync(path.join(sessionDir, f)).size <= 2 * 1024 * 1024)
        .map(f => ({
          name: f,
          data: `data:image/png;base64,${fs.readFileSync(path.join(sessionDir, f)).toString('base64')}`,
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

  // 缩略图（轻量，只读第一张 PNG，用于卡片预览）
  ipcMain.handle('session:thumbnail', async (_event, sessionDir) => {
    try {
      if (!fs.existsSync(sessionDir)) return null;
      const files = fs.readdirSync(sessionDir);
      const imgFile = files.find(f => /\.(png|jpg|jpeg)$/i.test(f));
      if (!imgFile) return null;
      const buf = fs.readFileSync(path.join(sessionDir, imgFile));
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch (e) {
      return null;
    }
  });

  // 打开输出目录
  ipcMain.handle('shell:openOutput', () => {
    shell.openPath(path.join(DATA_DIR, 'output'));
    return { ok: true };
  });

  // 打开外部链接（浏览器跳转）
  ipcMain.handle('shell:openExternal', async (_event, url) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      await shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false, message: 'invalid url' };
  });

  // 获取引擎状态
  ipcMain.handle('engine:status', () => {
    const config = loadConfig();
    return {
      configured: !!(config.deepseekApiKey || config.siliconflowApiKey),
      running: !!engineProcess,
      todayDir: getTodayDir(),
      schedulerRunning: !!schedulerProcess,
      schedulerActive: schedulerRunning, // 调度器正在执行任务
      schedulerLastRun, // 最近一次调度执行时间
    };
  });

  // 定时任务管理
  const SCHEDULE_FILE = path.join(DATA_DIR, 'config', 'schedule.json');

  ipcMain.handle('schedule:list', () => {
    try {
      if (fs.existsSync(SCHEDULE_FILE)) return fs.readJsonSync(SCHEDULE_FILE);
    } catch (e) { /* fall through */ }
    return [];
  });

  ipcMain.handle('schedule:save', async (_event, jobs) => {
    try {
      fs.ensureDirSync(path.dirname(SCHEDULE_FILE));
      fs.writeJsonSync(SCHEDULE_FILE, jobs, { spaces: 2 });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // 测试 API 连接
  ipcMain.handle('config:test', async (_event, type, key) => {
    // 优先用传入的 key，fallback 到已保存配置
    const config = loadConfig();
    const apiKey = key || config[type === 'tg' ? 'tgBotToken' : type + 'ApiKey'] || '';

    if (type === 'deepseek') {
      if (!apiKey) return { ok: false, message: '请先填写 DeepSeek API Key' };
      try {
        const OpenAI = (await import('openai')).default;
        const client = new OpenAI({
          apiKey,
          baseURL: 'https://api.deepseek.com',
          timeout: 10000,
        });
        await client.chat.completions.create({
          model: 'deepseek-chat', max_tokens: 10,
          messages: [{ role: 'user', content: 'hi' }],
        });
        return { ok: true, message: 'DeepSeek 文案 API ✅ 连接成功' };
      } catch (err) {
        return { ok: false, message: 'DeepSeek ❌ ' + err.message };
      }
    }

    if (type === 'siliconflow') {
      if (!apiKey) return { ok: false, message: '请先填写硅基流动 API Key' };
      try {
        // 测试生图 API
        const axios = (await import('axios')).default;
        const resp = await axios.post(
          'https://api.siliconflow.cn/v1/images/generations',
          { model: 'Kwai-Kolors/Kolors', prompt: 'test', image_size: '512x512', batch_size: 1, guidance_scale: 7.5 },
          { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 }
        );
        if (resp.status === 200) {
          return { ok: true, message: '硅基流动 生图 API ✅ 连接成功（模型: Kolors）' };
        }
        return { ok: false, message: '硅基流动 ❌ HTTP ' + resp.status };
      } catch (err) {
        return { ok: false, message: '硅基流动 ❌ ' + (err.response?.data?.message || err.message) };
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
        const resp = await axios.get('https://api.pexels.com/v1/search?query=test&per_page=1', {
          headers: { Authorization: apiKey }, timeout: 10000,
        });
        if (resp.status === 200) {
          return { ok: true, message: `Pexels 素材搜索 ✅ 连接成功（${resp.data?.total_results?.toLocaleString()||0} 张可用）` };
        }
        return { ok: false, message: 'Pexels ❌ HTTP ' + resp.status };
      } catch (err) {
        return { ok: false, message: 'Pexels ❌ ' + (err.response?.data?.error || err.message) };
      }
    }

    return { ok: false, message: '未知测试类型: ' + type };
  });

  // 测试比特浏览器连接
  ipcMain.handle('config:testBit', async (_event, apiKey) => {
    try {
      const axios = (await import('axios')).default;
      const BASE = 'http://127.0.0.1:54345';

      const doPost = async (label, path, body) => {
        try {
          const resp = await axios.post(`${BASE}${path}`, body, { timeout: 8000 });
          addLog('info', `🔍 ${label}: ${JSON.stringify(resp.data).substring(0, 400)}`);
          return resp.data;
        } catch (e) {
          addLog('info', `🔍 ${label}: ❌ ${e.message}`);
          return null;
        }
      };

      // 尝试 GET /browser/list （有些版本支持 GET）
      try {
        const getResp = await axios.get(`${BASE}/browser/list?page=1&pageSize=100`, { timeout: 5000 });
        addLog('info', `🔍 GET /browser/list: ${JSON.stringify(getResp.data).substring(0, 300)}`);
      } catch (_) {}

      // 尝试 POST 多种参数组合
      const candidates = [
        { page: 1, pageSize: 100 },
        { page: 1, pageSize: 100, key: apiKey },
        { page: 1, pageSize: 100, apiKey: apiKey },
        { page: 1, pageSize: 100, token: apiKey },
      ];
      for (const body of candidates) {
        if (!body.key && !body.apiKey && !body.token && apiKey) continue;
        const data = await doPost(`list ${JSON.stringify(body)}`, '/browser/list', body);
        if (data?.success && data.data?.list?.length > 0) {
          const envs = data.data.list;
          addLog('info', `✅ 找到 ${envs.length} 个环境!`);
          for (const e of envs) {
            addLog('info', `  · ID: ${e.id} | 名称: ${e.name || ''}`);
          }
          return { ok: true, message: `比特浏览器 ✅ ${envs.map(e => `ID=${e.id}:${e.name}`).join(', ')}`, list: envs };
        }
      }

      // 用 UUID 格式尝试打开环境（比特用 UUID 作为 ID）
      addLog('info', '🔍 尝试用 UUID 格式探测环境...');
      // 从数据库获得的已知环境 browser_id
      const knownEnvIds = [
        apiKey,                              // fee00b... 也是环境 ID
        '24056554bc0e479784f054c161670a53',
        '8d777f55af4d497d8eb7e7f85d050ffd',
        'f791963fb580491089c7d1fc64442efe',
      ];
      for (const id of knownEnvIds) {
        if (!id) continue;
        // 环境 ID 和 API Key 相同时不传 key，防止 API 混淆
        const body = apiKey && apiKey !== id ? { id, key: apiKey } : { id };
        const data = await doPost(`open UUID=${id.substring(0, 12)}...`, '/browser/open', body);
        if (data?.success && data.data?.ws) {
          addLog('info', `✅ 找到环境! UUID=${id}`);
          return { ok: true, message: `比特浏览器 ✅ 环境 ID=${id}`, envId: id };
        }
      }

      // 最后尝试: 用 API key 作为账号标识查明细
      await doPost('账号详情?', '/account/info', { key: apiKey });

      addLog('info', '❌ 无法获取环境列表。请确认比特浏览器已登录且有环境');
      return { ok: false, message: '比特浏览器 ❌ 可连接但无法获取环境列表。在比特后台点环境右侧「配置」按钮，看 URL 里的 ID' };
    } catch (err) {
      return { ok: false, message: '比特浏览器 ❌ ' + (err.code === 'ECONNREFUSED' ? '请确认比特浏览器已启动' : err.message) };
    }
  });
}

  // 手动触发发布
  ipcMain.handle('publish:run', async () => {
    try {
      addLog('info', '📤 手动发布开始...');
      const config = loadConfig();
      const envId = config.accounts?.[0]?.bitEnvId;
      const apiKey = config.bitApiKey || '';

      if (!envId) {
        addLog('error', '❌ 未配置比特环境 ID，请在配置页设置账号');
        return { ok: false, message: '未配置比特环境 ID' };
      }

      // 直接扫描输出目录
      const outDir = path.join(DATA_DIR, 'output');
      const dateDirs = fs.readdirSync(outDir)
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort().reverse();

      let unpublished = [];
      for (const dd of dateDirs) {
        const dp = path.join(outDir, dd);
        const sessions = fs.readdirSync(dp).filter(s => fs.statSync(path.join(dp, s)).isDirectory());
        for (const s of sessions) {
          const sp = path.join(dp, s);
          if (fs.existsSync(path.join(sp, '.published'))) continue;
          const files = fs.readdirSync(sp);
          const hasVideo = files.some(f => f.endsWith('.mp4'));
          const hasTxt = files.includes('文案.txt');
          if (hasVideo && hasTxt) {
            unpublished.push({ date: dd, session: s, path: sp });
          }
        }
      }

      if (unpublished.length === 0) {
        addLog('info', '📭 没有未发布的内容');
        return { ok: true, published: 0 };
      }

      // 取最新的一个发布
      const item = unpublished[0];
      addLog('info', `📤 发布: ${item.date}/${item.session}`);
      addLog('info', `  路径: ${item.path}`);

      // 调用 TikTok 发布器
      const { publishToTikTok } = await import('../src/publisher/tiktok.js');
      const videoFile = fs.readdirSync(item.path).find(f => f.endsWith('.mp4'));
      addLog('info', `  🎬 视频: ${videoFile}`);

      // 先写一个调试标记
      fs.writeFileSync(path.join(item.path, 'publish_debug.txt'), `start: ${new Date().toISOString()}\n`, 'utf-8');

      const url = await publishToTikTok({
        sessionPath: item.path,
        videoFile: path.join(item.path, videoFile),
        imageFiles: [],
        titleFile: path.join(item.path, '文案.txt'),
        envId,
        apiKey,
      });

      fs.appendFileSync(path.join(item.path, 'publish_debug.txt'), `end: ${new Date().toISOString()}\nurl: ${url || 'empty'}\n`, 'utf-8');

      // 查看截图文件
      const snapshots = fs.readdirSync(item.path).filter(f => f.startsWith('publish_') && f.endsWith('.png'));
      addLog('info', `  📸 截图: ${snapshots.length > 0 ? snapshots.join(', ') : '无'}`);

      // 标记已发布
      fs.writeJsonSync(path.join(item.path, '.published'), {
        publishedAt: new Date().toISOString(), platform: 'tiktok', url,
      }, { spaces: 2 });

      addLog('success', `✅ 发布成功!`);

      return { ok: true, published: 1 };
    } catch (err) {
      addLog('error', `❌ 发布失败: ${err.message}`);
      return { ok: false, message: err.message };
    }
  });

  // 手动触发采集（可选指定账号列表）
  ipcMain.handle('collect:run', async (_event, accounts) => {
    try {
      const accArg = Array.isArray(accounts) && accounts.length ? `--accounts ${accounts.join(',')}` : '';
      addLog('info', `📊 手动采集开始...${accArg ? ' (账号: ' + accounts.join(', ') + ')' : ''}`);

      return new Promise((resolve) => {
        const engineRoot = app.isPackaged
          ? path.join(process.resourcesPath, 'app.asar.unpacked')
          : ROOT;
        const scriptPath = path.join(engineRoot, 'src', 'collector', 'index.js');

        const args = [scriptPath];
        if (accArg) args.push('--accounts', accounts.join(','));

        const proc = spawn(NODE_EXE, args, {
          cwd: engineRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10 * 60 * 1000,
          windowsHide: true,
          env: {
            ...process.env,
            XNOWPOST_DATA_DIR: DATA_DIR,
          },
        });

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

        proc.on('close', (code) => {
          if (code === 0) {
            addLog('success', '✅ 数据采集完成');
            resolve({ ok: true });
          } else {
            addLog('error', `采集进程异常退出 (code: ${code})`);
            resolve({ ok: false, message: `进程异常退出 (code: ${code})` });
          }
        });

        proc.on('error', (err) => {
          addLog('error', `采集启动失败: ${err.message}`);
          resolve({ ok: false, message: err.message });
        });
      });
    } catch (err) {
      addLog('error', `❌ 采集失败: ${err.message}`);
      return { ok: false, message: err.message };
    }
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
      if (!availableDates.length) { db.close(); return null; }

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
      const configAccounts = loadConfig().accounts || [];
      let accountMeta = {};
      // 先从配置文件读取用户名
      for (const a of configAccounts) {
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

      // 采集时间戳
      let collectedAt = '';
      try {
        const cmPath = path.join(DATA_DIR, 'data', 'collect-meta.json');
        if (fs.existsSync(cmPath)) {
          const cm = fs.readJsonSync(cmPath);
          collectedAt = cm.collectedAtLocal || cm.collectedAt || '';
        }
      } catch (_) {}

      return { date, yesterday, availableDates, accounts, accountMeta, collectedAt };
    } catch (e) {
      console.error('读取日报数据失败:', e.message);
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
      const { sendMessage } = await import('../src/notifier.js');
      await sendMessage(text);
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

  // ffmpeg
  try {
    const { execSync } = await import('child_process');
    execSync('ffmpeg -version', { stdio: 'pipe', timeout: 5000, windowsHide: true });
  } catch (e) {
    issues.push('ffmpeg 未安装或不在 PATH');
  }

  // edge-tts
  try {
    const { execSync } = await import('child_process');
    execSync('edge-tts --version', { stdio: 'pipe', timeout: 5000, windowsHide: true });
  } catch (e) {
    issues.push('edge-tts 未安装或不在 PATH');
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
  const today = new Date().toISOString().split('T')[0];
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

// === 单实例锁（防重复启动） ===
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// === 调度器（定时任务后台进程） ===
let schedulerProcess = null;

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

  schedulerProcess.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      addLog('info', `⏰ ${line}`);
      // 检测调度器任务运行状态（匹配英文关键词）
      const l = line.toLowerCase();
      if (l.includes('start') || l.includes('run') || l.includes('begin')) {
        schedulerRunning = true;
        schedulerLastRun = new Date().toISOString().slice(0,19);
      } else if (l.includes('done') || l.includes('fail') || l.includes('complete') || l.includes('cancel')) {
        schedulerRunning = false;
      }
    }
  });

  schedulerProcess.stderr.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      addLog('warning', `⏰ ${line}`);
    }
  });

  schedulerProcess.on('exit', (code) => {
    schedulerProcess = null;
    if (code !== 0 && code !== null) {
      addLog('warning', `⚠️ 调度器异常退出 (code: ${code})，10s 后重启...`);
      setTimeout(startScheduler, 10_000);
    }
  });
}

// === 应用生命周期 ===
app.whenReady().then(async () => {
  // 安装版：DATA_DIR → userData（%APPDATA%/xnowpost），开发版沿用项目目录
  if (app.isPackaged) {
    DATA_DIR = app.getPath('userData');
  }

  // 初始化配置文件
  { const cfg = loadConfig(); try { await saveConfig(cfg); } catch {} }

  setupIPC();
  createWindow();
  initUpdater(mainWindow);
  autoBackup();
  healthCheck();
  startScheduler();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (schedulerProcess && !schedulerProcess.killed) {
    schedulerProcess.kill('SIGTERM');
  }
});
