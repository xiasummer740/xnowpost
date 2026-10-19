/**
 * 定时任务 id 编码规则单测（`src/job-ids.js`）。
 *
 * 为什么值得钉：id 混编码是用户真实提过的问题（13 位时间戳和 1/2/102 混在一份配置里，
 * 看日志容易误认成账号号）。规则一旦松掉，新任务又会冒出一堆四位数/时间戳。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_JOB_ID,
  isValidJobId,
  reconcileJobIds,
  nextJobId,
  renumberJobs,
  jobSortKey,
} from '../../src/job-ids.js';

test('合法 id：1~999 的整数', () => {
  for (const v of [1, 2, 102, 999]) assert.equal(isValidJobId(v), true, `${v} 应合法`);
  for (const v of [0, -1, 1000, 1783852240727, 1.5, 'abc', null, undefined, '', NaN]) {
    assert.equal(isValidJobId(v), false, `${v} 不该合法`);
  }
  // 字符串数字也认（JSON 里可能被写成 "12"）
  assert.equal(isValidJobId('12'), true);
});

test('合法 id 一个都不改（只增不改）', () => {
  const jobs = [{ id: 1 }, { id: 5 }, { id: 999 }];
  const max = reconcileJobIds(jobs);
  assert.deepEqual(jobs.map((j) => j.id), [1, 5, 999]);
  assert.equal(max, 999);
});

test('重复 id：首个保留，后面的领新号', () => {
  const jobs = [{ id: 2 }, { id: 101 }, { id: 101 }];
  reconcileJobIds(jobs);
  assert.deepEqual(jobs.map((j) => j.id), [2, 101, 102]);
});

test('13 位时间戳 id 被判为非法，自动换成小序号', () => {
  const jobs = [
    { id: 1, time: '08:30', account: '01' },
    { id: 1783852240727, time: '08:40', account: '03' },
    { id: 2, time: '08:35', account: '02' },
  ];
  reconcileJobIds(jobs);
  const ids = jobs.map((j) => j.id);
  assert.deepEqual(ids.slice(0, 2), [1, 3], '合法 1/2 保留，时间戳的换成 3');
  assert.equal(ids[2], 2);
  assert.ok(ids.every((n) => n <= MAX_JOB_ID), '不许再出现四位数以上');
  // 其它字段不许被碰
  assert.equal(jobs[1].time, '08:40');
  assert.equal(jobs[1].account, '03');
});

test('nextJobId：永远是当前最大值 +1，不会和已有 id 撞', () => {
  assert.equal(nextJobId([], 0), 1);
  assert.equal(nextJobId([{ id: 3 }, { id: 9 }], 0), 10);
  assert.equal(nextJobId([{ id: 3 }, { id: 9 }], 20), 21, '缓存序号更大时也要跟着它');
  const jobs = [{ id: 1 }, { id: 2 }];
  const a = nextJobId(jobs, 0);
  jobs.push({ id: a });
  const b = nextJobId(jobs, 0);
  assert.notEqual(a, b);
});

test('nextJobId：到上限后回收最小空号，不越过 999', () => {
  const jobs = [];
  for (let i = 1; i <= MAX_JOB_ID; i += 1) if (i !== 7) jobs.push({ id: i });
  assert.equal(nextJobId(jobs, MAX_JOB_ID), 7, '999 已满，应回收空号 7');
  assert.throws(() => {
    const full = [];
    for (let i = 1; i <= MAX_JOB_ID; i += 1) full.push({ id: i });
    nextJobId(full, MAX_JOB_ID);
  }, /上限/);
});

test('迁移发号顺序：启用优先 → 内容类优先于采集 → 按时间', () => {
  const jobs = [
    { id: 500, time: '10:00', mode: 'collect', account: '', enabled: true },
    { id: 501, time: '09:05', mode: 'video', account: '08', enabled: true },
    { id: 502, time: '00:30', mode: 'collect', account: '01', enabled: false },
    { id: 503, time: '08:30', mode: 'video', account: '01', enabled: true },
    { id: 504, time: '19:00', mode: 'auto', account: '', enabled: true },
    { id: 505, time: '01:00', mode: 'video', account: '07', enabled: false },
  ];
  const { after } = renumberJobs(jobs);
  assert.deepEqual(
    after.map((r) => [r.id, r.time, r.mode]),
    [
      [1, '08:30', 'video'],
      [2, '09:05', 'video'],
      [3, '19:00', 'auto'],
      [4, '10:00', 'collect'],
      [5, '01:00', 'video'],   // 停用组内仍是「内容类优先于采集」
      [6, '00:30', 'collect'],
    ],
  );
});

test('迁移：08:30–09:15 十个视频任务拿到 1–10，和账号一一对应', () => {
  const accounts = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'];
  const times = ['08:30', '08:35', '08:40', '08:45', '08:50', '08:55', '09:00', '09:05', '09:10', '09:15'];
  // 故意打乱顺序 + 混入时间戳 id，模拟真实配置
  const jobs = accounts
    .map((account, i) => ({ id: i % 2 ? 1783852240727 + i : i + 1, time: times[i], mode: 'video', account, enabled: true }))
    .reverse();
  const { jobs: out, after } = renumberJobs(jobs);
  // 输出保序（不排序数组），编号按时间/类型分配 —— 用 after 映射表核对
  for (let i = 0; i < accounts.length; i += 1) {
    const row = after[i];
    assert.equal(row.id, i + 1, `${row.time} 应是 #${i + 1}`);
    assert.equal(row.account, accounts[i], `${row.time} 应对应账号 ${accounts[i]}`);
  }
  assert.equal(out.length, accounts.length, '任务数不许变');
});

test('迁移是纯函数：不动入参，且保序前先拷贝其它字段', () => {
  const jobs = [{ id: 1783852240727, time: '08:40', enabled: true }, { id: 1, time: '08:30', enabled: false }];
  const snapshot = JSON.parse(JSON.stringify(jobs));
  const { jobs: out } = renumberJobs(jobs);
  assert.deepEqual(jobs, snapshot, '入参不能被改');
  // 输出保序（不排序数组），只有 id 变了
  assert.equal(out[0].time, '08:40');
  assert.equal(out[1].time, '08:30');
  // 启用中的 08:40 拿 1 号，停用的 08:30 拿 2 号
  assert.equal(out[0].id, 1);
  assert.equal(out[1].id, 2);
  assert.equal(out[0].enabled, true);
});

test('jobSortKey：启用优先，其次内容类优先于采集，再按时间', () => {
  const on = jobSortKey({ mode: 'video', time: '23:00', enabled: true });
  const off = jobSortKey({ mode: 'video', time: '00:10', enabled: false });
  assert.ok(on[0] < off[0], '启用中的排在停用之前（哪怕时间更晚）');
  assert.ok(jobSortKey({ mode: 'video', time: '23:00' })[1] < jobSortKey({ mode: 'collect', time: '00:10' })[1]);
  assert.equal(jobSortKey({ time: '08:30', mode: 'video' })[2], '08:30');
  assert.equal(jobSortKey({ time: '08:30', mode: 'video', account: '03' })[3], '03');
});

test('迁移遇到空/坏数据不炸', () => {
  assert.deepEqual(renumberJobs([]).jobs, []);
  assert.deepEqual(renumberJobs(null).jobs, []);
  const { jobs } = renumberJobs([null, { time: '08:30', mode: 'video' }]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 1);
});
