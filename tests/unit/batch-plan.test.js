/**
 * 批量闹钟（一个闹钟一串账号）：顺序、汇总、结果码、预算。
 * 用户口径：「我设置闹钟开始，然后选择几个账号，你就按顺序生成、发布完就完事了」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  orderBatchAccounts,
  summarizeBatch,
  batchResult,
  perAccountBudgetMs,
  totalBudgetMs,
} from '../../src/batch-plan.js';

const CONFIG = ['01', '02', '03', '04', '05'];

test('orderBatchAccounts：按配置顺序排，不管勾选顺序', () => {
  assert.deepEqual(
    orderBatchAccounts({ picks: ['05', '03', '01'], configAccounts: CONFIG }),
    ['01', '03', '05'],
    '先点 05 再点 01，也必须 01 先跑',
  );
});

test('orderBatchAccounts：配置里没有的号排在后面，仍然会跑', () => {
  assert.deepEqual(
    orderBatchAccounts({ picks: ['07', '02'], configAccounts: CONFIG }),
    ['02', '07'],
  );
});

test('orderBatchAccounts：去重 + 忽略空值', () => {
  assert.deepEqual(
    orderBatchAccounts({ picks: ['02', ' 02 ', '', null, '01'], configAccounts: CONFIG }),
    ['01', '02'],
  );
});

test('orderBatchAccounts：没有配置账号时按勾选顺序原样跑', () => {
  assert.deepEqual(orderBatchAccounts({ picks: ['05', '01'], configAccounts: [] }), ['05', '01']);
  assert.deepEqual(orderBatchAccounts({}), []);
});

test('summarizeBatch：全成功', () => {
  const s = summarizeBatch({ total: 3, done: ['01', '02', '03'], published: 3, wantPublish: true });
  assert.equal(s, '3 个号，成功 3，发布 3 条');
});

test('summarizeBatch：失败和跳过都点名', () => {
  const s = summarizeBatch({
    total: 4,
    done: ['01'],
    failed: ['02'],
    skipped: ['03'],
    published: 1,
    wantPublish: true,
  });
  assert.match(s, /^4 个号，成功 1，失败 1（02），跳过 1（03），发布 1 条$/);
});

test('summarizeBatch：未确认要说清是"点过 Post 但没证明公开"，不能报成成功', () => {
  const s = summarizeBatch({ total: 1, done: ['01'], published: 0, unconfirmed: 1, wantPublish: true });
  assert.match(s, /发布 0 条/);
  assert.match(s, /未确认 1 条（点过 Post 但没证明公开，请人工核对）/);
});

test('summarizeBatch：只生成（不发布）时不出现"发布"字样', () => {
  const s = summarizeBatch({ total: 2, done: ['01', '02'], wantPublish: false });
  assert.equal(s, '2 个号，成功 2');
});

test('batchResult：有失败就是 failed，一个都没成就是 skipped', () => {
  assert.equal(batchResult({ total: 2, done: ['01'], failed: ['02'] }), 'failed');
  assert.equal(batchResult({ total: 2, done: ['01'], failed: [] }), 'ok');
  assert.equal(batchResult({ total: 2, done: [], failed: [] }), 'skipped');
  assert.equal(batchResult({ total: 2, done: [], failed: ['01', '02'] }), 'failed');
});

test('perAccountBudgetMs / totalBudgetMs：预算跟着账号数走，不再是固定 45 分钟', () => {
  const engine = 30 * 60 * 1000;
  const allow = 15 * 60 * 1000;
  assert.equal(perAccountBudgetMs({ engineMs: engine, publishAllowMs: allow, wantPublish: true }), 45 * 60 * 1000);
  assert.equal(perAccountBudgetMs({ engineMs: engine, publishAllowMs: allow, wantPublish: false }), engine);
  const per = perAccountBudgetMs({ engineMs: engine, publishAllowMs: allow, wantPublish: true });
  assert.equal(totalBudgetMs({ count: 11, perAccountMs: per, tailMs: 5 * 60 * 1000 }), 11 * 45 * 60 * 1000 + 5 * 60 * 1000);
  assert.equal(totalBudgetMs({ count: 0, perAccountMs: per }), 0, '一个号都没勾就是 0，不能凭空给预算');
});
