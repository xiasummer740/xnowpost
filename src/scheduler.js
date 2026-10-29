import 'dotenv/config';
import cron from 'node-cron';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { dataPath, resolveCodeRoot } from './paths.js';
import { writeJsonAtomicSync } from './fs-atomic.js';
import { todayStr } from './organizer.js';
import { checkLogins, resolveEnvs, allConfigEnvs, describeLogin } from './login-state.js';
import { buildRunRecord, resultFromRunWithRetry, pickSession, writeRunRecord, RUNS_REL } from './scheduled-run.js';
// 任务串行排队（不丢轮）+ 超时连进程树一起结束 + 跨进程互斥
import { createSerialQueue } from './serial-queue.js';
import { killTree } from './process-tree.js';
import * as runLock from './run-lock.js';
import { orderBatchAccounts, summarizeBatch, batchResult, perAccountBudgetMs, totalBudgetMs } from './batch-plan.js';

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
  // 发布：这个 45 分钟是**本轮发布的总时间**（不再是"每条 30 分钟 × 不限条数"的对不上）。
  // 真实宿主超时 = 它 + PUBLISH_SLACK_MS，总预算通过 XNOWPOST_PUBLISH_TOTAL_MS 交给子进程，
  // 由子进程逐条分配（src/publisher/budget.js）。
  publish: envMs('XNOWPOST_TIMEOUT_PUBLISH_MS', 45 * MIN),
  // 养号：每号默认 10 分钟 + 账号间隔，2~3 个号一轮约 25~40 分钟
  warmup: envMs('XNOWPOST_TIMEOUT_WARMUP_MS', 45 * MIN),
};
// 宿主比子进程多留的收尾时间（关浏览器、写标记/账本、写轮次记录）
const PUBLISH_SLACK_MS = 5 * MIN;
// 批量任务里每个号的发布留量：生成完顺路发布，单号最长等 15 分钟（含内容审查）
const BATCH_PUBLISH_ALLOW_MS = 15 * MIN;

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

/**
 * 这一轮的子进程输出（只留最近 400 行）。
 * 用途：从引擎的 `📅 …/am_0830 | 模式: video` 拿到本轮会话目录，写进轮次记录；
 * 不为了"看日志"把整轮输出留在内存里（一天 11 轮、每轮上千行）。
 */
let captureLines = null;
const CAPTURE_MAX = 400;
// 引擎的 `📅 …/am_0830 | 模式: video` 是本轮第 2~3 行 —— 被 400 行滚动缓冲挤掉之后，
// 轮次记录的 session 就是空串，回报退化成「没看到成片也没看到发布记录」。
// 所以开头这些行单独留住（它们才是"这轮到底做了什么"的证据）。
const CAPTURE_KEEP_HEAD = 40;

// 批量任务的计数（发布了几条 / 有几条没确认），每轮开始清零
let runCounters = null;

/** 子进程输出按行转发到调度器日志 */
function forward(text) {
  if (!text) return;
  for (const line of String(text).split('\n')) {
    const one = line.trim();
    if (!one) continue;
    log(one);
    // 批量任务要统计"这一轮到底发出去几条"：日志缓冲会被滚动淘汰，所以边转发边计数
    if (runCounters) {
      if (/\.published 已确认公开|发布成功并已确认/.test(one)) runCounters.published += 1;
      if (/未确认（|确认公开失败/.test(one)) runCounters.unconfirmed += 1;
    }
    if (captureLines) {
      captureLines.push(one);
      // 只从「开头之外」滚动淘汰：CAPTURE_KEEP_HEAD 之前的位置不动
      if (captureLines.length > CAPTURE_MAX) captureLines.splice(CAPTURE_KEEP_HEAD, 1);
    }
  }
}

/** 执行一次子进程（参数走数组、shell:false → 无命令注入面）
 *
 * 2026-10-29 改造：原来是 `spawnSync` —— 跑的时候整个事件循环被占死，
 *   ① node-cron 到点也触发不了 → 上一轮跨过下一轮的分钟，那一轮**当天直接消失**；
 *   ② 超时只杀直接子进程，浏览器/ffmpeg 留在后台占 cookies；
 *   ③ stdout 退出时才回放，日志里一整轮的时间戳全是同一个（复盘看不出卡在哪）。
 * 现在改成异步 spawn + 逐行转发：cron 准时触发（进串行队列），超时用 taskkill /T /F，
 * 日志时间是真实的。
 */
