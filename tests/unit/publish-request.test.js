/**
 * 首页「发布」= 发到哪个账号（2026-10-19 发错号事故的界面侧护栏）。
 *
 * 事故：用户让助手「TK02 也发一条」，界面/助手都只能发 accounts[0] → 发到了 TK01，撤不回来。
 * 这里钉住两件事：
 *   ① 选了账号，`publish:run` 的 opts 里必须带 `account`；没选才不带（主进程按配置第一个）；
 *   ② 确认卡上的目标文案和真正发出去的目标**同源**（都用 publishTargetLabel）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPublishOpts, buildPickKeys, describePublishPlan, publishTargetLabel, publishTargetOptions } from '../../src/renderer/lib/publish-request.js';

const ACCOUNTS = [
  { name: '01', browserEnv: 'TK01' },
  { name: '02', bitEnvId: 'TK02' },
  { name: '03', browserEnv: 'TK03' },
];

test('选了 02 → opts 带 account: "02"', () => {
  assert.deepEqual(buildPublishOpts({ target: '02' }), { account: '02' });
});

test('没选账号 → 不带 account（主进程按配置第一个，并且会记录"默认账号"）', () => {
  assert.deepEqual(buildPublishOpts({ target: '' }), {});
  assert.deepEqual(buildPublishOpts(), {});
  assert.deepEqual(buildPublishOpts({ target: '   ' }), {});
});

test('含旧会话只在勾选时带，且不影响 account', () => {
  assert.deepEqual(buildPublishOpts({ target: '02', includeOld: true }), { account: '02', includeOld: true });
  assert.deepEqual(buildPublishOpts({ target: '02', includeOld: false }), { account: '02' });
});

test('确认卡文案：选了号就点名到环境，没选就说"默认账号（01）"', () => {
  assert.equal(publishTargetLabel(ACCOUNTS, '02'), '账号 02（TK02）');
  assert.equal(publishTargetLabel(ACCOUNTS, '03'), '账号 03（TK03）');
  assert.equal(publishTargetLabel(ACCOUNTS, ''), '默认账号（01）');
});

test('配置里没有的号：照实说「账号 09」，不许假装绑了环境', () => {
  assert.equal(publishTargetLabel(ACCOUNTS, '09'), '账号 09');
  assert.equal(publishTargetLabel([{ name: '04' }], '04'), '账号 04（未绑定环境）');
});

test('空配置不抛异常', () => {
  assert.equal(publishTargetLabel([], ''), '默认账号');
  assert.equal(publishTargetLabel(null, '02'), '账号 02');
  assert.deepEqual(publishTargetOptions(null), { defaultLabel: '默认账号', options: [] });
});

test('下拉选项：顺序跟配置一致，带 env 供界面显示', () => {
  const r = publishTargetOptions(ACCOUNTS);
  assert.equal(r.defaultLabel, '默认账号（01）');
  assert.deepEqual(r.options.map((o) => `${o.name}:${o.env}`), ['01:TK01', '02:TK02', '03:TK03']);
});

// ── 选择性发布（2026-10-19 用户问「不能选择性发布吗，非要发 3 条或者随机？」）──
const ROWS = [
  { date: '2026-10-19', session: 'pm_1911', title: '甲' },
  { date: '2026-10-19', session: 'am_0830', title: '乙' },
  { date: '2026-10-18', session: 'pm_2014', title: '丙' },
];

test('勾选 → pick 里是 date/session，顺序按勾选先后', () => {
  assert.deepEqual(buildPickKeys(ROWS), ['2026-10-19/pm_1911', '2026-10-19/am_0830', '2026-10-18/pm_2014']);
});

test('重复勾选去重、空行/坏行丢掉，不抛异常', () => {
  assert.deepEqual(buildPickKeys([ROWS[0], ROWS[0]]), ['2026-10-19/pm_1911']);
  assert.deepEqual(buildPickKeys([{ session: 'am_0830' }]), ['am_0830']);
  assert.deepEqual(buildPickKeys([{ date: 'x' }, null, undefined]), []);
  assert.deepEqual(buildPickKeys(null), []);
});

test('计划：勾了就只发勾选的（条数下拉失效）', () => {
  const p = describePublishPlan({ pick: [ROWS[0]], count: 3, total: 5 });
  assert.equal(p.mode, 'pick');
  assert.equal(p.count, 1);
  assert.match(p.detail, /只发勾选的 1 条/);
});

test('计划：没勾按条数；条数非法时回落 3 条', () => {
  assert.equal(describePublishPlan({ count: 1 }).count, 1);
  assert.equal(describePublishPlan({ count: 2 }).count, 2);
  assert.equal(describePublishPlan({ count: 0 }).count, 3);
  assert.equal(describePublishPlan({ count: 'x' }).count, 3);
  assert.equal(describePublishPlan({}).count, 3);
});

test('计划：全部 = 当天全部条数（不是 999 硬编码）', () => {
  const p = describePublishPlan({ count: 'all', total: 4 });
  assert.equal(p.mode, 'all');
  assert.match(p.detail, /全部 4 条/);
});
test('界面上传的是下拉选项（{name, env}）时，确认卡也要显示 TK02 而不是「未绑定环境」', () => {
  // 2026-10-19 真 bug：publishTargetLabel 只读 browserEnv/bitEnvId，
  // 而界面传的是 publishTargetOptions 产出的 {name, env} → 卡片写「账号 02（未绑定环境）」
  const opts = publishTargetOptions(ACCOUNTS).options;
  assert.equal(publishTargetLabel(opts, '02'), '账号 02（TK02）');
  assert.equal(publishTargetLabel(opts, '01'), '账号 01（TK01）');
});
// ── 「本轮实际发几条」（2026-10-19 首页按钮统一文案时加） ────────────────
// 按钮上写的条数必须等于真正会发出去的条数：以前「发 1 条」在当天 0 条待发时
// 点下去什么都不发，用户白等一场。
test('plan.send：当天 0 条待发时，"发 1 条" 实际是 0 条', () => {
  const p = describePublishPlan({ count: 1, total: 0, eligible: 0 });
  assert.equal(p.send, 0);
  assert.equal(p.count, 1);
});

test('plan.send：勾了「含旧会话」时按 eligible 算，不按当天数', () => {
  assert.equal(describePublishPlan({ count: 1, total: 0, eligible: 28 }).send, 1);
  assert.equal(describePublishPlan({ count: 3, total: 2, eligible: 28 }).send, 3);
  assert.equal(describePublishPlan({ count: 'all', total: 0, eligible: 28 }).send, 28);
  assert.equal(describePublishPlan({ count: 'all', total: 28 }).send, 28);
});

test('plan.send：候选不够时按候选数（不多报）', () => {
  assert.equal(describePublishPlan({ count: 3, total: 2 }).send, 2);
  assert.equal(describePublishPlan({ count: 3, total: 2, eligible: 2 }).send, 2);
});

test('plan.send：勾选的条目不受 eligible 限制（显式点名就算数）', () => {
  const picks = [ROWS[0], ROWS[1]];
  const p = describePublishPlan({ pick: picks, count: 1, total: 0, eligible: 0 });
  assert.equal(p.mode, 'pick');
  assert.equal(p.send, 2);
});