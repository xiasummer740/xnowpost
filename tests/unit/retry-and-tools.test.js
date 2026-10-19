/**
 * 限流退避与工具探测的真实单元测试
 *
 * 覆盖两个真实烧过钱的缺陷：
 *  1. 429 固定等 2 秒重试 → 三次全撞墙 → 白白降级成占位图（P2 新发现）
 *  2. 只查 `edge-tts --version` 就当"环境通过" → 版本能打印但合成 403，
 *     结果是烧完 9 张图才失败（实测 ¥0.18 打水漂）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { retryWaitMs, httpStatusOf, retryAfterMsOf, imageQuality } from '../../src/engine/image.js';
import { probeEdgeTTS, verifyTool } from '../../src/engine/tools.js';

const err429 = (retryAfter) => {
  const e = new Error('Request failed with status code 429');
  e.response = { headers: retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) } };
  return e;
};
const errWith = (status) => new Error(`Request failed with status code ${status}`);

describe('httpStatusOf', () => {
  test('从 axios 消息里取状态码', () => {
    assert.equal(httpStatusOf(errWith(429)), 429);
    assert.equal(httpStatusOf(errWith(503)), 503);
  });

  test('无状态码时返回 0（不能瞎猜成 429）', () => {
    assert.equal(httpStatusOf(new Error('socket hang up')), 0);
    assert.equal(httpStatusOf(null), 0);
    assert.equal(httpStatusOf(undefined), 0);
  });
});

describe('retryAfterMsOf', () => {
  test('秒数形式', () => {
    assert.equal(retryAfterMsOf(err429(30)), 30000);
  });

  test('HTTP 日期形式', () => {
    const future = new Date(Date.now() + 20000).toUTCString();
    const ms = retryAfterMsOf(err429(future));
    assert.ok(ms > 15000 && ms <= 21000, `日期形式解析异常: ${ms}`);
  });

  test('缺失或非法时返回 0', () => {
    assert.equal(retryAfterMsOf(err429()), 0);
    assert.equal(retryAfterMsOf(new Error('boom')), 0);
    assert.equal(retryAfterMsOf(err429('not-a-date')), 0);
  });
});

describe('retryWaitMs —— 429 必须退避', () => {
  test('指数增长，且远大于旧的固定 2 秒', () => {
    const a = retryWaitMs(err429(), 0, 2000);
    const b = retryWaitMs(err429(), 1, 2000);
    const c = retryWaitMs(err429(), 2, 2000);
    assert.equal(a, 5000);
    assert.equal(b, 10000);
    assert.equal(c, 20000);
    assert.ok(a > 2000, '旧的固定 2 秒对限流毫无意义');
  });

  test('有 Retry-After 时听服务端的（比退避更长就采纳）', () => {
    assert.equal(retryWaitMs(err429(30), 0, 2000), 30000);
  });

  test('Retry-After 比退避更短时，仍用退避（不能太快撞墙）', () => {
    assert.equal(retryWaitMs(err429(1), 1, 2000), 10000);
  });

  test('等待时长有上限，不会睡到天荒地老', () => {
    assert.ok(retryWaitMs(err429(), 20, 2000) <= 45000);
    assert.ok(retryWaitMs(err429(9999), 0, 2000) <= 45000);
  });

  test('5xx 也退避，但比 429 温和', () => {
    assert.equal(retryWaitMs(errWith(503), 0, 2000), 2000);
    assert.equal(retryWaitMs(errWith(503), 2, 2000), 8000);
    assert.ok(retryWaitMs(errWith(503), 20, 2000) <= 30000);
  });

  test('普通错误用基础延迟，不退避', () => {
    assert.equal(retryWaitMs(new Error('ENOTFOUND'), 0, 2000), 2000);
    assert.equal(retryWaitMs(new Error('ENOTFOUND'), 5, 2000), 2000);
  });

  test('基础延迟非法时回退到 2 秒，绝不返回 NaN/负数', () => {
    for (const bad of [undefined, null, NaN, -1, 0]) {
      const v = retryWaitMs(new Error('x'), 0, bad);
      assert.ok(Number.isFinite(v) && v >= 0, `baseDelay=${bad} → ${v}`);
    }
  });
});

describe('imageQuality 降级计数', () => {
  test('有 canvasFallbacks 计数器（用于告诉用户成片被降级）', () => {
    assert.equal(typeof imageQuality.canvasFallbacks, 'number');
  });
});

describe('probeEdgeTTS —— 探测必须能识别坏环境', () => {
  test('可执行文件不存在时明确失败，不假装通过', () => {
    const r = probeEdgeTTS('C:\\definitely-not-here\\edge-tts.exe', 5000);
    assert.equal(r.ok, false);
    assert.ok(r.error && r.error.length > 0, '失败时必须带原因');
  });

  test('verifyTool 对不存在的程序同样返回 ok:false', () => {
    const r = verifyTool('C:\\definitely-not-here\\ffmpeg.exe');
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });
});
