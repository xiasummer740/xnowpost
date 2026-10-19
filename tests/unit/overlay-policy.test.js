/**
 * 浮层策略判定单测（page-sense 的按钮签名兜底 + 计数签名）
 *
 * 守的真实事故（2026-10-19 09:05，当天 10 轮里 3 轮）：
 *   点完草稿的「Discard」后，TikTok 弹「Discard this post?」（Not now / Discard），
 *   但 TUXModal 的标题块没进浮层集合，只剩按钮块「Not now Discard」；
 *   同时屏上挂着「Preview your video on your phone → Got it」，
 *   整页文本拼起来只有 "got it" → 被判成「通用确认」→ 对着被遮罩挡住的位置
 *   盲点 4 次、白等 28 秒。现在靠**按钮组合**先认出「放弃作品确认」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { policyFromButtons, overlaySignature } from '../../src/publisher/page-sense.js';

const ov = (text, labels) => ({ text, buttons: labels.map((label) => ({ label })) });

test('标题块没进浮层集合时，靠按钮组合认出「放弃作品确认」', () => {
  const overlays = [
    ov('Preview your video on your phone Now you can view your video as it will appear on TikTok. Got it', ['Got it']),
    ov('Not now Discard', ['Not now', 'Discard']),
  ];
  const policy = policyFromButtons(overlays);
  assert.ok(policy, '必须认出来');
  assert.equal(policy.id, 'discard');
  assert.ok(policy.click.includes('Not now'), '点 Not now 取消放弃');
  assert.ok(!policy.click.map((c) => c.toLowerCase()).includes('discard'), 'Discard 永远不在点击列表里');
});

test('自动内容检查（Cancel + Turn on）不会被误判成放弃作品确认', () => {
  assert.equal(policyFromButtons([ov('Turn on automatic content checks?', ['Cancel', 'Turn on'])]), null);
});

test('AI 标注引导（Not now + Turn on）不会被误判成放弃作品确认', () => {
  assert.equal(policyFromButtons([ov('Labeling AI-generated content', ['Not now', 'Turn on'])]), null);
});

test('只有 Got it 的手机预览浮层认不出放弃作品确认', () => {
  assert.equal(policyFromButtons([ov('Preview your video on your phone', ['Got it'])]), null);
  assert.equal(policyFromButtons([]), null);
  assert.equal(policyFromButtons(null), null);
});

test('计数签名按「策略 + 按钮」区分，不按策略名一刀切', () => {
  const discard = overlaySignature({ id: 'discard' }, [{ label: 'Not now' }, { label: 'Discard' }]);
  const confirm = overlaySignature({ id: 'confirm' }, [{ label: 'Got it' }]);
  assert.notEqual(discard, confirm, '不同框必须各有各的计数');

  // 同一个框（DOM 顺序 / 大小写不同）签名要一致，否则 4 次上限形同虚设
  const same = overlaySignature({ id: 'discard' }, [{ label: 'Discard' }, { label: 'NOT NOW' }]);
  assert.equal(discard, same);
});
