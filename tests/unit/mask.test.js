import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { maskPromoCodes } from '../../src/engine/mask.js';
import { getContentPolicy } from '../../src/engine/config.js';

let TMP;
before(async () => {
  TMP = path.join(os.tmpdir(), `xnp-mask-${Date.now()}`);
  await fs.ensureDir(TMP);
});
after(async () => {
  await fs.remove(TMP).catch(() => {});
});

describe('优惠码打码', () => {
  test('默认开启自动打码', () => {
    assert.equal(getContentPolicy().maskPromoCode, true);
  });

  test('空列表直接返回，不报错', async () => {
    const r = await maskPromoCodes([], { apiKey: 'x', outDir: TMP });
    assert.deepEqual(r.paths, []);
    assert.equal(r.maskedCount, 0);
  });

  test('没有 API Key 时原样返回（不联网、不破坏画面）', async () => {
    const f = path.join(TMP, 'k.png');
    await fs.writeFile(f, Buffer.from('not-a-real-png'));
    const r = await maskPromoCodes([f], { apiKey: '', outDir: TMP });
    assert.deepEqual(r.paths, [f]);
    assert.equal(r.maskedCount, 0);
  });

  test('不存在的文件被过滤掉', async () => {
    const f = path.join(TMP, 'real.png');
    await fs.writeFile(f, Buffer.from('x'));
    const r = await maskPromoCodes([f, path.join(TMP, 'nope.png')], { apiKey: '', outDir: TMP });
    assert.deepEqual(r.paths, [f]);
  });
});
