/**
 * 跨进程互斥锁（调度器 ↔ 界面手动发布/采集）。
 *
 * 为什么需要（2026-10-29 审查发现）：
 * `publishInFlight` 只保护主进程**内部**的手动发布；调度器是独立进程，两边都可能在
 * 同一时刻开同一个 FoxProfile 环境 —— 而 `openFoxPage()` 会 `foxStopOthers()` 把对方的
 * 浏览器直接关掉，结果两边都失败，日志上互相甩锅（"Browser is still starting"）。
 *
 * 设计：`data/run.lock` 一个 JSON 文件（pid / kind / startedAt / beatAt）。
 *  - 抢锁：文件不存在、或持有者已死、或心跳超过 staleMs → 可以拿下；
 *  - 等待：`waitForLock()` 轮询，最多等 timeoutMs，超时就返回失败（调用方自己决定
 *    "继续跑还是报错" —— 调度器选择"继续跑并写日志"，宁可能撞也别整晚不干活）；
 *  - 心跳：长任务每 30 秒写一次 beatAt，避免被当成"死锁"抢走。
 *
 * 纯判定逻辑（isStale/canTakeOver）不碰 IO，单测在 tests/unit/run-lock.test.js。
 */
import fs from 'fs-extra';
import path from 'path';
import os from 'node:os';

export const LOCK_REL = path.join('data', 'run.lock');
export const DEFAULT_STALE_MS = 30 * 60 * 1000;   // 30 分钟没心跳视为死锁
export const BEAT_MS = 30 * 1000;

export function lockFile(dataDir) {
  return path.join(dataDir, LOCK_REL);
}

/** 锁内容是否过期（没心跳 / 心跳太旧 / 时间戳不可解析） */
export function isStale(lock, nowMs = Date.now(), staleMs = DEFAULT_STALE_MS) {
  if (!lock || typeof lock !== 'object') return true;
  const beat = Date.parse(lock.beatAt || lock.startedAt || '');
  if (!Number.isFinite(beat)) return true;
  return nowMs - beat > staleMs;
}

/** 持有者的进程还在不在（跨平台保守判断：EPERM 视为还活着） */
export function pidAlive(pid, killImpl = process.kill) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    killImpl(n, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/**
 * 判断能不能接管这把锁。
 * @returns {{take:boolean, reason:string, holder?:object}}
 */
export function canTakeOver(lock, opts = {}) {
  const { nowMs = Date.now(), staleMs = DEFAULT_STALE_MS, alive = pidAlive, selfPid = process.pid } = opts;
  if (!lock) return { take: true, reason: 'no-lock' };
  if (Number(lock.pid) === Number(selfPid)) return { take: true, reason: 'self' };
  if (isStale(lock, nowMs, staleMs)) return { take: true, reason: 'stale', holder: lock };
  if (!alive(lock.pid)) return { take: true, reason: 'holder-dead', holder: lock };
  return { take: false, reason: 'held', holder: lock };
}

export function readLock(file, fsImpl = fs) {
  try {
    if (!fsImpl.existsSync(file)) return null;
    const raw = fsImpl.readJsonSync(file);
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;   // 坏文件当没有锁：宁可两人撞一次，也不能永远卡死
  }
}

/** 试着拿锁（非阻塞）。成功返回 {ok:true, lock}，失败返回 {ok:false, holder} */
export function tryAcquire(file, { kind = 'job', pid = process.pid, fsImpl = fs, nowMs = Date.now(), staleMs = DEFAULT_STALE_MS, alive = pidAlive } = {}) {
  const cur = readLock(file, fsImpl);
  const verdict = canTakeOver(cur, { nowMs, staleMs, alive, selfPid: pid });
  if (!verdict.take) return { ok: false, holder: verdict.holder || cur, reason: verdict.reason };
  const lock = {
    pid,
    kind,
    startedAt: new Date(nowMs).toISOString(),
    beatAt: new Date(nowMs).toISOString(),
    host: (() => { try { return os.hostname(); } catch { return ''; } })(),
  };
  try {
    fsImpl.ensureDirSync(path.dirname(file));
    const tmp = `${file}.${pid}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify(lock, null, 2));
    fsImpl.renameSync(tmp, file);
  } catch (e) {
    return { ok: false, holder: cur, reason: `write-failed: ${e.message}` };
  }
  return { ok: true, lock };
}

export function beat(file, { pid = process.pid, fsImpl = fs, nowMs = Date.now() } = {}) {
  const cur = readLock(file, fsImpl);
  if (!cur || Number(cur.pid) !== Number(pid)) return false;
  try {
    fsImpl.writeJsonSync(file, { ...cur, beatAt: new Date(nowMs).toISOString() });
    return true;
  } catch {
    return false;
  }
}

export function release(file, { pid = process.pid, fsImpl = fs } = {}) {
  const cur = readLock(file, fsImpl);
  if (cur && Number(cur.pid) !== Number(pid)) return false;   // 别人的锁不删
  try {
    if (fsImpl.existsSync(file)) fsImpl.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function describeHolder(holder) {
  if (!holder) return '未知';
  const kindMap = { job: '定时任务', publish: '手动发布', collect: '手动采集', warmup: '养号' };
  const kind = kindMap[holder.kind] || holder.kind || '任务';
  return `${kind}（PID ${holder.pid}，始于 ${holder.startedAt || '?'}）`;
}

/**
 * 轮询等锁。拿到返回 {ok:true, lock}；超时返回 {ok:false, holder}。
 * @param {(msg:string)=>void} [onWait] 每次等待时可写一行日志（只在第一次和新持有者变化时调用）
 */
export async function waitForLock(file, {
  kind = 'job',
  pid = process.pid,
  timeoutMs = 15 * 60 * 1000,
  pollMs = 3000,
  fsImpl = fs,
  nowMs = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  staleMs = DEFAULT_STALE_MS,
  alive = pidAlive,
  onWait,
} = {}) {
  const deadline = nowMs() + timeoutMs;
  let waitedFor = '';
  for (;;) {
    const r = tryAcquire(file, { kind, pid, fsImpl, nowMs: nowMs(), staleMs, alive });
    if (r.ok) return r;
    const who = describeHolder(r.holder);
    if (typeof onWait === 'function' && who !== waitedFor) {
      waitedFor = who;
      onWait(`⏳ ${who} 正在运行，本轮排队等它结束（最多等 ${Math.round(timeoutMs / 60000)} 分钟）`);
    }
    if (nowMs() >= deadline) return { ok: false, holder: r.holder };
    await sleep(pollMs);
  }
}
