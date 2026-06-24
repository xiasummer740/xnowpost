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

// 默认配置（首次启动时写入）
const DEFAULT_JOBS = [
  { id: 1, time: '07:00', mode: 'auto',    label: '早间内容（视频+图文）', enabled: false, account: '' },
  { id: 2, time: '19:00', mode: 'video',   label: '晚间视频',             enabled: false, account: '' },
  { id: 3, time: '21:00', mode: 'collect', label: '数据采集 + 日报',      enabled: false },
  { id: 4, time: '20:00', mode: 'publish', label: '自动发布（旧模式）',    enabled: false },
];

// 所有活跃的 cron 任务引用，用于热重载
let cronTasks = [];

function getLogPath() {
  const d = new Date().toISOString().split('T')[0];
  fs.ensureDirSync(path.join(ROOT, 'logs'));
  return path.join(ROOT, 'logs', `scheduler-${d}.log`);
}

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}`;
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
  // Electron 环境需要走 process.execPath + ELECTRON_RUN_AS_NODE
  const nodeCmd = process.env.XNOWPOST_DATA_DIR ? process.execPath : 'node';
  const env = process.env.XNOWPOST_DATA_DIR
    ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    : process.env;

  const maxAttempts = retryOnFail ? MAX_RETRIES + 1 : 1;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      execSync(`${nodeCmd} ${script}`, { cwd: ROOT, stdio: 'inherit', timeout: 15 * 60 * 1000, env, windowsHide: true });
      log(`✅ ${label} 完成`);
      return;
    } catch (err) {
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
    runWithRetry('src/collector/index.js', job.label);
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
console.log('\n⏰ XNOW 内容引擎调度器');
console.log('  · 配置来源: config/schedule.json');
console.log(`  · 失败重试 ${MAX_RETRIES} 次`);
console.log('  · 修改 schedule.json 自动热重载\n');

loadSchedule();
watchSchedule();

process.stdin.resume();
console.log(`✅ 调度器已就绪 (${cronTasks.length} 个任务)\n`);
