/**
 * 原子写工具 —— 先写临时文件，再 rename 替换目标
 *
 * 为什么需要：原代码大量使用 fs.writeFileSync(目标, 内容) 直接截断重写。
 * 若进程在写入中途被杀（调度器 900s 超时、用户关窗、FFmpeg OOM），
 * 目标文件会变成半截内容 —— 对 sql.js 导出的整个历史库来说就是**数据全毁**，
 * 对 cost.json / history.json 来说就是 JSON 解析失败、费用与去重记录丢失。
 *
 * rename 在同一分区上是原子操作，因此只有「旧文件」或「新文件」两种状态，
 * 不会出现中间态。
 */
import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';

function tmpNameFor(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const rnd = crypto.randomBytes(4).toString('hex');
  return path.join(dir, `.${base}.${process.pid}.${rnd}.tmp`);
}

// Windows 的 rename(MoveFileEx+REPLACE_EXISTING) 会在目标文件被其它句柄短暂占用时
// 抛出 EPERM/EBUSY/EACCES —— 杀毒软件扫描、索引服务、并发写同一文件都会造成。
// 这类错误是**瞬时**的，重试即可；不重试就会丢一次写入。
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function sleepSync(ms) {
  // 唯一可在同步代码里真正阻塞的方式
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameSyncWithRetry(from, to, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      lastErr = e;
      if (!TRANSIENT_RENAME_CODES.has(e.code) || i === attempts - 1) throw e;
      sleepSync(20 * (i + 1));   // 20/40/60/80/100ms 退避
    }
  }
  throw lastErr;
}

async function renameWithRetry(from, to, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      lastErr = e;
      if (!TRANSIENT_RENAME_CODES.has(e.code) || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, 20 * (i + 1)));
    }
  }
  throw lastErr;
}

/** 原子写文本/Buffer（同步版） */
export function writeFileAtomicSync(filePath, data, options = 'utf-8') {
  fs.ensureDirSync(path.dirname(filePath));
  const tmp = tmpNameFor(filePath);
  try {
    fs.writeFileSync(tmp, data, options);
    renameSyncWithRetry(tmp, filePath); // Windows 上会覆盖已存在文件
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw e;
  }
}

/** 原子写 JSON（同步版） */
export function writeJsonAtomicSync(filePath, obj, spaces = 2) {
  writeFileAtomicSync(filePath, JSON.stringify(obj, null, spaces), 'utf-8');
}

/** 原子写文本/Buffer（异步版） */
export async function writeFileAtomic(filePath, data, options = 'utf-8') {
  await fs.ensureDir(path.dirname(filePath));
  const tmp = tmpNameFor(filePath);
  try {
    await fs.writeFile(tmp, data, options);
    await renameWithRetry(tmp, filePath);
  } catch (e) {
    try { if (await fs.pathExists(tmp)) await fs.unlink(tmp); } catch (_) { /* ignore */ }
    throw e;
  }
}

/** 原子写 JSON（异步版） */
export async function writeJsonAtomic(filePath, obj, spaces = 2) {
  return writeFileAtomic(filePath, JSON.stringify(obj, null, spaces), 'utf-8');
}
