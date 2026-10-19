/**
 * 保存后「头像到底换没换」的复查策略。
 *
 * 背景（2026-10-19 真实事故）：批量换头像 4 个号，抽屉里 3 个报
 * 「⚠️ 头像地址没变（大概率没真正保存）」，实际全都换成功了 ——
 * 因为点完 Save 立刻读主页，TikTok 那边还没刷新。
 * 这些用例守的就是：**延迟 ≠ 失败**，宁可等，也不能把成功说成失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { avatarKey, avatarReallyChanged, avatarReadbackPlan, avatarRetryDelayMs } from '../../src/avatar-verify.js';

const A = 'https://p16-sign.tiktokcdn.com/tos-abc/aaa~tplv-tiktokx-cropcenter:1080:1080.jpeg';
const B = 'https://p16-sign.tiktokcdn.com/tos-abc/bbb~tplv-tiktokx-cropcenter:1080:1080.jpeg';

test('avatarKey 只留路径，签名参数不影响比较', () => {
  assert.equal(avatarKey(`${A}?x-expires=1&x-signature=zz`), A);
  assert.equal(avatarKey(''), '');
  assert.equal(avatarKey(null), '');
});

test('avatarReallyChanged：两侧都有值且路径不同才算变了', () => {
  assert.equal(avatarReallyChanged(A, `${B}?x-signature=1`), true);
  assert.equal(avatarReallyChanged(`${A}?a=1`, `${A}?a=2`), false);  // 只有签名变 = 没变
  assert.equal(avatarReallyChanged('', B), false);                    // 保存前没读到
  assert.equal(avatarReallyChanged(A, ''), false);                    // 复查时没读到
});

test('读到头像变了 → 立刻收工，不再等', () => {
  const p = avatarReadbackPlan({ beforeUrl: A, afterUrl: B, elapsedMs: 3000 });
  assert.deepEqual(p, { done: true, changed: true, reason: 'changed' });
});

test('还没变但时间没到 → 继续复查（这是修掉误报的关键）', () => {
  const p = avatarReadbackPlan({ beforeUrl: A, afterUrl: A, elapsedMs: 7000 });
  assert.equal(p.done, false);
  assert.equal(p.changed, false);
  assert.equal(p.reason, 'pending');
});

test('超时仍没变 → 收工但只算「没确认」，不能算失败', () => {
  const p = avatarReadbackPlan({ beforeUrl: A, afterUrl: A, elapsedMs: 46000, timeoutMs: 45000 });
  assert.equal(p.done, true);
  assert.equal(p.changed, false);
  assert.equal(p.reason, 'timeout');
});

test('默认等 45 秒：44.9 秒还在等，45 秒才放弃', () => {
  assert.equal(avatarReadbackPlan({ beforeUrl: A, afterUrl: A, elapsedMs: 44900 }).done, false);
  assert.equal(avatarReadbackPlan({ beforeUrl: A, afterUrl: A, elapsedMs: 45000 }).done, true);
});

test('复查间隔：前面密、后面稀，且永远大于 0', () => {
  assert.equal(avatarRetryDelayMs(1), 4000);
  assert.equal(avatarRetryDelayMs(3), 4000);
  assert.equal(avatarRetryDelayMs(4), 6000);
  assert.equal(avatarRetryDelayMs(9), 8000);
  assert.ok(avatarRetryDelayMs(0) > 0);
  assert.ok(avatarRetryDelayMs(undefined) > 0);
});

test('按默认节奏最多会复查约 8~10 次（够覆盖 TikTok 的延迟）', () => {
  let elapsed = 0;
  let reads = 1;
  for (; ;) {
    const plan = avatarReadbackPlan({ beforeUrl: A, afterUrl: A, elapsedMs: elapsed });
    if (plan.done) break;
    elapsed += avatarRetryDelayMs(reads);
    reads++;
  }
  assert.ok(reads >= 8, `复查次数 ${reads} 太少`);
  assert.ok(elapsed >= 40000, `总等待 ${elapsed}ms 太短`);
});
