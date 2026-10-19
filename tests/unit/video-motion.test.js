/**
 * 运镜 / 转场时间轴的单元测试（直接 import src/engine/video.js）
 *
 * 这里最容易出致命错误：xfade 会吃掉重叠时间。
 * 如果时间轴算错，成片会比配音短（最后一句被截掉）或长（结尾黑屏），
 * 而这种错误只靠看画面很难发现。所以用不变式把它钉死：
 *     总时长 == 配音总时长
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  clipLengths,
  transitionOffsets,
  xfadeName,
  motionFilterFor,
  FPS,
  MOTION_AMPLITUDE,
} from '../../src/engine/video.js';

const sum = (a) => a.reduce((x, y) => x + y, 0);
const EPS = 1e-6;

describe('clipLengths / transitionOffsets —— 时间轴不变式', () => {
  const cases = [
    { d: [5, 5, 5], T: 0.5 },
    { d: [3.5, 3.55, 3.48], T: 0.5 },
    { d: [4, 4, 4, 4, 4, 4, 4, 4, 4], T: 0.5 },
    { d: [6, 6], T: 0.5 },
    { d: [5], T: 0.5 },
    { d: [5, 5, 5], T: 0 },
  ];

  test('转场重叠后，成片总长仍精确等于配音总长', () => {
    for (const { d, T } of cases) {
      const lengths = clipLengths(d, T);
      const offsets = transitionOffsets(lengths, T);
      const videoTotal = sum(lengths) - offsets.length * T;
      assert.ok(
        Math.abs(videoTotal - sum(d)) < 0.01,
        `d=[${d}] T=${T}: 成片 ${videoTotal} 应等于配音 ${sum(d)}`
      );
    }
  });

  test('除最后一段外，每段都多留了一个转场时长', () => {
    const d = [5, 5, 5];
    const T = 0.5;
    assert.deepEqual(clipLengths(d, T), [5.5, 5.5, 5]);
  });

  test('T=0（硬切）时片长不变、offset 等于累积和', () => {
    assert.deepEqual(clipLengths([5, 5, 5], 0), [5, 5, 5]);
    assert.deepEqual(transitionOffsets([5, 5, 5], 0), [5, 10]);
  });

  test('offset 单调递增且都不为负', () => {
    const lengths = clipLengths([5, 5, 5, 5], 0.5);
    const offsets = transitionOffsets(lengths, 0.5);
    assert.equal(offsets.length, 3);
    for (let i = 1; i < offsets.length; i++) {
      assert.ok(offsets[i] > offsets[i - 1], `offset 应递增: ${offsets}`);
    }
    assert.ok(offsets.every(o => o >= 0), `offset 不应为负: ${offsets}`);
  });

  test('单镜没有转场 offset（否则 xfade 会失败）', () => {
    assert.deepEqual(transitionOffsets(clipLengths([5], 0.5), 0.5), []);
  });

  test('脏输入不会产生 NaN', () => {
    for (const bad of [undefined, null, NaN, -1, 0, 'abc']) {
      const lengths = clipLengths([bad, 5, 5], 0.5);
      assert.ok(lengths.every(v => Number.isFinite(v) && v > 0), `bad=${bad} → ${lengths}`);
      const offsets = transitionOffsets(lengths, 0.5);
      assert.ok(offsets.every(Number.isFinite), `bad=${bad} → offsets ${offsets}`);
    }
  });

  test('转场时长非法时按 0 处理（不会出现负 offset）', () => {
    const lengths = clipLengths([5, 5], NaN);
    assert.deepEqual(lengths, [5, 5]);
    assert.deepEqual(transitionOffsets(lengths, NaN), [5]);
  });
});

describe('xfadeName —— 模型字段映射到 FFmpeg 转场', () => {
  test('五种语义都有映射', () => {
    assert.equal(xfadeName('cut'), 'fade');
    assert.equal(xfadeName('fade'), 'fade');
    assert.equal(xfadeName('zoom'), 'zoomin');
    assert.equal(xfadeName('slide'), 'slideleft');
    assert.equal(xfadeName('dissolve'), 'dissolve');
  });

  test('大小写/空格无关', () => {
    assert.equal(xfadeName('  ZOOM '), 'zoomin');
    assert.equal(xfadeName('Fade'), 'fade');
  });

  test('未知或缺失时回退 fade，绝不返回 undefined', () => {
    for (const bad of [undefined, null, '', 'wobble', 123]) {
      const v = xfadeName(bad);
      assert.equal(typeof v, 'string');
      assert.ok(v.length > 0, `bad=${bad} → ${v}`);
    }
  });
});

describe('motionFilterFor —— 每种运镜都要产出可用滤镜', () => {
  const opts = { width: 1080, height: 1920, clipSec: 5 };

  test('所有 camera_move 都返回非空且含尺寸归一化', () => {
    for (const m of ['push', 'pull', 'pan', 'tilt_up', 'tilt_down', 'static']) {
      const f = motionFilterFor(m, opts);
      assert.ok(typeof f === 'string' && f.length > 0, `${m} 为空`);
      assert.match(f, /scale=1080:1920/, `${m} 缺少归一化尺寸`);
    }
  });

  test('static 不产生运动（用 null 滤镜占位）', () => {
    assert.match(motionFilterFor('static', opts), /,null$/);
  });

  test('推/拉用逐帧缩放，平移用 crop 位移', () => {
    assert.match(motionFilterFor('push', opts), /eval=frame/);
    assert.match(motionFilterFor('pull', opts), /eval=frame/);
    assert.match(motionFilterFor('pan', opts), /crop=1080:1920:x='/);
    assert.match(motionFilterFor('tilt_down', opts), /crop=1080:1920:x='\(iw-1080\)\/2':y='/);
  });

  test('运镜幅度不超过 15%（否则会把画面边缘的文字切掉）', () => {
    assert.ok(MOTION_AMPLITUDE > 0 && MOTION_AMPLITUDE <= 0.15, `幅度 ${MOTION_AMPLITUDE}`);
  });

  test('未知运镜回退到推镜头，不会返回垃圾字符串', () => {
    const f = motionFilterFor('barrel_roll', opts);
    assert.match(f, /eval=frame/);
  });

  test('时长非法时不产生 NaN', () => {
    for (const bad of [undefined, null, NaN, 0, -3]) {
      const f = motionFilterFor('push', { ...opts, clipSec: bad });
      assert.ok(!f.includes('NaN'), `clipSec=${bad} → ${f}`);
    }
  });

  test('帧率是正整数', () => {
    assert.ok(Number.isInteger(FPS) && FPS > 0);
  });
});
