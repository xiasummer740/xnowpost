/**
 * 「测试连接」的错误文案 —— 单测。
 * 对应 2026-10-19 的真实误判：Premature close（传输中途断开）被当成 Key 坏了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { describeAiError } from '../../electron/lib/ai-error.js';

const D = (err, opts) => describeAiError(err, { provider: 'DeepSeek', ...(opts || {}) });

test('传输中途断开要明确说「不是 Key 的问题」', () => {
  const msg = D(new Error('Invalid response body while trying to fetch https://api.deepseek.com/chat/completions: Premature close'));
  assert.ok(msg.includes('传输中途断开'), msg);
  assert.ok(msg.includes('不是 Key 的问题'), msg);
  assert.ok(msg.includes('DeepSeek'), msg);
});

test('401/403 才是 Key 无效（和断连分开）', () => {
  const e = new Error('Unauthorized');
  e.status = 401;
  const msg = D(e);
  assert.ok(msg.includes('Key 无效'), msg);
  assert.ok(msg.includes('HTTP 401'), msg);
  assert.ok(!msg.includes('传输中途断开'), msg);
});

test('402 余额不足 / 429 限流 / 5xx 服务端，各有独立说辞', () => {
  const mk = (status) => Object.assign(new Error('x'), { status });
  assert.ok(D(mk(402)).includes('余额不足'));
  assert.ok(D(mk(429)).includes('限流'));
  const five = D(mk(503));
  assert.ok(five.includes('服务端错误') && five.includes('不是你的配置问题'), five);
});

test('超时 / DNS 分开报，不混成"未知错误"', () => {
  assert.ok(D(new Error('Request timed out.')).includes('超时'));
  assert.ok(D(new Error('getaddrinfo ENOTFOUND api.deepseek.com')).includes('DNS'));
  const e = new Error('aborted');
  e.name = 'APIConnectionTimeoutError';
  assert.ok(D(e).includes('超时'), D(e));
});

test('400 + 提到模型 → 提示检查模型名', () => {
  const e = Object.assign(new Error('Model Not Exist'), { status: 400 });
  const msg = D(e);
  assert.ok(msg.includes('模型名不被接受'), msg);
});

test('耗时与重试次数写进文案（排查靠它）', () => {
  const e = new Error('socket hang up');
  const msg = D(e, { elapsedMs: 12345, attempts: 2 });
  assert.ok(msg.includes('12.3s'), msg);
  assert.ok(msg.includes('已重试 1 次'), msg);
});

test('空错误也要给出可读结果，不抛异常', () => {
  assert.ok(D(null).includes('未知错误'));
  assert.ok(D(undefined).startsWith('DeepSeek ❌'));
  assert.equal(typeof D('随便一个字符串'), 'string');
});

test('未知错误保留原文并截断（不能无限长）', () => {
  const long = 'y'.repeat(500);
  const msg = D(new Error(long));
  assert.ok(msg.length < 220, `长度 ${msg.length}`);
  assert.ok(msg.includes('yyy'));
});

test('provider 名字会带进文案（硅基流动/DeepSeek 都走这一份）', () => {
  const msg = describeAiError(new Error('Premature close'), { provider: '硅基流动' });
  assert.ok(msg.startsWith('硅基流动 ❌'), msg);
});