function runOnce(args, { timeoutMs, env = null }) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer = null;
    let child = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    try {
      child = spawn(NODE_EXE, args, {
        cwd: CODE_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,   // CLAUDE.md 硬规则：绝不允许 CMD 弹窗
        shell: false,        // 参数是数组，不拼 shell 字符串（原实现可被账号名注入）
        env: env ? { ...process.env, ...env } : process.env,
      });
    } catch (e) {
      return finish({ ok: false, timeout: false, code: null, message: `启动/执行失败: ${e.message}` });
    }

    // 增量转发：一轮跑到哪一步、几点几分，日志里都是真的。
    // ⚠️ 必须自己攒行：stdout 的 chunk 边界不等于行边界，直接 forward(chunk) 会把一行
    //    切成两半（`📅 …/am_0830` 被切开 → pickSession 抓不到 → 轮次记录 session 空）。
    let outBuf = '';
    let errBuf = '';
    const pump = (chunk, isErr) => {
      const text = (isErr ? (errBuf += chunk) : (outBuf += chunk));
      const lines = text.split('\n');
      const rest = lines.pop() || '';
      if (isErr) errBuf = rest; else outBuf = rest;
      for (const line of lines) forward(line + '\n');
    };
    const flushRest = () => {
      if (outBuf) { forward(outBuf + '\n'); outBuf = ''; }
      if (errBuf) { forward(errBuf + '\n'); errBuf = ''; }
    };
    if (child.stdout) child.stdout.on('data', (b) => pump(b.toString('utf-8'), false));
    if (child.stderr) child.stderr.on('data', (b) => pump(b.toString('utf-8'), true));

    timer = setTimeout(async () => {
      timedOut = true;
      const res = await killTree(child.pid, { onLog: log });
      if (res.ok) log(`⏱️ 超时 ${Math.round(timeoutMs / 1000)}s，已连同子进程树一起结束（PID ${child.pid}）`);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', (e) => { flushRest(); finish({ ok: false, timeout: false, code: null, message: `启动/执行失败: ${e.message}` }); });
    child.on('close', (code, signal) => {
      flushRest();   // 最后一行可能没有换行符
      if (timedOut) {
        return finish({ ok: false, timeout: true, code: null, message: `超时 ${Math.round(timeoutMs / 1000)}s（已连进程树一起结束）` });
      }
      if (signal) {
        return finish({ ok: false, timeout: false, code: null, message: `被信号结束 (${signal})` });
      }
      if (code !== 0) return finish({ ok: false, timeout: false, code, message: `退出码 ${code}` });
      finish({ ok: true, timeout: false, code: 0, message: '' });
    });
  });
}

