/**
 * 内容结构校验 + 英文位兜底的回归测试。
 *
 * 事故背景（2026-10-29 09:20 那轮）：模型返回的 JSON 少了 title_en，
 * 而结构校验只在生成循环**外**跑 → 直接 throw → 整条视频白废：
 * 没生成、没发布，一个号当天断更。
 * 现在的口径：
 *  1. 缺字段先带着"缺什么"重问（在循环里）；
 *  2. 最后一次还缺，就用中文兜底填英文位（并且日志里明说），保住这一轮；
 *  3. 兜底之后仍然不合法（比如 scenes 不是数组、缺 image_desc）→ 照旧报错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fillMissingBilingual, validateVideoContent } from '../../src/engine/text.js';

const scene = (zh, en, extra = {}) => ({
  scene_text_zh: zh,
  scene_text_en: en,
  image_desc: '画面描述',
  duration: 3,
  ...extra,
});

function goodVideo() {
  return {
    title_zh: '三十天不掉线的养号方案',
    title_en: 'A 30-day account plan that never drops',
    scenes: [scene('第一条就把数字放在最前面', 'Put the number first'), scene('第二条讲稳定性', 'Then stability')],
  };
}

test('结构完整的内容：兜底函数一个字都不改', () => {
  const c = goodVideo();
  const before = JSON.stringify(c);
  assert.deepEqual(fillMissingBilingual(c), []);
  assert.equal(JSON.stringify(c), before);
  assert.equal(validateVideoContent(c).valid, true);
});

test('缺 title_en：用中文兜底，并报告补了哪个字段', () => {
  const c = goodVideo();
  delete c.title_en;
  assert.equal(validateVideoContent(c).valid, false, '前提：缺 title_en 时校验必须不通过');

  const filled = fillMissingBilingual(c);
  assert.deepEqual(filled, ['title_en']);
  assert.equal(c.title_en, c.title_zh);
  assert.equal(validateVideoContent(c).valid, true, '兜底后这一轮要能继续跑');
});

test('缺分镜英文：逐镜兜底，字段名带序号（日志要看得懂是哪一镜）', () => {
  const c = goodVideo();
  delete c.scenes[1].scene_text_en;

  const filled = fillMissingBilingual(c);
  assert.deepEqual(filled, ['分镜2 scene_text_en']);
  assert.equal(c.scenes[1].scene_text_en, c.scenes[1].scene_text_zh);
  assert.equal(validateVideoContent(c).valid, true);
});

test('只有空白字符串也算缺（" " 不能顶替英文）', () => {
  const c = goodVideo();
  c.title_en = '   ';
  c.scenes[0].scene_text_en = '\n';
  const filled = fillMissingBilingual(c);
  assert.deepEqual(filled.sort(), ['title_en', '分镜1 scene_text_en'].sort());
});

test('中文也没有 → 不编造，交给校验报错', () => {
  const c = goodVideo();
  delete c.title_en;
  delete c.title_zh;
  const filled = fillMissingBilingual(c);
  assert.deepEqual(filled, []);
  assert.equal(validateVideoContent(c).valid, false);
});

test('scenes 不是数组这种结构问题，兜底救不了 → 仍然不通过', () => {
  const c = goodVideo();
  delete c.title_en;
  c.scenes = { 0: scene('a', 'b') };
  fillMissingBilingual(c);
  assert.equal(validateVideoContent(c).valid, false);
});

test('坏数据（null / 字符串）不许把兜底函数弄崩', () => {
  assert.deepEqual(fillMissingBilingual(null), []);
  assert.deepEqual(fillMissingBilingual('abc'), []);
  assert.deepEqual(fillMissingBilingual({ scenes: [null, 3] }), []);
});
