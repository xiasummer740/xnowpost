/**
 * 跨进程互斥锁（调度器 ↔ 界面手动发布/采集）。
 * 守着 2026-10-29 审查发现：两边同时开同一个 FoxProfile 环境 →
 * openFoxPage 的 foxStopOthers 会把对方的浏览器直接关掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import {
  isStale, pidAlive, canTakeOver, readLock, tryAcquire, beat, release,
  describeHolder, waitForLock, lockFile, DEFAULT_STALE_MS,
} from '../../src/run-lock.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xnow-lock-'));
const fakeFs = () => {
  const store = new Map();
  return {
    store,
    existsSync: (f) => store.has(f),
    ensureDirSync: () => {},
    readJsonSync: (f) => { if (!store.has(f)) { const e = new Error('ENOENT'); throw e; } return JSON.parse(store.get(f)); },
    writeFileSync: (f, data) => store.set(f, data),
    writeJsonSync: (f, obj) => store.set(f, JSON.stringify(obj)),
    renameSync: (a, b) => { store.set(b, store.get(a)); store.delete(a); },
    unlinkSync: (f) => store.delete(f),
  };
};

test('isStale：没心跳 / 心跳太旧 / 内容坏掉都算过期', () => {
  const now = Date.parse('2026-10-29T10:00:00Z');
  assert.equal(isStale(null, now), true);
  assert.equal(isStale({ beatAt: new Date(now - 1000).toISOString() }, now), false);
  assert.equal(isStale({ beatAt: new Date(now - DEFAULT_STALE_MS - 1).toISOString() }, now), true);
  assert.equal(isStale({ beatAt: 'not-a-date' }, now), true);
});

test('pidAlive：EPERM 视为活着（进程存在但没有权限）', () => {
  assert.equal(pidAlive(1234, () => {}), true);
  const eperm = () => { const e = new Error('nope'); e.code = 'EPERM'; throw e; };
  const esrch = () => { const e = new Error('gone'); e.code = 'ESRCH'; throw e; };
  assert.equal(pidAlive(1234, eperm), true);
  assert.equal(pidAlive(1234, esrch), false);
  assert.equal(pidAlive(0, () => {}), false);
});

test('canTakeOver：自己 / 死进程 / 过期 都能接管，活着的别人不能', () => {
  const now = Date.now();
  const fresh = { pid: 999, kind: 'job', beatAt: new Date(now).toISOString() };
  assert.equal(canTakeOver(null, { nowMs: now }).take, true);
  assert.equal(canTakeOver(fresh, { nowMs: now, selfPid: 999 }).reason, 'self');
  assert.equal(canTakeOver(fresh, { nowMs: now, selfPid: 1, alive: () => false }).reason, 'holder-dead');
  assert.equal(canTakeOver(fresh, { nowMs: now + DEFAULT_STALE_MS + 1, selfPid: 1, alive: () => true }).reason, 'stale');
  const held = canTakeOver(fresh, { nowMs: now, selfPid: 1, alive: () => true });
  assert.equal(held.take, false);
  assert.equal(held.reason, 'held');
});

test('抢锁 → 同一 pid 可重入 → 别人拿不到 → 释放后又能拿', () => {
  const f = fakeFs();
  const file = 'C:/data/run.lock';
  const a = tryAcquire(file, { kind: 'job', pid: 111, fsImpl: f, alive: () => true });
  assert.equal(a.ok, true);
  assert.equal(a.lock.kind, 'job');
  assert.equal(tryAcquire(file, { kind: 'publish', pid: 111, fsImpl: f, alive: () => true }).ok, true, '自己拿着当然能继续');
  const other = tryAcquire(file, { kind: 'publish', pid: 222, fsImpl: f, alive: () => true });
  assert.equal(other.ok, false, '别人不能抢');
  assert.equal(other.holder.pid, 111);
  assert.equal(release(file, { pid: 111, fsImpl: f }), true);
  assert.equal(tryAcquire(file, { kind: 'publish', pid: 222, fsImpl: f, alive: () => true }).ok, true);
});

test('别人的锁不能被误删（release 只删自己的）', () => {
  const f = fakeFs();
  const file = 'C:/data/run.lock';
  tryAcquire(file, { pid: 111, fsImpl: f, alive: () => true });
  assert.equal(release(file, { pid: 222, fsImpl: f }), false);
  assert.equal(readLock(file, f).pid, 111);
});

test('持有者进程已死 → 可以直接接管（别让一次崩溃把整晚的闹钟卡死）', () => {
  const f = fakeFs();
  const file = 'C:/data/run.lock';
  tryAcquire(file, { kind: 'job', pid: 111, fsImpl: f, alive: () => true });
  const r = tryAcquire(file, { kind: 'collect', pid: 222, fsImpl: f, alive: () => false, nowMs: Date.now() + 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.lock.pid, 222);
});

test('坏掉的锁文件当没有锁（宁可撞一次，也不能永远卡死）', () => {
  const f = fakeFs();
  const file = 'C:/data/run.lock';
  f.store.set(file, '{ 这不是 JSON');
  assert.equal(readLock(file, f), null);
  assert.equal(tryAcquire(file, { pid: 222, fsImpl: f }).ok, true);
});

test('beat 只更新自己的锁', () => {
  const f = fakeFs();
  const file = 'C:/data/run.lock';
  tryAcquire(file, { pid: 111, fsImpl: f, alive: () => true });
  assert.equal(beat(file, { pid: 222, fsImpl: f }), false);
  assert.equal(beat(file, { pid: 111, fsImpl: f, nowMs: Date.now() + 5000 }), true);
});

test('waitForLock：等到对方释放就返回成功；一直不释放则超时返回失败', async () => {
  const f = fakeFs();
  const file = 'C:/data/run.lock';
  tryAcquire(file, { pid: 111, fsImpl: f, alive: () => true });

  let waited = 0;
  const waits = [];
  let clock = Date.now();
  const p1 = waitForLock(file, {
    pid: 222, fsImpl: f, alive: () => true, pollMs: 1,
    timeoutMs: 200, sleep: async () => { waited += 1; if (waited === 2) release(file, { pid: 111, fsImpl: f }); },
    nowMs: () => clock, onWait: (m) => waits.push(m),
  });
  const r1 = await p1;
  assert.equal(r1.ok, true, '对方释放后应该拿到锁');
  assert.match(waits.join('\n'), /正在运行，本轮排队等它结束/);

  const f2 = fakeFs();
  tryAcquire(file, { pid: 333, fsImpl: f2, alive: () => true });
  let t = Date.now();
  const r2 = await waitForLock(file, {
    pid: 444, fsImpl: f2, alive: () => true, pollMs: 1, timeoutMs: 5,
    sleep: async () => { t += 10; }, nowMs: () => t,
  });
  assert.equal(r2.ok, false, '超时必须返回失败，让调用方自己决定要不要继续');
  assert.equal(r2.holder.pid, 333);
});

test('describeHolder 说人话', () => {
  assert.match(describeHolder({ pid: 111, kind: 'publish', startedAt: '2026-10-29T10:00:00Z' }), /手动发布（PID 111/);
  assert.match(describeHolder({ pid: 112, kind: 'job' }), /定时任务/);
  assert.equal(describeHolder(null), '未知');
});

test('lockFile 落在 data/run.lock', () => {
  assert.equal(lockFile('C:/d'), path.join('C:/d', 'data', 'run.lock'));
});
