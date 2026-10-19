/**
 * 助手「发我点名的那一条」—— 选择器解析（2026-10-19 用户要求"把同样的能力给助手"）。
 *
 * 背景：界面能勾选具体条目了，但助手只会「发 N 条」（按队列顺序抓前 N 条）。
 * 用户说「发《为什么同样的100粉…》那条」时，旧实现会发队列第一条 —— 发的不是他要的。
 *
 * 口径：
 *   ① 序号 / 会话键 / 会话名 / 标题片段 四种说法都认；
 *   ② **匹配不上、或匹配到多条，就报错**，绝不退回"那就发第一条"；
 *   ③ 发多条时按队列顺序（新→旧），和界面一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { describeToolCall, resolvePublishSelectors } from '../../electron/lib/assistant-tools.js';

const QUEUE = [
  { date: '2026-10-18', session: 'pm_2014', time: '20:14', title: '副业新思路：把增长方案变成你的生意', old: true },
  { date: '2026-10-18', session: 'pm_1722', time: '17:22', title: '为什么同样的100粉，有人能接品牌合作？', old: true },
  { date: '2026-10-19', session: 'am_0830', time: '08:30', title: '副业新思路：不囤货不发货，用这个赚差价' },
  { date: '2026-10-19', session: 'am_0840', time: '08:40', title: '副业新思路：不露脸不囤货，月入五位数' },
];

test('序号：2 / 第2条 / #2 都解析到队列第 2 条', () => {
  for (const sel of ['2', '第2条', '#2']) {
    const r = resolvePublishSelectors([sel], QUEUE);
    assert.equal(r.ok, true, sel);
    assert.deepEqual(r.keys, ['2026-10-18/pm_1722']);
    assert.equal(r.matched[0].n, 2);
  }
});

test('会话键 / 会话名 / 标题片段都认', () => {
  assert.deepEqual(resolvePublishSelectors(['2026-10-19/am_0830'], QUEUE).keys, ['2026-10-19/am_0830']);
  assert.deepEqual(resolvePublishSelectors(['pm_1722'], QUEUE).keys, ['2026-10-18/pm_1722']);
  assert.deepEqual(resolvePublishSelectors(['不露脸'], QUEUE).keys, ['2026-10-19/am_0840']);
});

test('序号越界 → 报错并给出候选，不偷偷发第一条', () => {
  const r = resolvePublishSelectors(['9'], QUEUE);
  assert.equal(r.ok, false);
  assert.match(r.error, /没有第 9 条/);
  assert.match(r.error, /一共 4 条/);
  assert.equal(r.keys.length, 0);
  assert.equal(r.candidates.length, 4);
});

test('找不到 / 匹配多条 → 都报错（多条时列出候选）', () => {
  const miss = resolvePublishSelectors(['这条不存在的标题'], QUEUE);
  assert.equal(miss.ok, false);
  assert.match(miss.error, /找不到/);

  const amb = resolvePublishSelectors(['副业新思路'], QUEUE);   // 命中 3 条
  assert.equal(amb.ok, false);
  assert.match(amb.error, /匹配到 3 条/);
  assert.equal(amb.candidates.length, 3);
  assert.deepEqual(amb.candidates.map((c) => c.n), [1, 3, 4]);
});

test('多条按队列顺序（新→旧）发，不按用户列举顺序', () => {
  const r = resolvePublishSelectors(['am_0840', 'pm_2014'], QUEUE);
  assert.equal(r.ok, true);
  assert.deepEqual(r.keys, ['2026-10-18/pm_2014', '2026-10-19/am_0840']);
});

test('同一句里给了两次 → 去重', () => {
  const r = resolvePublishSelectors(['2', '第2条'], QUEUE);
  assert.deepEqual(r.keys, ['2026-10-18/pm_1722']);
});

test('旧会话可以点名（旧会话标记照实带出，不拦）', () => {
  const r = resolvePublishSelectors(['pm_2014'], QUEUE);
  assert.equal(r.ok, true);
  assert.equal(r.matched[0].old, true);
});

test('空输入 / 空队列 / 坏数据都不抛异常', () => {
  assert.equal(resolvePublishSelectors([], QUEUE).ok, false);
  assert.equal(resolvePublishSelectors('', QUEUE).ok, false);
  assert.equal(resolvePublishSelectors(['1'], []).ok, false);
  assert.match(resolvePublishSelectors(['1'], []).error, /没有可发的内容/);
  assert.equal(resolvePublishSelectors(null, null).ok, false);
  assert.equal(resolvePublishSelectors(['2'], [null, {}]).ok, false);
});

test('确认卡上写清"到底哪几条"（第几条 + 标题 + 会话键），不显示裸序号', () => {
  const txt = describeToolCall('run_publish', { pick: ['2'], account: '02' }, { pendingQueue: QUEUE });
  assert.match(txt, /只发点名的 1 条/);
  assert.match(txt, /第2条《为什么同样的100粉，有人能接品牌合作？》/);
  assert.match(txt, /2026-10-18\/pm_1722/);
  assert.match(txt, /发到账号 02/);
});

test('确认卡上解析不了就明说，不留一个看不懂的序号', () => {
  const txt = describeToolCall('run_publish', { pick: ['9'] }, { pendingQueue: QUEUE });
  assert.match(txt, /没对上待发队列/);
  assert.match(txt, /没有第 9 条/);
});

test('没队列（比如界面预览拿不到数据）也不报错，只显示原话', () => {
  const txt = describeToolCall('run_publish', { pick: ['第2条'] }, {});
  assert.match(txt, /只发点名的 1 条（第2条）/);
});