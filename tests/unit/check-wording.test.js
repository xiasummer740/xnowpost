/**
 * 「检查通过没通过」的日志口径单测。
 *
 * 真实事故（2026-10-19 22:17，TK04 / pm_2214）：内容检查卡满 90 秒被"超时放行"，
 * 日志先写「⏭️ 检查还在跑…放行」，下一行又写「⏳ 检查已通过，等 3s 后发布」。
 * 用户复盘时以为检查正常通过 —— 这类"日志自己说谎"必须被单测钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseMessage, releaseNote } from '../../src/publisher/check-wording.js';

test('真通过 → 说「检查已通过」，不带秒数噪音', () => {
  const msg = releaseMessage(false, 40);
  assert.equal(msg, '⏳ 检查已通过，等 3s 后发布...');
});

test('超时放行 → 必须说「检查未完成」并写清等了多少秒', () => {
  const msg = releaseMessage(true, 90);
  assert.match(msg, /检查未完成/);
  assert.match(msg, /90s/);
  assert.ok(!/检查已通过/.test(msg), '超时放行绝不能写成"检查已通过"');
});

test('超时放行要额外提醒可能再弹确认框；真通过不提醒', () => {
  assert.match(releaseNote(true), /Continue to post/);
  assert.equal(releaseNote(false), '');
});

test('秒数异常/缺失时退化成 0s，不抛异常', () => {
  assert.match(releaseMessage(true, NaN), /0s/);
  assert.match(releaseMessage(true, undefined), /0s/);
  assert.match(releaseMessage(true, -3), /0s/);
});