async function runWithRetry(args, label, { kind = 'engine', retryOnFail = true, timeoutMs: timeoutOverride = 0, env = null } = {}) {
  // 养号这类「一批账号串行」的任务预算要按账号数算，所以允许调用方覆盖
  const timeoutMs = Number(timeoutOverride) > 0 ? Number(timeoutOverride) : (TIMEOUTS[kind] || TIMEOUTS.engine);
  const maxAttempts = retryOnFail ? MAX_RETRIES + 1 : 1;
  let lastMessage = '';
  let sawTimeout = false;

  for (let i = 0; i < maxAttempts; i++) {
    // 措辞与 electron/main.js 的状态识别对齐（START_RE 认"任务开始"、DONE_RE 认"完成/失败"）
    log(`🚀 ${label} 任务开始（超时预算 ${Math.round(timeoutMs / 1000)}s）`);
    const r = await runOnce(args, { timeoutMs, env });

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
      return { ok: false, insufficient: true, reason: '数据不足（分析页只有「--」占位）' };
    }

    // 退出码 3 = 「点了发布按钮，但没能证明已公开」（2026-10-19 P0-2）。
    // 既不算成功（旧实现记 ✅，真实结果无人知晓），也不能重试（重试会重复上传同一作品）。
    // 界面的调度进度靠 `⚠️ … 未确认` 这行判定已结束（electron/main.js 的 END_RE）。
    if (r.code === 3) {
      log(`⚠️ ${label} 未确认：已点击发布按钮但无法确认公开（不重试、不重发，请到 TikTok 后台核对）`);
      return { ok: false, unconfirmed: true, reason: '已点击发布按钮但无法确认公开' };
    }

    // 退出码 4 = 养号「部分成功」：有的号播放被拦/白屏（一条都没播），但别的号确实看了、点了。
    // 既不能记整轮失败（用户会以为熬夜白跑，实际 8/10 真的养了），也不能重试
    // （重试 = 再点一遍赞）。所以单独一个结果：部分完成，谁没养成写在日志里。
    if (r.code === 4) {
      log(`⚠️ ${label} 部分完成：有账号没养成（播放被拦或白屏，逐号明细见上），本轮不重试`);
      return { ok: true, partial: true, reason: '有账号没养成（播放被拦或白屏）' };
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
  // 只有真的重试过才写「已重试 N 次」：retryOnFail:false（养号就是）跑一次就失败时，
  // 旧文案会告诉用户「已重试 2 次」，等于凭空多出两次不存在的尝试，复盘时最误导人。
  const retried = maxAttempts > 1;
  const msg = `${head} <b>${label}</b>\n${sawTimeout ? '原因: 执行超时，子进程已被强制结束，需要人工确认产物/发布状态，本轮未重试' : (retried ? `已重试 ${MAX_RETRIES} 次均失败\n原因: ${lastMessage}` : `原因: ${lastMessage || '退出码非 0'}`)}\n时间: ${new Date().toLocaleString('zh-CN')}\n日志: ${getLogPath()}`;
  log(msg);
  await sendAlert(msg);
  return {
    ok: false,
    timeout: sawTimeout,
    reason: sawTimeout
      ? `执行超时，子进程已被强制结束（重试 ${MAX_RETRIES} 次也无效前就停了）`
      : retried ? `已重试 ${MAX_RETRIES} 次均失败：${lastMessage || '退出码非 0'}` : (lastMessage || '退出码非 0'),
  };
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

/**
 * `runWithRetry()` 的返回值 → runJob 的统一形状 `{ result, reason }`。
 * 三个调用点（采集 / 发布 / 引擎）共用这一份映射，别各写各的。
 */
function outcomeOf(r) {
  return { result: resultFromRunWithRetry(r), reason: r && !r.ok ? (r.reason || '') : '' };
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
    return outcomeOf(await runWithRetry(args, job.label, { kind: 'collect' }));
    // daily.js 已被 collector/index.js 内部调用，无需单独执行
  } else if (job.mode === 'publish') {
    const envs = allConfigEnvs(cfg);
    const pre = await precheckLogin(envs);
    if (envs.length && pre.out.length === envs.length) {
      log(`⏭️ 跳过「${job.label || job.time}」：${envs.length} 个环境全都没登录。`);
      log('   发布一定是失败，本轮不启动发布器（省时间、不留 FAILED 目录）。');
      await sendAlert(`⏭️ 定时发布已跳过\n所有环境都未登录：${envs.join(', ')}\n时间: ${new Date().toLocaleString('zh-CN')}\n请先到账号页登录。`);
      return { result: 'skipped', reason: `所有环境都没登录（${envs.join('、')}），没启动发布器` };
    }
    if (pre.out.length) {
      log(`⚠️ 这些环境未登录，本轮发布会跳过/失败：${pre.out.map(r => r.env).join(', ')}`);
    }
    return outcomeOf(await runWithRetry(['src/publisher/index.js', '--all'], job.label, {
      kind: 'publish',
      // 宿主超时 = 子进程总预算 + 收尾余量；总预算交给子进程逐条分配，
      // 这样"待发 2 条"时不会第一条吃掉 30 分钟、第二条被宿主掐死半路。
      timeoutMs: TIMEOUTS.publish + PUBLISH_SLACK_MS,
      env: { XNOWPOST_PUBLISH_TOTAL_MS: String(TIMEOUTS.publish) },
    }));
  } else if (job.mode === 'warmup') {
    // 养号：按勾选顺序一个号一个号养（同一时刻只开一个环境，共用 IP 不能并发）。
    // 每号时长在区间里随机抽（界面「8 分 ~ 15 分 随机/号」）。
    // 不重试（retryOnFail:false）：重跑等于再来一遍真实的点赞/关注，宁可少跑也不重复扣分。
    const fixed = Number(job.warmupMinutes);
    let lo = Number(job.warmupMinutesMin) > 0 ? Math.round(Number(job.warmupMinutesMin)) : 0;
    let hi = Number(job.warmupMinutesMax) > 0 ? Math.round(Number(job.warmupMinutesMax)) : 0;
    if (!lo && !hi && fixed > 0) { lo = hi = Math.round(fixed); }   // 兼容只有 warmupMinutes 的老配置
    if (!lo && !hi) { lo = 8; hi = 15; }
    if (!hi) hi = lo;
    if (!lo) lo = hi;
    if (hi < lo) [lo, hi] = [hi, lo];
    lo = Math.max(1, Math.min(60, lo));
    hi = Math.max(lo, Math.min(60, hi));

    const accounts = safeAccountList(job.warmupAccounts || job.account);
    if (!accounts.length) {
      log(`⏭️ 跳过「${job.label || job.time}」：这个养号闹钟还没勾选账号。`);
      log('   到「定时」页点「选择要养的账号」勾上要养的号（可多选，会按顺序一个一个养）。');
      return { result: 'skipped', reason: '养号闹钟没勾选账号（不知道该养谁）' };
    }
    const envs = resolveEnvs(accounts.join(','), cfg);
    const pre = await precheckLogin(envs);
    if (envs.length && pre.out.length === envs.length) {
      log(`⏭️ 跳过「${job.label || job.time}」：${envs.length} 个环境全都没登录，养号没有意义。`);
      return { result: 'skipped', reason: `所有环境都没登录（${envs.join('、')}）` };
    }
    if (pre.out.length) log(`⚠️ 这些环境未登录，本轮养号会跳过/失败：${pre.out.map((r) => r.env).join(', ')}`);

    // 超时按「账号数 × 最长时长 + 号间歇脚 + 开浏览器开销」算，别用固定 45 分钟：
    // 10 个号每个最多 15 分钟就要 2.5 小时，固定预算会把后半程直接掐掉。
    // 2026-10-29 实测：`launchAndWait` 等页面通道最多 150 秒 + 收尾关窗，
    // +1.5 分钟偏紧（11 个号时任何两个慢号就把后面的号顶掉），改 +3 分钟。
    const perAccountMax = hi + 3;              // +3 分钟：开/关浏览器、等页面通道(≤150s)、首页加载
    const gapMaxMin = (accounts.length - 1) * 2;  // 号与号之间最多歇 120 秒
    const budgetMin = Math.ceil(accounts.length * perAccountMax + gapMaxMin + 5);
    const timeoutMs = Math.max(TIMEOUTS.warmup, budgetMin * MIN);

    log(`👥 养号排队 ${accounts.length} 个号：${accounts.join(' → ')}`);
    log(`🎲 每号随机 ${lo}~${hi} 分钟（各自独立抽），最长预算约 ${budgetMin} 分钟`);
    const args = [
      'scripts/tk-warmup.mjs',
      '--accounts', accounts.join(','),
      '--minutes-min', String(lo),
      '--minutes-max', String(hi),
    ];
    return outcomeOf(await runWithRetry(args, job.label, { kind: 'warmup', retryOnFail: false, timeoutMs }));
  } else if (job.mode === 'batch') {
    // ── 批量：生成 + 发布，一个闹钟一串账号 ─────────────────────────────
    // 用户口径（2026-10-29）：「我设置闹钟开始，然后选择几个账号，你就按顺序生成、发布完就完事了」。
    // 以前要排 11 个「每 5 分钟一个」的闹钟，还得猜"一轮给多少分钟"——
    // 现在就是一个闹钟、一串账号，按顺序一个一个做，做完就结束。
    // 时间按账号数算（不再是固定 45 分钟那一套），中途某个号失败只跳过它，不影响后面的号。
    const picks = safeAccountList(job.accounts || job.accountsList || job.warmupAccounts || job.account);
    if (!picks.length) {
      log(`⏭️ 跳过「${job.label || job.time}」：这个批量闹钟还没勾选账号。`);
      log('   到「定时」页点「选择要处理的账号」勾上要跑的号（可多选，会按顺序一个一个跑）。');
      return { result: 'skipped', reason: '批量闹钟没勾选账号（不知道该跑谁）' };
    }
    // 顺序按配置里的账号顺序（勾选顺序可能乱），保证"01 → 02 → …"这种可预期的顺序
    const queue = orderBatchAccounts({
      picks,
      configAccounts: (cfg.accounts || []).map((a) => a.name),
    });

    const wantPublish = job.autoPublish !== false;
    // 每个号的预算：生成（TIMEOUTS.engine）+ 发布留量。发布在这个进程里顺路做，
    // 所以不能只给生成的那 30 分钟，否则发布必然被掐在半路。
    const perAccountMs = perAccountBudgetMs({
      engineMs: TIMEOUTS.engine,
      publishAllowMs: BATCH_PUBLISH_ALLOW_MS,
      wantPublish,
    });
    const totalMs = totalBudgetMs({ count: queue.length, perAccountMs, tailMs: 5 * MIN });

    log(`👥 批量任务：${queue.length} 个号按顺序跑 —— ${queue.join(' → ')}`);
    log(`   ${wantPublish ? '每个号：生成 → 自动发布' : '每个号：只生成，不发布'}；`
      + `单号最多 ${Math.round(perAccountMs / MIN)} 分钟，整轮最多 ${Math.round(totalMs / MIN)} 分钟`);
    log('   中途某个号失败只跳过它，后面的号继续（不会因为一个号没登录就整轮不跑）。');

    const pre = await precheckLogin(resolveEnvs(queue.join(','), cfg));
    const loggedOutEnvs = new Set(pre.out.map((r) => String(r.env || '').trim()));

    const done = [];      // 成功
    const failedList = []; // 失败
    const skippedList = []; // 跳过
    let published = 0;
    let unconfirmed = 0;

    for (let i = 0; i < queue.length; i += 1) {
      const account = queue[i];
      const tag = `账号 ${account}（${i + 1}/${queue.length}）`;
      // 登录态：未登录的号直接跳过（生成出来也发不出去，还白花钱）
      const envsOfThis = resolveEnvs(account, cfg);
      const outNow = envsOfThis.filter((e) => loggedOutEnvs.has(e));
      if (outNow.length && outNow.length === envsOfThis.length) {
        log(`⏭️ ${tag} 未登录，跳过（不生成、不发布，省 API 费用）`);
        skippedList.push(account);
        continue;
      }
      const args = ['src/index.js', '--video-only', '--account', account];
      if (wantPublish) args.push('--auto-publish');
      runCounters = { published: 0, unconfirmed: 0 };
      const r = await runWithRetry(args, `批量 · ${tag}`, {
        kind: 'engine',
        retryOnFail: false,          // 自动发布模式绝不重试（重试=重复上传/重复计费）
        timeoutMs: perAccountMs,
      });
      published += runCounters.published;
      unconfirmed += runCounters.unconfirmed;
      runCounters = null;
      if (r && r.ok) done.push(account);
      else if (r && r.insufficient) skippedList.push(account);
      else failedList.push(account);
    }

    const summary = summarizeBatch({
      total: queue.length,
      done,
      failed: failedList,
      skipped: skippedList,
      published,
      unconfirmed,
      wantPublish,
    });
    if (failedList.length || unconfirmed) {
      log(`⚠️ 批量任务跑完：${summary}`);
      await sendAlert(`⚠️ 批量任务（${job.label || job.time}）\n${summary}\n时间: ${new Date().toLocaleString('zh-CN')}`);
    } else {
      log(`✅ 批量任务跑完：${summary}`);
    }
    const result = batchResult({ total: queue.length, done, failed: failedList });
    return { result, reason: summary };
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
      return { result: 'skipped', reason: 'TikTok 图文自动发布通道未实现（图文产出没有 mp4），本轮没生成也没发布' };
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
        return {
          result: 'skipped',
          reason: `账号 ${account} 的环境没登录，本轮没花 API 费用、没生成也没发布`,
        };
      }
    }

    const args = ['src/index.js'];
    if (job.mode === 'video') args.push('--video-only');
    else if (job.mode === 'post') args.push('--post-only');

    if (hasAccount) args.push('--auto-publish', '--account', account);

    // 自动发布模式不重试：重试会跑完整 engine 生成新内容，浪费钱
    // 超时（未确认）在 runWithRetry 内部一律不重试，避免重复上传/重复计费
    return outcomeOf(await runWithRetry(args, job.label, { kind: 'engine', retryOnFail: !hasAccount }));
  }
}

