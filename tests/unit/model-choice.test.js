/**
 * 模型选择的两个关键判断 —— 单测。
 *
 * 背景（2026-10-19 用户问「模型是最新的吗」）：
 *  · DeepSeek 把老别名 `deepseek-chat` **静默路由**到 `deepseek-flash`，旗舰是 `deepseek-v4-pro`；
 *  · v4-pro 是推理模型：实测 2257 completion tokens 里 1930 花在思考上，
 *    max_tokens 给小了正文就是空的（120 / 3000 都返回空，8000 才有正文）。
 * 所以「是不是推理模型」「这个模型有没有确认单价」必须能判对。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isReasoningModel, REASONING_MIN_MAX_TOKENS } from '../../src/engine/config.js';
import { priceForModel } from '../../src/engine/cost.js';

test('旗舰 v4-pro 是推理模型（正文前要花一大截 token 思考）', () => {
  assert.equal(isReasoningModel('deepseek-v4-pro'), true);
  assert.equal(isReasoningModel('deepseek-reasoner'), true);
  assert.equal(isReasoningModel('deepseek-r1'), true);
});

test('flash / chat 不是推理模型（免得白加 max_tokens 花钱）', () => {
  assert.equal(isReasoningModel('deepseek-flash'), false);
  assert.equal(isReasoningModel('deepseek-chat'), false);
  assert.equal(isReasoningModel(''), false);
  assert.equal(isReasoningModel(null), false);
  // 不能把 "pro" 当成子串就命中（避免 profile / promote 这类误判）
  assert.equal(isReasoningModel('deepseek-promote'), false);
});

test('推理模型的建议上限够大（实测思考一次 1930 token）', () => {
  assert.ok(REASONING_MIN_MAX_TOKENS >= 8000);
});

test('只有 deepseek-chat 的单价是"确认过"的，其余标记为估算', () => {
  const known = priceForModel('deepseek-chat');
  assert.equal(known.exact, true);
  assert.ok(known.price.input > 0 && known.price.output > 0);

  for (const m of ['deepseek-flash', 'deepseek-v4-pro', 'unknown-model']) {
    const p = priceForModel(m);
    assert.equal(p.exact, false, `${m} 不应声称单价精确`);
    // 估算也要给正数：算成 0 = 谎称免费
    assert.ok(p.price.input > 0 && p.price.output > 0, m);
    assert.equal(p.model, m);
  }
});

test('空模型名不炸，回退到默认口径', () => {
  const p = priceForModel('');
  assert.equal(p.model, 'deepseek-chat');
  assert.equal(p.exact, true);
});
