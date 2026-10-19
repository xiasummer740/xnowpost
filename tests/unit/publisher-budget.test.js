/**
 * 发布预算逻辑的真实单元测试（直接 import src/publisher/waits.js）
 *
 * 这是 P2-5 的核心：预算耗尽时必须抛「未确认」，而不是继续等、更不是重试。
 * 发布是唯一会产出**线上副作用**的环节，写错就是重复上传。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BUDGET_MS,
  MIN_RETRY_BUDGET_MS,
  BudgetExceededError,
  createDeadline,
  assertBudget,
  envBudgetMs,
} from '../../src/publisher/waits.js';

describe('常量', () => {
  test('默认预算与最小重试预算都是正数且合理', () => {
    assert.equal(DEFAULT_BUDGET_MS, 30 * 60 * 1000);
    assert.equal(MIN_RETRY_BUDGET_MS, 5 * 60 * 1000);
    assert.ok(MIN_RETRY_BUDGET_MS < DEFAULT_BUDGET_MS);
  });
});

describe('createDeadline', () => {
  test('remaining() 随时间单调减少', async () => {
    const d = createDeadline(1000);
    const a = d.remaining();
    await new Promise(r => setTimeout(r, 30));
    const b = d.remaining();
    assert.ok(a > b, `应递减: ${a} → ${b}`);
    assert.ok(b > 0);
  });

  test('非法 budget 回退到默认值而不是变成 NaN/负数', () => {
    for (const bad of [undefined, null, NaN, 0, -5, 'abc']) {
      const d = createDeadline(bad);
      assert.ok(Number.isFinite(d.remaining()) && d.remaining() > 0, `budget=${bad} 时 remaining=${d.remaining()}`);
    }
  });

  test('elapsed() 与 remaining() 之和约为预算', async () => {
    const budget = 2000;
    const d = createDeadline(budget);
    await new Promise(r => setTimeout(r, 20));
    const sum = d.elapsed() + d.remaining();
    assert.ok(Math.abs(sum - budget) < 60, `elapsed+remaining=${sum} 应≈${budget}`);
  });
});

describe('assertBudget', () => {
  test('预算充足时不抛错', () => {
    const d = createDeadline(10_000);
    assert.doesNotThrow(() => assertBudget(d, '上传'));
  });

  test('预算耗尽时抛 BudgetExceededError', () => {
    const d = createDeadline(1);          // 1ms
    const until = Date.now() + 20;
    while (Date.now() < until) { /* 等它耗尽 */ }
    assert.throws(() => assertBudget(d, '等待审核'), BudgetExceededError);
  });

  test('posted=true 时错误消息明确「未确认」，提示不要重试', () => {
    const d = createDeadline(1);
    const until = Date.now() + 20;
    while (Date.now() < until) { /* 耗尽 */ }
    try {
      assertBudget(d, '审核', { posted: true });
      assert.fail('应当抛错');
    } catch (e) {
      assert.ok(e instanceof BudgetExceededError);
      assert.equal(e.posted, true);
      // 关键语义：已经点过发布按钮 → 绝不能重试（会重复上传）
      assert.match(e.message, /未确认/);
    }
  });

  test('posted=false 时错误对象标记未发布', () => {
    const d = createDeadline(1);
    const until = Date.now() + 20;
    while (Date.now() < until) { /* 耗尽 */ }
    try {
      assertBudget(d, '上传');
      assert.fail('应当抛错');
    } catch (e) {
      assert.ok(e instanceof BudgetExceededError);
      assert.equal(e.posted, false);
      assert.equal(e.confirmed, false);
    }
  });

  test('错误里带上阶段名，便于定位卡在哪一步', () => {
    const d = createDeadline(1);
    const until = Date.now() + 20;
    while (Date.now() < until) { /* 耗尽 */ }
    try {
      assertBudget(d, '上传视频文件');
      assert.fail('应当抛错');
    } catch (e) {
      assert.match(e.message, /上传视频文件/);
    }
  });
});

describe('envBudgetMs', () => {
  const KEY = 'XNOWPOST_PUBLISH_BUDGET_MS';
  const ORIGINAL = process.env[KEY];

  test('未设置时返回默认预算', () => {
    delete process.env[KEY];
    assert.equal(envBudgetMs(), DEFAULT_BUDGET_MS);
  });

  test('设置合法值时采纳', () => {
    process.env[KEY] = '600000';
    assert.equal(envBudgetMs(), 600000);
    process.env[KEY] = ORIGINAL;
  });

  test('非法值回退默认，不返回 NaN', () => {
    for (const bad of ['abc', '0', '-1', '']) {
      process.env[KEY] = bad;
      const v = envBudgetMs();
      assert.ok(Number.isFinite(v) && v > 0, `取值 ${bad} → ${v}`);
    }
    if (ORIGINAL === undefined) delete process.env[KEY];
    else process.env[KEY] = ORIGINAL;
  });
});