/**
 * 跑一轮 + 落一条「轮次结果」记录。
 *
 * 记录写在 `<数据目录>/data/runs/<日期>-<HHMM>-<jobId>.json`，主进程监听这个目录，
 * 把结果**主动说进 AI 助手对话** —— 否则 00:30 / 08:30 那些轮次跑完，
 * 用户不问就永远不知道成没成（`reportEngineRun()` 只覆盖界面/助手叫的轮次）。
 *
 * 写记录本身绝不能让任务失败：整段包在 try 里，出错只打一行日志。
 */

// 串行队列：所有闹钟轮次一个接一个跑（同一时刻只有一个子进程 / 一个指纹环境）
const RUN_QUEUE = createSerialQueue({
  onQueued: (ahead, job) => {
    const name = (job && (job.label || job.time)) || '任务';
    log(`⏳ 上一轮还没跑完，「${name}」已排队（前面还有 ${ahead} 个）—— 这一轮不会丢，跑完就接着来`);
  },
});
// 跨进程锁文件（调度器 ↔ 界面手动发布/采集共用），等界面那头最多 20 分钟
const LOCK_FILE = runLock.lockFile(dataPath(''));
const LOCK_WAIT_MS = 20 * 60 * 1000;

async function runJobTracked(job) {
  // 串行队列：cron 到点就入队；前面还没跑完就排队等着（老实现是 spawnSync 占死事件循环，
  // 跨过下一轮的分钟 = 那一轮当天静默消失。宁可晚几分钟，也不能悄悄少发一条）。
  return RUN_QUEUE.push(() => executeJob(job), job);
}

