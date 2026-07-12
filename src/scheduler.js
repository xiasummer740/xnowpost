import 'dotenv/config';
import cron from 'node-cron';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';

// 数据目录：优先用环境变量（Electron 传入），否则用项目目录
const DATA_DIR = process.env.XNOWPOST_DATA_DIR || path.resolve('.');
const ROOT = path.resolve('.');
const SCHEDULE_FILE = path.join(DATA_DIR, 'config', 'schedule.json');
const MAX_RETRIES = 2;
const RETRY_DELAY = 60_000;

// 找到真正的 node.exe（不用 process.execPath 因为 electron.exe 是 GUI 程序，windowsHide 对它无效）
function findNodeExe() {
  // 1. 优先用同目录下的 node.exe（electron 自带的）
  const elDir = path.dirname(process.execPath);
  const selfNode = path.join(elDir, 'node.exe');
  if (fs.existsSync(selfNode)) return selfNode;
  // 2. PATH 查找
  try {
    const r = execSync('where node', { stdio: 'pipe', encoding: 'utf-8', windowsHide: true });
    const lines = r.trim().split('\n');
    if (lines[0]) return lines[0].trim();
  } catch (_) {}
  // 3. fallback
  return 'node';
}
const NODE_EXE = findNodeExe();

// 默认配置（首次启动时写入）
const DEFAULT_JOBS = [
  { id: 1, time: '07:00', mode: 'auto',  label: '视频+图文', enabled: false, account: '' },
  { id: 2, time: '19:00', mode: 'video', label: '仅视频',    enabled: false, account: '' },
];

// 所有活跃的 cron 任务引用，用于热重载
let cronTasks = [];

function getLogPath() {
  const d = new Date().toISOString().split('T')[0];
  fs.ensureDirSync(path.join(ROOT, 'logs'));
  return path.join(ROOT, 'logs', `scheduler-${d}.log`);
}

function log(msg) {
  const line = `[${new Date().toISOString().slice(0,19)}] ${msg}`;
  console.log(line);
  fs.appendFileSync(getLogPath(), line + '\n');
}

async function sendAlert(message) {
  try {
    const axios = (await import('axios')).default;
    const config = fs.existsSync(path.join(ROOT, 'config', 'user.json'))
      ? fs.readJsonSync(path.join(ROOT, 'config', 'user.json'))
      : {};
    if (config.tgBotToken && config.tgChannelId) {
      await axios.post(`https://api.telegram.org/bot${config.tgBotToken}/sendMessage`, {
        chat_id: config.tgChannelId,
        text: `🚨 XNOW 定时任务告警\n\n${message}`,
        parse_mode: 'HTML',
      });
    }
  } catch (e) {
    log(`告警推送失败: ${e.message}`);
  }
}

