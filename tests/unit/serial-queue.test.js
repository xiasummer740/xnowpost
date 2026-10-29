/**
 * 串行队列：定时任务绝不能因为"上一轮还没跑完"就丢掉一轮。
 * 守着 2026-10-29 审查发现的那个坑（spawnSync 占死事件循环 + node-cron 只认当前秒 ⇒ 静默丢轮）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSerialQueue } from '../../src/serial-queue.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('一个接一个跑：并发 push 也不会同时执行', async () => {
  const q = createSerialQueue();
  let running = 0;
  let maxConcurrent = 0;
  const order = [];
  const job = (name, ms) => async () => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    order.push(`start:${name}`);
    await sleep(ms);
    order.push(`end:${name}`);
    running -= 1;
    return name;
  };
  const results = await Promise.all([
    q.push(job('a', 30)),
    q.push(job('b', 5)),
    q.push(job('c', 1)),
  ]);
  assert.equal(maxConcurrent, 1, '任何时候都只能有一个任务在跑');
  assert.deepEqual(results, ['a', 'b', 'c'], '结果按入队顺序返回');
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
});

test('有任务排队时回调 onQueued（前面还有几个）', async () => {
  const seen = [];
  const q = createSerialQueue({ onQueued: (ahead, meta) => seen.push([ahead, meta]) });
  await Promise.all([
    q.push(async () => { await sleep(20); }, { label: '第一轮' }),
    q.push(async () => {}, { label: '第二轮' }),
    q.push(async () => {}, { label: '第三轮' }),
  ]);
  // 第 2 个任务排队时前面有 1 个，第 3 个排队时前面有 2 个（含正在跑的那个）
  assert.deepEqual(seen.map(([ahead]) => ahead), [1, 2]);
  assert.deepEqual(seen.map(([, m]) => m.label), ['第二轮', '第三轮']);
});

test('前一个任务抛错不会拖垮后面的任务', async () => {
  const q = createSerialQueue();
  const boom = q.push(async () => { throw new Error('引擎失败'); });
  const ok = q.push(async () => 'ok');
  await assert.rejects(boom, /引擎失败/);
  assert.equal(await ok, 'ok', '队列必须继续跑，否则一次失败会让整晚的闹钟全停');
});

test('depth 能反映积压，跑完回零', async () => {
  const q = createSerialQueue();
  assert.equal(q.depth, 0);
  const a = q.push(async () => { await sleep(10); });
  const b = q.push(async () => { await sleep(10); });
  assert.equal(q.depth, 2);
  await Promise.all([a, b]);
  assert.equal(q.depth, 0);
  assert.equal(q.maxSeen, 2);
});
