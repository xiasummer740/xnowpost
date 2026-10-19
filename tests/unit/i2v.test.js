/**
 * 图生视频（Wan2.2 I2V）+ 成片观感配置
 *
 * 这里只测纯逻辑（不发起真实请求）：
 *  - data URI 编码必须带正确的 MIME（接口收 data:image/png;base64,...）
 *  - heroI2V 默认必须是关闭的 —— 它是唯一会额外花钱的开关，
 *    绝不能因为"默认开"让用户在不知情的情况下付费
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { toDataUri, I2V_MODEL, I2V_SIZE, generateHeroClip } from '../../src/engine/i2v.js';
import { getVideoStyleConfig, getEngineConfig } from '../../src/engine/config.js';

describe('i2v 接口常量', () => {
  test('模型名与厂商路径一致', () => {
    assert.equal(I2V_MODEL, 'Wan-AI/Wan2.2-I2V-A14B');
  });

  test('尺寸必须是接口支持的竖屏档（最大 720x1280）', () => {
    assert.equal(I2V_SIZE, '720x1280');
    const allowed = ['1280x720', '720x1280', '960x960'];
    assert.ok(allowed.includes(I2V_SIZE), `接口不支持该尺寸: ${I2V_SIZE}`);
  });
});

describe('toDataUri', () => {
  test('png 产出 data:image/png;base64,', async () => {
    const p = path.join(os.tmpdir(), `xnp-i2v-${process.pid}.png`);
    // 1x1 透明 PNG
    await fs.writeFile(p, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'));
    try {
      const uri = toDataUri(p);
      assert.match(uri, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
      assert.ok(uri.length > 100, 'base64 内容太短');
    } finally {
      await fs.remove(p);
    }
  });

  test('jpg 产出 image/jpeg（接口按 MIME 解析，写错会失败）', async () => {
    const p = path.join(os.tmpdir(), `xnp-i2v-${process.pid}.jpg`);
    await fs.writeFile(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    try {
      assert.match(toDataUri(p), /^data:image\/jpeg;base64,/);
    } finally {
      await fs.remove(p);
    }
  });
});

describe('generateHeroClip 的失败必须可回退', () => {
  test('没有 Key 时返回 ok:false 而不是抛异常', async () => {
    const r = await generateHeroClip({
      imagePath: 'whatever.png', prompt: 'x', outPath: 'out.mp4', apiKey: '',
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /Key/);
  });

  test('首帧图片不存在时也不抛异常', async () => {
    const r = await generateHeroClip({
      imagePath: 'C:/definitely-not-here/none.png', prompt: 'x', outPath: 'out.mp4', apiKey: 'fake',
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /首帧图片不存在/);
  });
});

describe('heroI2V 默认关闭（防止静默付费）', () => {
  test('默认 heroI2V === false', () => {
    assert.equal(getVideoStyleConfig().heroI2V, false);
  });

  test('heroScenes 默认 1，且落在 1..3', () => {
    const n = getVideoStyleConfig().heroScenes;
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 3, `heroScenes 异常: ${n}`);
  });

  test('观感配置字段齐全', () => {
    const s = getVideoStyleConfig();
    for (const k of ['motion', 'transitionSec', 'bgmVolume', 'fadeIn', 'fadeOut', 'heroI2V', 'heroScenes']) {
      assert.ok(k in s, `缺少字段 ${k}`);
    }
  });

  test('引擎配置里 video 仍保留分镜数等核心字段（没被覆盖掉）', () => {
    const v = getEngineConfig().video;
    assert.ok(typeof v.scenes === 'number');
    assert.ok(typeof v.minDuration === 'number');
  });
});
