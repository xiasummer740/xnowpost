import 'dotenv/config';
import cron from 'node-cron';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs-extra';

const ROOT = path.resolve('.');
const MAX_RETRIES = 2;
const RETRY_DELAY = 60_000; // 60 秒

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
    const configPath = path.join(ROOT, 'config', 'user.json');
    let config = {};
    if (fs.existsSync(configPath)) config = fs.readJsonSync(configPath);

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

async function runWithRetry(script, label) {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      execSync(`node ${script}`, {
        cwd: ROOT,
        stdio: 'inherit',
        timeout: 10 * 60 * 1000,
      });
      log(`✅ ${label} 完成`);
      return;
    } catch (err) {
      log(`❌ ${label} 第${i+1}次失败: ${err.message}`);
      if (i < MAX_RETRIES) {
        log(`⏳ 等待 ${RETRY_DELAY/1000}s 后重试...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY));
      }
    }
  }

  // 所有重试失败 → 发告警
  const msg = `⛔ 定时任务 <b>${label}</b> 失败\n已重试 ${MAX_RETRIES} 次均失败\n时间: ${new Date().toLocaleString('zh-CN')}`;
  log(msg);
  await sendAlert(msg);
}

console.log('⏰ XNOW 内容引擎调度器启动');
console.log('  · 早 7:00 — 生成 1 视频 + 1 图文');
console.log('  · 晚 19:00 — 生成 1 视频');
console.log('  · 晚 21:00 — 数据采集 + 日报');
console.log(`  · 失败重试 ${MAX_RETRIES} 次 · 告警推送已${fs.existsSync(path.join(ROOT, 'config', 'user.json')) ? '开启' : '关闭（需配置 TG Bot）'}`);
console.log('');

// 每天早上 7:00 — 1 视频 + 1 图文
cron.schedule('0 7 * * *', () => {
  runWithRetry('src/index.js', '早间内容 (1视频+1图文)');
}, { timezone: 'Asia/Shanghai' });

// 每天晚上 19:00 — 1 视频
cron.schedule('0 19 * * *', () => {
  runWithRetry('src/index.js', '晚间内容 (1视频)');
}, { timezone: 'Asia/Shanghai' });

// 每天晚上 21:00 — 数据采集 + 日报
cron.schedule('0 21 * * *', () => {
  runWithRetry('src/collector/index.js', '数据采集');
  runWithRetry('src/analyzer/daily.js', '日报推送');
}, { timezone: 'Asia/Shanghai' });

// 保持进程存活
process.stdin.resume();
console.log('✅ 调度器已就绪，等待定时触发...\n');
