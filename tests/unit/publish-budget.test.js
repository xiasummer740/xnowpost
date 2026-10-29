/**
 * 发布总预算分配：宿主给 45 分钟，子进程按"还剩多少"分给每一条，不够就明确收工。
 * 守着 2026-10-29 审查发现（单条 30 分钟 × 不限条数 会被宿主 SIGKILL 掐在半路）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planItemBudget, totalFromHostTimeout, humanMin, TAIL_RESERVE_MS, MIN_ITEM_MS,
} from '../../src/publisher/budget.js';

const MIN = 60 * 1000;

test('总预算 45 分钟、刚开始跑、单条上限 30 分钟 → 给它 30 分钟（不是 45）', () => {
  const r = planItemBudget({ totalBudgetMs: 45 * MIN, elapsedMs: 0, perItemCapMs: 30 * MIN });
  assert.equal(r.ok, true);
  assert.equal(r.itemBudgetMs, 30 * MIN);
});

test('已经跑了 25 分钟 → 单条预算被压到 剩余-余量（不再傻给 30 分钟）', () => {
  const r = planItemBudget({ totalBudgetMs: 45 * MIN, elapsedMs: 25 * MIN, perItemCapMs: 30 * MIN });
  assert.equal(r.ok, true);
  // 45 - 25 = 20 剩，扣 4 分钟余量 → 16
  assert.equal(r.itemBudgetMs, 16 * MIN);
});

test('剩余不够再开一条 → 明确收工（不启动必然被掐死的发布）', () => {
  const r = planItemBudget({ totalBudgetMs: 45 * MIN, elapsedMs: 44 * MIN, perItemCapMs: 30 * MIN });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'budget-exhausted');
  assert.ok(r.remainingMs <= MIN);
});

test('边界：剩余刚好等于 余量+最小条目 → 还能跑（但单条=最小值）', () => {
  const total = 45 * MIN;
  const elapsed = total - (TAIL_RESERVE_MS + MIN_ITEM_MS);
  const r = planItemBudget({ totalBudgetMs: total, elapsedMs: elapsed, perItemCapMs: 30 * MIN });
  assert.equal(r.ok, true);
  assert.equal(r.itemBudgetMs, MIN_ITEM_MS);
});

test('边界：再少 1 毫秒就不跑了', () => {
  const total = 45 * MIN;
  const elapsed = total - (TAIL_RESERVE_MS + MIN_ITEM_MS) + 1;
  assert.equal(planItemBudget({ totalBudgetMs: total, elapsedMs: elapsed, perItemCapMs: 30 * MIN }).ok, false);
});

test('没给总预算（命令行手动跑）→ 保持老行为：单条上限', () => {
  const r = planItemBudget({ totalBudgetMs: 0, elapsedMs: 0, perItemCapMs: 30 * MIN });
  assert.equal(r.ok, true);
  assert.equal(r.itemBudgetMs, 30 * MIN);
  assert.equal(r.remainingMs, Infinity);
});

test('总预算没给、单条上限也没给 → 兜底 30 分钟', () => {
  assert.equal(planItemBudget({ totalBudgetMs: 0, elapsedMs: 0 }).itemBudgetMs, 30 * MIN);
});

test('总预算小于余量 → 一条都不跑', () => {
  assert.equal(planItemBudget({ totalBudgetMs: 2 * MIN, elapsedMs: 0, perItemCapMs: 30 * MIN }).ok, false);
});

test('宿主超时 45 分钟 → 子进程总预算 41 分钟（留 4 分钟收尾）', () => {
  assert.equal(totalFromHostTimeout(45 * MIN), 41 * MIN);
  assert.equal(totalFromHostTimeout(0), 0);
  assert.equal(totalFromHostTimeout(null), 0);
});

test('humanMin 说人话', () => {
  assert.equal(humanMin(30 * MIN), '30 分钟');
  assert.equal(humanMin(0), '0 分钟');
});
