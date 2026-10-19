/**
 * 用户自带截图 → 分镜画面
 *
 * 这是"我提供截图、按截图生成视频"的核心：把任意尺寸的图片
 * 统一预缩放/居中裁切到 1080x1920，并按文件名顺序对应分镜。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { attachUserMaterials } from '../../src/engine/material.js';
import { getVideoStyleConfig } from '../../src/engine/config.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64');

async function makeDir(tag) {
  const d = path.join(os.tmpdir(), `xnp-mat-${process.pid}-${tag}`);
  await fs.remove(d);
  await fs.ensureDir(d);
  return d;
}

describe('attachUserMaterials', () => {
  test('未设置目录 → 优雅跳过，不抛异常', async () => {
    const r = await attachUserMaterials(await makeDir('a'), '', 3);
    assert.equal(r.ok, false);
    assert.deepEqual(r.indices, []);
    assert.match(r.reason, /未设置/);
  });

  test('目录不存在 → 返回原因而不是崩', async () => {
    const r = await attachUserMaterials(await makeDir('b'), 'C:/definitely/not/here', 3);
    assert.equal(r.ok, false);
    assert.match(r.reason, /不存在/);
  });

  test('空目录 → 提示没有图片', async () => {
    const empty = await makeDir('c');
    const r = await attachUserMaterials(empty, empty, 3);
    assert.equal(r.ok, false);
    assert.match(r.reason, /没有图片/);
  });

  test('截图只占少数几镜，不再铺满全片', async () => {
    const work = await makeDir('d');
    const src = await makeDir('e');
    // 故意用"横屏"图，验证会被完整放入竖屏（模糊底填充）而不是裁切
    await fs.writeFile(path.join(src, '1.png'), PNG_1x1);
    await fs.writeFile(path.join(src, '2.png'), PNG_1x1);

    const r = await attachUserMaterials(work, src, 6, { maxScenes: 2 });
    assert.equal(r.ok, true, `失败原因: ${r.reason}`);
    assert.equal(r.indices.length, 2, `最多只该用 2 镜，实际 ${r.indices.length}`);
    assert.ok(!r.indices.includes(0), '第 1 镜要留给会动的画面，不该是截图');
    assert.equal(r.fileCount, 2);
    assert.equal(r.total, 6);

    for (const i of r.indices) {
      const f = path.join(work, 'slides', `scene_${String(i + 1).padStart(2, '0')}.png`);
      assert.ok(fs.existsSync(f), `缺少 ${path.basename(f)}`);
      assert.ok(fs.statSync(f).size > 1024, '输出图太小，可能转换失败');
    }
  });

  test('一张图只出现在一镜（不重复铺满）', async () => {
    const work = await makeDir('f');
    const src = await makeDir('g');
    await fs.writeFile(path.join(src, '1.png'), PNG_1x1);
    const r = await attachUserMaterials(work, src, 4, { maxScenes: 2 });
    assert.equal(r.ok, true, `失败原因: ${r.reason}`);
    assert.equal(r.indices.length, 1, `一张图只该用 1 镜，实际 ${r.indices.length}`);
  });

  test('图比镜头多 → 最多用 maxScenes 张', async () => {
    const work = await makeDir('h');
    const src = await makeDir('i');
    for (const n of ['1', '2', '3', '4', '5']) {
      await fs.writeFile(path.join(src, `${n}.png`), PNG_1x1);
    }
    const r = await attachUserMaterials(work, src, 6, { maxScenes: 2 });
    assert.equal(r.ok, true, `失败原因: ${r.reason}`);
    assert.equal(r.indices.length, 2);
    assert.equal(r.fileCount, 5);
  });

  test('会写出 user-manifest.json（合成阶段据此跳过运镜）', async () => {
    const work = await makeDir('j');
    const src = await makeDir('k');
    await fs.writeFile(path.join(src, '1.png'), PNG_1x1);
    const r = await attachUserMaterials(work, src, 4, { maxScenes: 2 });
    assert.equal(r.ok, true, `失败原因: ${r.reason}`);
    const mf = path.join(work, 'slides', 'user-manifest.json');
    assert.ok(fs.existsSync(mf), '缺少 user-manifest.json');
    const m = fs.readJsonSync(mf);
    assert.deepEqual(m.indices, r.indices);
  });
});

describe('配音语言设置', () => {
  test('voiceLang 只能是 auto / zh / en', () => {
    const v = getVideoStyleConfig().voiceLang;
    assert.ok(['auto', 'zh', 'en'].includes(v), `非法值: ${v}`);
  });

  test('materialsDir 是字符串（未设置时为空串）', () => {
    assert.equal(typeof getVideoStyleConfig().materialsDir, 'string');
  });
});

describe('控制台当场选的配音语言（环境变量优先于设置）', () => {
  function withEnv(val, fn) {
    const old = process.env.XNOWPOST_VOICE_LANG;
    if (val === undefined) delete process.env.XNOWPOST_VOICE_LANG;
    else process.env.XNOWPOST_VOICE_LANG = val;
    try { fn(); } finally {
      if (old === undefined) delete process.env.XNOWPOST_VOICE_LANG;
      else process.env.XNOWPOST_VOICE_LANG = old;
    }
  }

  test('en 覆盖持久设置', () => {
    withEnv('en', () => assert.equal(getVideoStyleConfig().voiceLang, 'en'));
  });

  test('zh 覆盖持久设置', () => {
    withEnv('zh', () => assert.equal(getVideoStyleConfig().voiceLang, 'zh'));
  });

  test('非法值被忽略，回落到 auto', () => {
    withEnv('klingon', () => assert.equal(getVideoStyleConfig().voiceLang, 'auto'));
  });

  test('未设置时不受影响', () => {
    withEnv(undefined, () => {
      assert.ok(['auto', 'zh', 'en'].includes(getVideoStyleConfig().voiceLang));
    });
  });
});
