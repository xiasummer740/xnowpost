import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { initUpdater, downloadUpdate, quitAndInstall, checkForUpdates } from './updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');

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
  // 串行化：后一个等前一个写完，读最新值再合并，防并发覆盖
  configWriteLock = configWriteLock.then(() => {
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
    return merged;
  });
  return configWriteLock;
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

// === 窗口创建 ===
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    title: app.isPackaged ? 'XNOWPost' : 'XNOWPost (开发版)',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--xnowpost-dev=${!app.isPackaged}`],
    },
    frame: true,
    autoHideMenuBar: true,
  });

  // 始终加载打包文件
  const distIndex = path.join(ROOT, 'dist', 'index.html');
  if (fs.existsSync(distIndex)) {
    mainWindow.loadFile(distIndex);
  } else {
    // fallback: 开发模式连 Vite 服务器
    mainWindow.loadURL('http://localhost:5173');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 窗口关闭时杀死运行中的引擎子进程
  mainWindow.on('close', () => {
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
      const proc = spawn(process.execPath, [scriptPath, ...args], {
        cwd: engineRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15 * 60 * 1000,
        windowsHide: true,  // 不弹 CMD 窗口
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          XNOWPOST_DATA_DIR: DATA_DIR,  // 引擎输出目录与"打开输出目录"按钮一致
        },
      });
      engineProcess = proc;
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

      // 读图片（转 base64，限制尺寸避免卡 UI）
      const images = files
        .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
        .slice(0, 9)
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
  ipcMain.handle('config:test', async (_event, type) => {
    const config = loadConfig();

    if (type === 'deepseek') {
      if (!config.deepseekApiKey) return { ok: false, message: '请先填写 DeepSeek API Key' };
      try {
        const OpenAI = (await import('openai')).default;
        const client = new OpenAI({
          apiKey: config.deepseekApiKey,
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
      if (!config.siliconflowApiKey) return { ok: false, message: '请先填写硅基流动 API Key' };
      try {
        // 测试生图 API
        const axios = (await import('axios')).default;
        const resp = await axios.post(
          'https://api.siliconflow.cn/v1/images/generations',
          { model: 'Kwai-Kolors/Kolors', prompt: 'test', image_size: '512x512', batch_size: 1, guidance_scale: 7.5 },
          { headers: { Authorization: `Bearer ${config.siliconflowApiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 }
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
      if (!config.tgBotToken) return { ok: false, message: '请先填写 TG Bot Token' };
      try {
        const axios = (await import('axios')).default;
        const resp = await axios.get(`https://api.telegram.org/bot${config.tgBotToken}/getMe`, { timeout: 10000 });
        if (resp.data?.ok) {
          return { ok: true, message: `TG Bot ✅ @${resp.data.result.username} 连接成功` };
        }
        return { ok: false, message: 'TG ❌ Token 无效' };
      } catch (err) {
        return { ok: false, message: 'TG ❌ ' + (err.response?.data?.description || err.message) };
      }
    }

    if (type === 'pexels') {
      if (!config.pexelsApiKey) return { ok: false, message: '请先填写 Pexels API Key' };
      try {
        const axios = (await import('axios')).default;
        const resp = await axios.get('https://api.pexels.com/v1/search?query=test&per_page=1', {
          headers: { Authorization: config.pexelsApiKey }, timeout: 10000,
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
}

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

      return { date, yesterday, availableDates, accounts };
    } catch (e) {
      console.error('读取日报数据失败:', e.message);
      return null;
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

  schedulerProcess = spawn(process.execPath, [scriptPath], {
    cwd: schedulerRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,  // 不弹 CMD 窗口
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      XNOWPOST_DATA_DIR: DATA_DIR,
    },
  });

  schedulerProcess.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      console.log(`[调度器] ${line}`);
      addLog('info', `⏰ ${line}`);
      // 检测调度器任务运行状态
      if (line.includes('🚀') || line.includes('开始') || line.includes('引擎启动')) {
        schedulerRunning = true;
        schedulerLastRun = new Date().toLocaleString('zh-CN');
      } else if (line.includes('完成') || line.includes('失败') || line.includes('已取消')) {
        schedulerRunning = false;
      }
    }
  });

  schedulerProcess.stderr.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      console.error(`[调度器] ${line}`);
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
