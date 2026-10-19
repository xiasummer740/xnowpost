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

import { buildPublishOpts, publishTargetLabel, publishTargetOptions } from '../../src/renderer/lib/publish-request.js';

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