/** 真正跑一轮（已进入串行队列，同一时刻只有一个） */
async function executeJob(job) {
  // 跨进程互斥：界面上手动「发布 / 采集」时，调度器别去抢同一个指纹环境
  // （openFoxPage 会 foxStopOthers 把对方的浏览器关掉，两边都失败）。
  const acquired = await runLock.waitForLock(LOCK_FILE, {
    kind: job.mode === 'warmup' ? 'warmup' : 'job',
    timeoutMs: LOCK_WAIT_MS,
    onWait: (m) => log(m),
  });
  if (!acquired.ok) {
    log(`⚠️ ${runLock.describeHolder(acquired.holder)} 占用超过 ${Math.round(LOCK_WAIT_MS / 60000)} 分钟，本轮仍然继续（总比整晚不干活好）`);
  }
  const beatTimer = setInterval(() => { try { runLock.beat(LOCK_FILE); } catch (_) { /* ignore */ } }, runLock.BEAT_MS);
  if (typeof beatTimer.unref === 'function') beatTimer.unref();

  const startedAtMs = Date.now();
  captureLines = [];
  runCounters = null;   // 计数只在批量分支里用，别把上一轮的数字带进来
  let outcome = { result: 'failed', reason: '' };
  try {
    outcome = (await runJob(job)) || { result: 'ok', reason: '' };
  } catch (e) {
    outcome = { result: 'failed', reason: String((e && e.message) || e) };
    log(`⚠️ 任务异常（${job.label}）: ${outcome.reason}`);
  } finally {
    const lines = captureLines || [];
    captureLines = null;
    try {
      // 会话目录从引擎自己的 `📅 …/am_0830` 行里取：比"猜最新目录"准，
      // 也不会把上一轮（或手动发布）的会话算成本轮产物。
      const sess = pickSession(lines);
      const record = buildRunRecord({
        job,
        startedAtMs,
        finishedAtMs: Date.now(),
        result: outcome.result,
        reason: outcome.reason,
        date: sess ? sess.date : todayStr(),
        session: sess ? sess.session : '',
        logFile: getLogPath(),
      });
      writeRunRecord(dataPath(RUNS_REL), record);
    } catch (e) {
      log(`⚠️ 轮次记录写入失败（不影响任务本身）: ${e.message}`);
    }
    runCounters = null;
    clearInterval(beatTimer);
    if (acquired.ok) {
      try { runLock.release(LOCK_FILE); } catch (_) { /* ignore */ }
    }
  }
  return outcome;
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
        // runJobTracked 内部已经 catch 了异常并落记录；这里再兜一层，
        // 因为 cron 回调里的未处理 rejection 会直接杀掉整个调度器进程。
        runJobTracked(job).catch(e => log(`⚠️ 任务异常（${job.label}）: ${e.message || e}`));
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
console.log(`  -> timeout: collect ${TIMEOUTS.collect / 1000}s / engine ${TIMEOUTS.engine / 1000}s / publish ${(TIMEOUTS.publish + PUBLISH_SLACK_MS) / 1000}s（其中发布总预算 ${TIMEOUTS.publish / 1000}s，逐条分配）`);
console.log(`  -> retry: ${MAX_RETRIES} times, hot-reload enabled\n`);

loadSchedule();
watchSchedule();

process.stdin.resume();
console.log('[Scheduler] ready (' + cronTasks.length + ' tasks)\n');
