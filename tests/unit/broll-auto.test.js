/**
 * 素材库自动生长（v1.6.52）的单测。
 *
 * 守的是「无人看着也不能让垃圾进库」这条：
 * 亮度/清晰度/时长/重复 四道闸，任何一道不过都必须拒。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeCandidate, hamming, GATES, AUTO_PLAN } from '../../src/broll-auto.js';

const GOOD = { durationSec: 8, height: 1920, bytes: 6 * 1024 * 1024, luma: 90, sharp: 300, hash: 'a1b2c3d4e5f60718' };

test('judgeCandidate：合格片段放行', () => {
  const r = judgeCandidate({ ...GOOD });
  assert.equal(r.ok, true, r.reasons.join(';'));
  assert.deepEqual(r.reasons, []);
});

test('judgeCandidate：太短的拒（切不出 2.4~3.6 秒的镜头）', () => {
  const r = judgeCandidate({ ...GOOD, durationSec: 2.5 });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(';'), /时长/);
});

test('judgeCandidate：太黑/太白的拒（手机上等于黑屏）', () => {
  assert.equal(judgeCandidate({ ...GOOD, luma: 12 }).ok, false);
  assert.equal(judgeCandidate({ ...GOOD, luma: 250 }).ok, false);
  // 暗调科技感素材（亮度 35）应当放行 —— 实测人挑的库里就有 21~37 的
  assert.equal(judgeCandidate({ ...GOOD, luma: 35 }).ok, true);
});

test('judgeCandidate：虚焦的拒', () => {
  const r = judgeCandidate({ ...GOOD, sharp: 40 });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(';'), /清晰度/);
});

test('judgeCandidate：分辨率/体积太小拒（放大就糊）', () => {
  assert.equal(judgeCandidate({ ...GOOD, height: 480 }).ok, false);
  assert.equal(judgeCandidate({ ...GOOD, bytes: 200 * 1024 }).ok, false);
});

test('judgeCandidate：多个问题一次全报（不藏第二条）', () => {
  const r = judgeCandidate({ durationSec: 1, height: 360, bytes: 1000, luma: 5, sharp: 3, hash: null });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.length >= 5, `应报多条，实际 ${r.reasons.length}`);
});

test('hamming：同一个哈希距离 0，差 1 位距离 1，长度不符返回 99', () => {
  assert.equal(hamming('abcdef', 'abcdef'), 0);
  assert.equal(hamming('abcdef', 'abcdee'), 1);
  assert.equal(hamming('abc', 'abcd'), 99);
  assert.equal(hamming(null, 'abc'), 99);
});

test('去重阈值：距离 < 6 视为重复（同一段素材的不同截取）', () => {
  const a = '0f0f0f0f0f0f0f0f';
  const b = '0f0f0f0f0f0f0f0e'; // 差 1 位
  assert.ok(hamming(a, b) < GATES.dedupeDistance, '近似副本必须被判重复');
  const far = 'ffffffffffffffff';
  assert.ok(hamming(a, far) >= GATES.dedupeDistance, '不同画面不能被误杀');
});

test('题材表每个标签都有检索词，且检索词不超过 3 个词（实测 4 个词以上 Pexels 返回 0 条）', () => {
  for (const [tag, queries] of Object.entries(AUTO_PLAN)) {
    assert.ok(queries.length > 0, `${tag} 没有检索词`);
    for (const q of queries) {
      assert.ok(q.split(/\s+/).length <= 3, `「${q}」超过 3 个词，命中率会掉到 0`);
    }
  }
  // 覆盖视频最常用的几个题材
  for (const need of ['editing', 'phone', 'data', 'server', 'clock', 'desk']) {
    assert.ok(AUTO_PLAN[need], `题材表缺少 ${need}`);
  }
});

test('阈值本身是合理的（防止有人把闸门调成摆设）', () => {
  assert.ok(GATES.minSharpness >= 60, '清晰度阈值太低等于不过滤');
  assert.ok(GATES.lumaMin >= 25 && GATES.lumaMax <= 240);
  assert.ok(GATES.minDurationSec >= 3);
  assert.ok(GATES.maxLibraryBytes >= 300 * 1024 * 1024 && GATES.maxLibraryBytes <= 2 * 1024 * 1024 * 1024);
});

test('数据目录只认 XNOWPOST_DATA_DIR（不能退回启动时的工作目录）', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('fs-extra');
  const tmp = path.join(os.tmpdir(), `xnp-store-${Date.now()}`);
  const prev = process.env.XNOWPOST_DATA_DIR;
  try {
    process.env.XNOWPOST_DATA_DIR = tmp;
    const { libraryPath } = await import('../../src/broll-store.js');
    assert.equal(path.resolve(libraryPath().dir), path.resolve(tmp, 'assets', 'broll-library'));
  } finally {
    if (prev === undefined) delete process.env.XNOWPOST_DATA_DIR; else process.env.XNOWPOST_DATA_DIR = prev;
    await fs.remove(tmp);
  }
});

test('新数据目录会自动播种人挑的那批素材；索引坏了返回空数组（绝不抛）', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = (await import('fs-extra')).default;
  const tmp = path.join(os.tmpdir(), `xnp-store-bad-${Date.now()}`);
  const prev = process.env.XNOWPOST_DATA_DIR;
  try {
    process.env.XNOWPOST_DATA_DIR = tmp;
    const { loadClips } = await import('../../src/broll-store.js');
    // 首次运行：数据目录里没有库 → 从打包进来的 seeds 复制一份
    // （不能是空库，否则安装版第一次出片就没有本地素材可用）
    const seeded = loadClips();
    assert.ok(seeded.length >= 10, `应播种人挑的素材，实际 ${seeded.length} 段`);
    // 索引坏掉 → 返回空数组，引擎退回 Pexels，不许抛异常
    fs.writeFileSync(path.join(tmp, 'assets', 'broll-library', 'library.json'), '{ 坏 JSON');
    assert.deepEqual(loadClips(), []);
  } finally {
    if (prev === undefined) delete process.env.XNOWPOST_DATA_DIR; else process.env.XNOWPOST_DATA_DIR = prev;
    await fs.remove(tmp);
  }
});