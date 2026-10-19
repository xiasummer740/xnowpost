import test from 'node:test';
import assert from 'node:assert/strict';
import { cutoffDate, pickOldDateDirs, isCleanable } from '../../src/output-retention.js';

test('15 天前的分界线算得对（今天 10-19 → 10-04 之前的才清）', () => {
  assert.equal(cutoffDate({ today: '2026-10-19', days: 15 }), '2026-10-04');
  assert.equal(cutoffDate({ today: '2026-03-01', days: 15 }), '2026-02-14', '跨月要对');
  assert.equal(cutoffDate({ today: '', days: 15 }), '');
  assert.equal(cutoffDate({ today: '2026-10-19', days: 0 }), '', '0 天 = 不清理');
  assert.equal(cutoffDate({ today: '2026-10-19', days: -3 }), '');
});

test('只挑日期目录，且严格早于分界线（边界当天保留）', () => {
  const out = pickOldDateDirs(
    ['2026-06-18', '2026-10-03', '2026-10-04', '2026-10-19', 'login-shots', 'collect-1048.json'],
    { today: '2026-10-19', days: 15 }
  );
  assert.deepEqual(out, ['2026-06-18', '2026-10-03']);
});

test('中间件和调试产物要清，交付物一个都不许动', () => {
  // 该清
  assert.equal(isCleanable('expanded_debug.html'), true);
  assert.equal(isCleanable('am_0830/expanded_debug.html'), true);
  assert.equal(isCleanable('am_0830\\expanded_debug.html'), true, '反斜杠路径也要认');
  assert.equal(isCleanable('_video/voice_zh.mp3'), true);
  assert.equal(isCleanable('am_0830/_video/scene_01.mp4'), true);

  // 绝不许动
  for (const keep of [
    'video.mp4', '封面.png', '文案.txt', '描述.txt', '.published', 'cost.json',
    'browser-trace.json', 'publish.log', 'page-events.log',
    'eye-004612-01-overlay-confirm.png', 'dialog-cleanup-2026-10-19T00-46-51-028Z.png',
    'scene_01.png', 'p1_01.png',
  ]) {
    assert.equal(isCleanable(keep), false, `${keep} 是交付物/证据，不能删`);
  }
});

test('脏输入不炸', () => {
  assert.deepEqual(pickOldDateDirs(null, { today: '2026-10-19' }), []);
  assert.deepEqual(pickOldDateDirs(['2026-06-18'], { today: 'x' }), []);
  assert.equal(isCleanable(''), false);
  assert.equal(isCleanable(undefined), false);
  assert.equal(isCleanable('expanded_debug.html.bak'), false);
});
