/**
 * 「确认公开」的判据：必须是**这一条**作品，而不是整页出现过「所有人」。
 * 守着 2026-10-29 审查发现（账号有历史作品时，整页判定会在 ~0 秒假成功）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { titleKey, visibilityOf, pickOwnBlock, verdictOf } from '../../src/publisher/publish-verify.js';

test('titleKey：去掉 #标签/emoji/标点，取可识别片段', () => {
  // 标题开头那段最有辨识度（真实 文案.txt 第一行就是纯标题，不带 #）
  assert.equal(titleKey('安全上网 3 个设置，让你的账号不被盯上 🔒'), '安全上网');
  // 标签不参与定位（#安全上网 会被当成标签整段丢掉，只剩后面的正文）
  assert.equal(titleKey('#安全上网 3 个设置，让你的账号不被盯上'), '让你的账号不被盯上');
  assert.match(titleKey('Stop sharing your location right now'), /Stop|sharing|location|right/);
  assert.equal(titleKey('短标题'), '', '太短的标题不能用来定位（会撞）');
  assert.equal(titleKey(''), '');
  assert.equal(titleKey('#onlytags'), '', '只有标签时没有可用片段');
});

test('titleKey：单段过长时截断到 20 字', () => {
  const long = '这是一个非常非常长的中文标题用来测试截断逻辑是否正常工作不要超过二十个字符';
  assert.ok(titleKey(long).length <= 20);
});

test('visibilityOf：三种可见性都认得，中英都要', () => {
  assert.equal(visibilityOf('可见范围：所有人'), 'public');
  assert.equal(visibilityOf('Everyone can view this video'), 'public');
  assert.equal(visibilityOf('仅自己可见'), 'private');
  assert.equal(visibilityOf('Only me'), 'private');
  assert.equal(visibilityOf('内容审查中'), 'reviewing');
  assert.equal(visibilityOf('Under review'), 'reviewing');
  assert.equal(visibilityOf('随便一段没人认识的文字'), null);
});

test('reviewing 优先于 public：审查中同时出现「所有人」时不能判公开', () => {
  assert.equal(visibilityOf('内容审查中 · 所有人可见'), 'reviewing');
});

test('pickOwnBlock：只认包含自己标题的那一块', () => {
  const blocks = [
    '旧作品 A\n所有人\n2026-10-20',
    '安全上网 3 个设置\n仅自己\n2026-10-29',
    '旧作品 B\n所有人\n2026-10-25',
  ];
  const pick = pickOwnBlock(blocks, '安全上网');
  assert.equal(pick.found, true);
  assert.equal(pick.index, 1);
  assert.equal(pick.state, 'private', '新作品还是「仅自己」时不能因为别处有「所有人」就算公开');
  assert.equal(verdictOf(pick), 'private');
});

test('pickOwnBlock：自己的作品变成所有人 → public', () => {
  const blocks = ['别人的 所有人', '安全上网 3 个设置  所有人'];
  assert.equal(verdictOf(pickOwnBlock(blocks, '安全上网')), 'public');
});

test('pickOwnBlock：页面上全是老作品 → not-found（不能凑成功）', () => {
  const blocks = ['旧作品 A\n所有人', '旧作品 B\n所有人'];
  const pick = pickOwnBlock(blocks, '安全上网');
  assert.equal(pick.found, false);
  assert.equal(verdictOf(pick), 'not-found');
});

test('pickOwnBlock：找到了但读不到可见性 → unknown（继续等，不算成功）', () => {
  const pick = pickOwnBlock(['安全上网 3 个设置\n刚刚'], '安全上网');
  assert.equal(pick.found, true);
  assert.equal(pick.state, null);
  assert.equal(verdictOf(pick), 'unknown');
});

test('pickOwnBlock：key 为空时永不误判', () => {
  assert.equal(verdictOf(pickOwnBlock(['随便什么 所有人'], '')), 'not-found');
});

test('pickOwnBlock：坏输入不抛异常', () => {
  assert.doesNotThrow(() => pickOwnBlock(null, 'x'));
  assert.doesNotThrow(() => pickOwnBlock(['a', null, 3], 'a'));
});
