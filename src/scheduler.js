import 'dotenv/config';
import cron from 'node-cron';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { dataPath, resolveCodeRoot } from './paths.js';
import { writeJsonAtomicSync } from './fs-atomic.js';
import { todayStr } from './organizer.js';
import { checkLogins, resolveEnvs, allConfigEnvs, describeLogin } from './login-state.js';

// 代码目录（打包版 = app.asar.unpacked）与数据目录（%APPDATA%/xnowpost）是两回事：
// 子进程 cwd 用代码目录才能定位 src/*.js；日志与 TG 配置必须用数据目录，
// 否则安装版会读到安装目录里的旧配置（告警看似发送实则失败）。
const CODE_ROOT = resolveCodeRoot();
const LOG_DIR = dataPath('logs');
const USER_CONFIG_FILE = dataPath('config', 'user.json');
const SCHEDULE_FILE = dataPath('config', 'schedule.json');
const MAX_RETRIES = 2;
const RETRY_DELAY = 60_000;
const MIN = 60_000;

function envMs(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// 子进程超时预算（可用 XNOWPOST_TIMEOUT_* 环境变量覆盖）。
// P2-5：发布实际耗时预算 ≈33 分钟，原来统一 15 分钟（900s）会在发布中途杀掉子进程，
// 比特窗口残留、`.published` 未写 → 下一轮重复上传；超时一律按"未确认"处理（见 runOnce）。
const TIMEOUTS = {
  collect: envMs('XNOWPOST_TIMEOUT_COLLECT_MS', 15 * MIN),
  engine: envMs('XNOWPOST_TIMEOUT_ENGINE_MS', 30 * MIN),
  publish: envMs('XNOWPOST_TIMEOUT_PUBLISH_MS', 45 * MIN),
};

// 找到真正的 node.exe（不用 process.execPath 因为 electron.exe 是 GUI 程序，windowsHide 对它无效）
function findNodeExe() {
  // 1. 优先用同目录下的 node.exe（electron 自带的）
  const selfNode = path.join(path.dirname(process.execPath), 'node.exe');
  if (fs.existsSync(selfNode)) return selfNode;
  // 2. PATH 查找（spawnSync + 数组参数，不经过 shell）
  try {
    const r = spawnSync('where', ['node'], { encoding: 'utf-8', windowsHide: true, shell: false, timeout: 10_000 });
    const line = (r.stdout || '').trim().split('\n')[0];
    if (line) return line.trim();
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
  // 用本地日期（toISOString 是 UTC，北京时间 00:00–08:00 会写进前一天的日志）
  const d = todayStr();
  fs.ensureDirSync(LOG_DIR);
  return path.join(LOG_DIR, `scheduler-${d}.log`);
}

function localStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${todayStr()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(msg) {
  const line = `[${localStamp()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(getLogPath(), line + '\n');
  } catch (e) {
    console.error(`日志写入失败: ${e.message}`);
  }
}

async function sendAlert(message) {
  try {
    const axios = (await import('axios')).default;
    const config = fs.existsSync(USER_CONFIG_FILE) ? fs.readJsonSync(USER_CONFIG_FILE) : {};
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

/** 子进程输出按行转发到调度器日志 */
function forward(text) {
  if (!text) return;
  for (const line of String(text).split('\n')) {
    if (line.trim()) log(line.trim());
  }
}

/** 执行一次子进程（参数走数组、shell:false → 无命令注入面） */
function runOnce(args, { timeoutMs }) {
  const res = spawnSync(NODE_EXE, args, {
    cwd: CODE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,   // CLAUDE.md 硬规则：绝不允许 CMD 弹窗
    shell: false,        // 参数是数组，不拼 shell 字符串（原实现可被账号名注入）
  });

  forward(res.stdout);
  forward(res.stderr);

  const timedOut = !!res.error && res.error.code === 'ETIMEDOUT';
  if (timedOut) {
    return { ok: false, timeout: true, code: null, message: `超时 ${Math.round(timeoutMs / 1000)}s（子进程已被强制结束）` };
  }
  if (res.error) {
    return { ok: false, timeout: false, code: null, message: `启动/执行失败: ${res.error.message}` };
  }
  if (res.status !== 0) {
    return { ok: false, timeout: false, code: res.status, message: `退出码 ${res.status}` };
  }
  return { ok: true, timeout: false, code: 0, message: '' };
}

async function runWithRetry(args, label, { kind = 'engine', retryOnFail = true } = {}) {
  const timeoutMs = TIMEOUTS[kind] || TIMEOUTS.engine;
  const maxAttempts = retryOnFail ? MAX_RETRIES + 1 : 1;
  let lastMessage = '';
  let sawTimeout = false;

  for (let i = 0; i < maxAttempts; i++) {
    // 措辞与 electron/main.js 的状态识别对齐（START_RE 认"任务开始"、DONE_RE 认"完成/失败"）
    log(`🚀 ${label} 任务开始（超时预算 ${Math.round(timeoutMs / 1000)}s）`);
    const r = runOnce(args, { timeoutMs });

    if (r.ok) {
      log(`✅ ${label} 完成`);
      return { ok: true };
    }

    // 退出码 2 = 采集器明确报"数据不足"（页面只有「--」占位）。
    // 这种不是偶发故障，重试只会再开 10 个浏览器窗口白跑 2.5 分钟 —— 直接按"未采到数据"结束。
    // 行内必须同时出现 ❌ 和 失败：界面「调度进度」用 /❌\s*.+?失败/ 判断任务已结束。
    if (r.code === 2) {
      log(`❌ ${label} 失败：数据不足（TikTok 分析页只返回「--」占位，本轮不重试）`);
      log('   ℹ️ 这不是采集器故障：这些账号还没有可统计的播放/粉丝数据，等有数据后会自己恢复。');
      return { ok: false, insufficient: true };
    }

    lastMessage = r.message;
    if (r.timeout) {
      sawTimeout = true;
      // 超时 = 未确认：子进程被杀，产物/发布状态未知。既不能算成功，也不能盲目重试
      // （重试会重复上传同一个视频 / 重复计费），因此按失败处理并告警。
      log(`⏱️ ${label} ${r.message}：按失败处理（未确认：产物状态未知，请人工确认，本轮不重试）`);
      break;
    }

    log(`❌ ${label} 第${i + 1}次失败: ${r.message}`);
    if (i < maxAttempts - 1) {
      log(`⏳ 等待 ${RETRY_DELAY / 1000}s 后重试...`);
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
  }

  const head = sawTimeout ? '⏱️ 定时任务<b>未确认</b>（按失败处理）' : '⛔ 定时任务失败';
  const msg = `${head} <b>${label}</b>\n${sawTimeout ? '原因: 执行超时，子进程已被强制结束，需要人工确认产物/发布状态，本轮未重试' : `已重试 ${MAX_RETRIES} 次均失败\n原因: ${lastMessage}`}\n时间: ${new Date().toLocaleString('zh-CN')}\n日志: ${getLogPath()}`;
  log(msg);
  await sendAlert(msg);
  return { ok: false, timeout: sawTimeout };
}

function parseCron(timeStr) {
  const [h, m] = String(timeStr).split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  // 越界的时间（如 "99:99"）会让 node-cron 抛异常，这里先挡掉
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${m} ${h} * * *`;
}

/** 账号名安全化：只用于参数值，不做 shell 拼接；过滤掉会被当成选项的前导 '-' */
function safeAccountList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const list = raw.map(s => String(s).trim()).filter(Boolean);
  const bad = list.filter(s => s.startsWith('-'));
  if (bad.length) log(`⚠️ 忽略可疑账号名（不能以 - 开头）: ${bad.join(', ')}`);
  return list.filter(s => !s.startsWith('-'));
}

/** 读用户配置（账号 → 环境的映射都在这里） */
function loadUserConfig() {
  try {
    return fs.readJsonSync(USER_CONFIG_FILE);
  } catch (e) {
    log(`⚠️ 读不到 user.json（${e.message}），无法预检登录态`);
    return {};
  }
}

/**
 * 发布前登录态预检。
 *
 * 背景：2026-10-18 08:35 那轮定时，账号已经掉登录了，任务照样启动引擎、跑满
 * 5 分钟，到上传视频才发现页面是登录页，只留一个 FAILED 目录。
 *
 * 规则（宁可放过，不可误杀）：
 *   - state === 'out'      → 确定没登录，拦；
 *   - state === 'unknown'  → 库不存在/被占用/没 node:sqlite，只提示不拦；
 *   - state === 'in'       → 放行。
 */
async function precheckLogin(envs) {
  const list = (Array.isArray(envs) ? envs : [envs]).filter(Boolean);
  if (!list.length) return { out: [], unknown: [], all: [] };
  const map = await checkLogins(list);
  const all = list.map(e => map[e]);
  for (const one of all) log(`   🔐 ${describeLogin(one)}`);
  return {
    all,
    out: all.filter(r => r.state === 'out'),
    unknown: all.filter(r => r.state === 'unknown'),
  };
}

async function runJob(job) {
  const cfg = loadUserConfig();

  if (job.mode === 'collect') {
    // 如果保存了勾选的账号，只采集这些账号
    const accounts = safeAccountList(job.collectAccounts);
    const args = ['src/collector/index.js'];
    if (accounts.length) args.push('--accounts', accounts.join(','));
    // 采集不拦（采集器自己会跳过未登录的号），但先把「谁没登录」写进日志，
    // 否则只能等一轮跑完看「7 个账号采集失败」才知道
    const envs = accounts.length ? resolveEnvs(accounts.join(','), cfg) : allConfigEnvs(cfg);
    const pre = await precheckLogin(envs);
    if (pre.out.length) {
      log(`⚠️ 以下环境未登录，采集大概率会失败：${pre.out.map(r => r.env).join(', ')}`);
      log('   请到账号页点「启动」→ 手动登录（或用「批量登录」），再等下一轮。');
    }
    await runWithRetry(args, job.label, { kind: 'collect' });
    // daily.js 已被 collector/index.js 内部调用，无需单独执行
  } else if (job.mode === 'publish') {
    const envs = allConfigEnvs(cfg);
    const pre = await precheckLogin(envs);
    if (envs.length && pre.out.length === envs.length) {
      log(`⏭️ 跳过「${job.label || job.time}」：${envs.length} 个环境全都没登录。`);
      log('   发布一定是失败，本轮不启动发布器（省时间、不留 FAILED 目录）。');
      await sendAlert(`⏭️ 定时发布已跳过\n所有环境都未登录：${envs.join(', ')}\n时间: ${new Date().toLocaleString('zh-CN')}\n请先到账号页登录。`);
      return;
    }
    if (pre.out.length) {
      log(`⚠️ 这些环境未登录，本轮发布会跳过/失败：${pre.out.map(r => r.env).join(', ')}`);
    }
    await runWithRetry(['src/publisher/index.js', '--all'], job.label, { kind: 'publish' });
  } else {
    // 🔴 如果闹钟指定了账号，会加自动发布参数（作为独立 argv 元素传递，不拼字符串）
    const account = String(job.account || '').trim();
    const hasAccount = !!account && !account.startsWith('-');
    if (account && account.startsWith('-')) log(`⚠️ 忽略可疑账号名: ${account}`);

    // TikTok 的「相册/图片」自动发布通道从未实现：
    // 图文产出没有 mp4，自动发布会必然失败。引擎侧已改成**在花任何 API 费用前**退出 1，
    // 这里再拦一层，连子进程都不启动，避免每分钟空转一次 + 重试等待。
    if (job.mode === 'post' && hasAccount) {
      log(`⏭️ 跳过「图文 + 指定账号」闹钟（${job.label || job.time}）：`);
      log('   TikTok 图文自动发布通道未实现，图文产出没有 mp4，自动发布必然失败。');
      log('   请把该闹钟的「账号」去掉（改为纯图文生成），或删除这个闹钟。');
      log('   为避免白烧 API 费用，本轮不生成、不发布、不重试。');
      return;
    }

    // 指定了账号（= 会自动发布）时先验登录态：没登录就别花 API 费用生成
    if (hasAccount) {
      const envs = resolveEnvs(account, cfg);
      const pre = await precheckLogin(envs);
      if (pre.out.length) {
        log(`⏭️ 跳过「${job.label || job.time}」（账号 ${account}）：该环境未登录。`);
        log(`   ${pre.out.map(r => describeLogin(r)).join('；')}`);
        log('   自动发布会卡在登录页，本轮不生成、不发布、不重试（省 API 费用）。');
        await sendAlert(
          `⏭️ 定时任务已跳过\n账号 ${account}（${pre.out.map(r => r.env).join(',')}）未登录\n时间: ${new Date().toLocaleString('zh-CN')}\n请到账号页登录后再等下一轮。`,
        );
        return;
      }
    }

    const args = ['src/index.js'];
    if (job.mode === 'video') args.push('--video-only');
    else if (job.mode === 'post') args.push('--post-only');

    if (hasAccount) args.push('--auto-publish', '--account', account);

    // 自动发布模式不重试：重试会跑完整 engine 生成新内容，浪费钱
    // 超时（未确认）在 runWithRetry 内部一律不重试，避免重复上传/重复计费
    await runWithRetry(args, job.label, { kind: 'engine', retryOnFail: !hasAccount });
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
      writeJsonAtomicSync(SCHEDULE_FILE, DEFAULT_JOBS, 2);   // 原子写，避免半截 JSON 导致下次读取失败
      jobs = DEFAULT_JOBS;
    }
  } catch (e) {
    log(`⚠️ 读取 schedule.json 失败，使用默认配置: ${e.message}`);
    jobs = DEFAULT_JOBS;
  }

  if (!Array.isArray(jobs)) {
    log('⚠️ schedule.json 格式不是数组，使用默认配置');
    jobs = DEFAULT_JOBS;
  }

  const enabled = jobs.filter(j => j && j.enabled);
  if (enabled.length === 0) {
    log('⚠️ 没有启用的定时任务');
    return;
  }

  for (const job of enabled) {
    const cronExpr = parseCron(String(job.time || ''));
    if (!cronExpr) {
      log(`⚠️ 跳过无效时间: ${job.time}`);
      continue;
    }
    // cron 回调里的异步异常必须自己接住：Node 15+ 的未处理 rejection 会直接杀掉调度器进程
    let task;
    try {
      task = cron.schedule(cronExpr, () => {
        runJob(job).catch(e => log(`⚠️ 任务异常（${job.label}）: ${e.message || e}`));
      }, { timezone: 'Asia/Shanghai' });
    } catch (e) {
      log(`⚠️ 注册定时任务失败（${job.time} ${job.label}）: ${e.message}`);
      continue;
    }
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
console.log(`  -> config: ${SCHEDULE_FILE}`);
console.log(`  -> logs:   ${LOG_DIR}`);
console.log(`  -> cwd:    ${CODE_ROOT}`);
console.log(`  -> timeout: collect ${TIMEOUTS.collect / 1000}s / engine ${TIMEOUTS.engine / 1000}s / publish ${TIMEOUTS.publish / 1000}s`);
console.log(`  -> retry: ${MAX_RETRIES} times, hot-reload enabled\n`);

loadSchedule();
watchSchedule();

process.stdin.resume();
console.log('[Scheduler] ready (' + cronTasks.length + ' tasks)\n');
