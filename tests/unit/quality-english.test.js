/**
 * 英文位必须是真英文：模型漏 title_en / scene_text_en 时 text.js 会拿中文兜底，
 * 那时视频会带着中文"英文台词"发出去（英文观众看不懂），而日志只有一行 🩹。
 * 守着 2026-10-29 审查发现 #8：缺一道"英文占比"检查。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { latinRatio, looksEnglish } from '../../src/quality.js';

test('latinRatio：纯中文 0、纯英文 1、中英混排按字母算', () => {
  assert.equal(latinRatio('全中文的台词'), 0);
  assert.equal(latinRatio('This is English'), 1);
  assert.equal(latinRatio(''), 0);
  assert.equal(latinRatio(null), 0);
  const mixed = latinRatio('安全 Secure 上网 browsing');
  assert.ok(mixed > 0.3 && mixed < 0.9, `混排比例应在中间，实际 ${mixed}`);
});

test('latinRatio：数字和标点不拉高比例', () => {
  // "1.2 万播放" 全是数字+中文 → 0
  assert.equal(latinRatio('1.2 万播放'), 0);
});

test('looksEnglish：中文兜底要能识别出来', () => {
  assert.equal(looksEnglish('3 个技巧让你的视频起飞'), false, '这是中文兜底，不能当英文');
  assert.equal(looksEnglish('3 tricks to break 200 views'), true);
  assert.equal(looksEnglish(''), false);
  assert.equal(looksEnglish('123 456'), false, '只有数字不算英文');
});

test('looksEnglish：带品牌词的英文仍算英文', () => {
  assert.equal(looksEnglish('Use XNOW PRO to grow fast'), true);
});