async function runWithRetry(script, label, retryOnFail = true) {
  // 用真正的 node.exe，不用 process.execPath（electron.exe 是 GUI 程序，windowsHide 对它无效）
  const maxAttempts = retryOnFail ? MAX_RETRIES + 1 : 1;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      log(`🚀 ${label} 开始`);
      const result = execSync(`"${NODE_EXE}" ${script}`, { cwd: ROOT, stdio: 'pipe', timeout: 15 * 60 * 1000, windowsHide: true });
      // 转发子进程输出到调度器日志
      const output = result.toString().trim();
      if (output) {
        for (const line of output.split('\n').filter(Boolean)) {
          log(line.trim());
        }
      }
      log(`✅ ${label} 完成`);
      return;
    } catch (err) {
      if (err.stdout) {
        const out = err.stdout.toString().trim();
        if (out) for (const line of out.split('\n').filter(Boolean)) log(line.trim());
      }
      if (err.stderr) {
        const errOut = err.stderr.toString().trim();
        if (errOut) for (const line of errOut.split('\n').filter(Boolean)) log(line.trim());
      }
      log(`❌ ${label} 第${i+1}次失败: ${err.message}`);
      if (i < maxAttempts - 1) {
        log(`⏳ 等待 ${RETRY_DELAY/1000}s 后重试...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY));
      }
    }
  }
  // 自动发布模式（有 account）不重试，避免重跑 engine 生成新内容浪费钱
  if (retryOnFail) {
    const msg = `⛔ 定时任务 <b>${label}</b> 失败\n已重试 ${MAX_RETRIES} 次均失败\n时间: ${new Date().toLocaleString('zh-CN')}`;
    log(msg);
    await sendAlert(msg);
  }
}

function parseCron(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return `${m} ${h} * * *`;
}

function runJob(job) {
  if (job.mode === 'collect') {
    // 如果保存了勾选的账号，只采集这些账号
    const accFlag = job.collectAccounts ? `--accounts ${job.collectAccounts}` : '';
    runWithRetry(`src/collector/index.js ${accFlag}`.trim(), job.label);
    // daily.js 已被 collector/index.js 内部调用，无需单独执行
  } else if (job.mode === 'publish') {
    runWithRetry('src/publisher/index.js --all', job.label);
  } else {
    const flag = job.mode === 'video' ? '--video-only' : job.mode === 'post' ? '--post-only' : '';
    let cmd = `src/index.js ${flag}`.trim();

    // 🔴 如果闹钟指定了账号，加自动发布参数
    const hasAccount = !!job.account;
    if (hasAccount) {
      cmd += ` --auto-publish --account "${job.account}"`;
    }

    // 自动发布模式不重试：重试会跑完整 engine 生成新内容，浪费钱
    // Content check 假失败已修复，首次发布成功率应大幅提升
    runWithRetry(cmd, job.label, !hasAccount);
  }
}

// 加载配置并注册 cron
function loadSchedule() {
  // 清理旧任务
  cronTasks.forEach(t => t.stop());
  cronTasks = [];

  let jobs;
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      jobs = fs.readJsonSync(SCHEDULE_FILE);
    } else {
      fs.ensureDirSync(path.dirname(SCHEDULE_FILE));
      fs.writeJsonSync(SCHEDULE_FILE, DEFAULT_JOBS, { spaces: 2 });
      jobs = DEFAULT_JOBS;
    }
  } catch (e) {
    log(`⚠️ 读取 schedule.json 失败，使用默认配置: ${e.message}`);
    jobs = DEFAULT_JOBS;
  }

  const enabled = jobs.filter(j => j.enabled);
  if (enabled.length === 0) {
    log('⚠️ 没有启用的定时任务');
    return;
  }

  for (const job of enabled) {
    const cronExpr = parseCron(job.time);
    if (!cronExpr) {
      log(`⚠️ 跳过无效时间: ${job.time}`);
      continue;
    }
    const task = cron.schedule(cronExpr, () => runJob(job), { timezone: 'Asia/Shanghai' });
    cronTasks.push(task);
    log(`  ⏰ ${job.time} → ${job.label} ${job.mode !== 'collect' ? `(${job.mode})` : ''}`);
  }
}

// ===== 热重载：监听 schedule.json 变化 =====
let lastReload = 0;
function watchSchedule() {
  try {
    fs.watchFile(SCHEDULE_FILE, { interval: 3000 }, () => {
      const now = Date.now();
      if (now - lastReload < 5000) return; // 防抖
      lastReload = now;
      log('🔄 检测到配置变化，重新加载定时任务...');
      loadSchedule();
    });
  } catch (e) {
    log(`⚠️ 文件监听启动失败: ${e.message}`);
  }
}

// ===== 启动 =====
console.log('\n[Scheduler] XNOW Scheduler');
console.log('  -> config: config/schedule.json');
console.log('  -> retry: ' + MAX_RETRIES + ' times');
console.log('  -> hot-reload enabled\n');

loadSchedule();
watchSchedule();

process.stdin.resume();
console.log('[Scheduler] ready (' + cronTasks.length + ' tasks)\n');
