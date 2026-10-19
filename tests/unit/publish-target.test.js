/**
 * 「这条发到哪个账号」——单测（2026-10-19 发错号事故的护栏）。
 *
 * 真实事故：用户让助手发 TK02，助手生成 + 发布，最后落在 TK01。
 * 根因是发布链路只认 accounts[0]。这里钉死三件事：
 *   ① 点名账号就必须是那个账号；
 *   ② 点名的账号不存在 → **失败**，不许回落到第一个；
 *   ③ 什么都没指定才用第一个，并且要标记成 explicit=false（界面/日志要说"默认账号"）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePublishTarget, describePublishTarget } from '../../electron/lib/publish-target.js';

const ACCOUNTS = [
  { name: '01', browserEnv: 'TK01' },
  { name: '02', bitEnvId: 'TK02' },
  { name: '03', browserEnv: 'TK03' },
];

test('点名账号「02」→ TK02（不是 01）', () => {
  const t = resolvePublishTarget(ACCOUNTS, { account: '02' });
  assert.equal(t.ok, true);
  assert.equal(t.envId, 'TK02');
  assert.equal(t.name, '02');
  assert.equal(t.explicit, true);
});

test('口头上说「2 号」也要认（自动补零）', () => {
  assert.equal(resolvePublishTarget(ACCOUNTS, { account: '2' }).envId, 'TK02');
  assert.equal(resolvePublishTarget(ACCOUNTS, { account: ' 2 ' }).envId, 'TK02');
});

test('点名环境 TK03 等价于点名账号 03', () => {
  const t = resolvePublishTarget(ACCOUNTS, { env: 'tk03' });
  assert.equal(t.ok, true);
  assert.equal(t.envId, 'TK03');
  assert.equal(t.name, '03');
  assert.equal(t.explicit, true);
});

test('配置里没有这个账号 → 直接失败，绝不回落到第一个', () => {
  const t = resolvePublishTarget(ACCOUNTS, { account: '09' });
  assert.equal(t.ok, false);
  assert.match(t.error, /没有账号 09/);
  assert.match(t.error, /01、02、03/, '报错要列出可选的号，省得用户再问');
  assert.equal(t.envId, undefined, '失败时不能带回任何 envId（否则调用方会照用）');
});

test('点名了不存在的环境 → 失败', () => {
  const t = resolvePublishTarget(ACCOUNTS, { env: 'TK09' });
  assert.equal(t.ok, false);
  assert.match(t.error, /没有环境 TK09/);
});

test('什么都没指定 → 用第一个，并标记 explicit=false', () => {
  const t = resolvePublishTarget(ACCOUNTS, {});
  assert.equal(t.ok, true);
  assert.equal(t.envId, 'TK01');
  assert.equal(t.explicit, false);
});

test('账号存在但没绑环境 → 失败（别默默发到别处）', () => {
  const t = resolvePublishTarget([{ name: '01', browserEnv: 'TK01' }, { name: '04' }], { account: '04' });
  assert.equal(t.ok, false);
  assert.match(t.error, /没绑定指纹环境/);
});

test('空配置 / 空数组不抛异常', () => {
  assert.equal(resolvePublishTarget([], {}).ok, false);
  assert.equal(resolvePublishTarget(null, { account: '01' }).ok, false);
  assert.equal(resolvePublishTarget([], { account: '01' }).error.includes('现有'), true);
});

test('描述文案能分清「指定的」和「默认的」', () => {
  assert.equal(describePublishTarget(resolvePublishTarget(ACCOUNTS, { account: '02' })), '账号 02（TK02）');
  assert.equal(describePublishTarget(resolvePublishTarget(ACCOUNTS, {})), '默认账号 01（TK01）');
  assert.match(describePublishTarget({ ok: false, error: '没这个号' }), /没这个号/);
});
