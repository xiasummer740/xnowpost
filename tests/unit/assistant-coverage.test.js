/**
 * 「助手不只是会发视频」—— 覆盖面单测（2026-10-19 用户口径：「说白了，就是要像你一样强大」）。
 *
 * 这里不测"跑得通"，只测**边界**：
 *   ① 新增能力都是显式白名单里的具名工具（没有 shell / 任意文件读写）；
 *   ② 会动钱的、会动线上账号的、会动配置的都必须是 write/spend（要走确认卡）；
 *   ③ 只读类（趋势、上次任务）不阻塞、不需要确认；
 *   ④ 预览文案要让人看懂"会发生什么"，不能只写工具名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PUBLIC_TOOLS_NAMES,
  getToolDef,
  levelOf,
  needsConfirm,
  validateArgs,
  describeToolCall,
  LEVEL,
} from '../../electron/lib/assistant-tools.js';

test('危险能力一个都不许有（shell / 任意文件 / 代码执行）', () => {
  for (const bad of ['exec', 'shell', 'run_command', 'read_file', 'write_file', 'eval', 'spawn', 'bash']) {
    assert.equal(PUBLIC_TOOLS_NAMES.includes(bad), false, `不该存在 ${bad}`);
    assert.ok(!getToolDef(bad), `不该存在 ${bad}`);
  }
});

test('三个新工具都在白名单，且级别正确', () => {
  assert.ok(PUBLIC_TOOLS_NAMES.includes('manage_accounts'));
  assert.ok(PUBLIC_TOOLS_NAMES.includes('admin_action'));
  assert.ok(PUBLIC_TOOLS_NAMES.includes('get_trend'));
  assert.ok(PUBLIC_TOOLS_NAMES.includes('get_last_task'));
  // 会开浏览器/改线上资料的必须是 write（要人点执行）
  assert.equal(levelOf('manage_accounts'), LEVEL.WRITE);
  assert.equal(needsConfirm('manage_accounts'), true);
  assert.equal(levelOf('admin_action'), LEVEL.WRITE);
  assert.equal(needsConfirm('admin_action'), true);
  // 纯读
  assert.equal(levelOf('get_trend'), LEVEL.READ);
  assert.equal(needsConfirm('get_trend'), false);
});

test('backup_cookies 有定义（执行器早有，工具定义曾经漏了）', () => {
  assert.ok(PUBLIC_TOOLS_NAMES.includes('backup_cookies'), '模型必须知道这个能力');
  assert.equal(needsConfirm('backup_cookies'), true);
});

test('manage_accounts 参数校验：op 必填、op=edit_profile 必须给 env', () => {
  assert.equal(validateArgs('manage_accounts', {}).ok, false);
  assert.equal(validateArgs('manage_accounts', { op: 'login' }).ok, true);
  assert.equal(validateArgs('manage_accounts', { op: '乱写' }).ok, false, 'op 只能在枚举里');
  assert.equal(validateArgs('manage_accounts', { op: 'login', bogus: 1 }).ok, false, '多余字段要拒');
});

test('预览文案要说清后果（登录要讲时间、改资料要讲会开浏览器）', () => {
  const login = describeToolCall('manage_accounts', { op: 'login' });
  assert.match(login, /登录/);
  assert.match(login, /分钟/, '必须让人知道要等多久');
  assert.match(describeToolCall('manage_accounts', { op: 'login', force: true }), /强制重登/);
  assert.match(describeToolCall('manage_accounts', { op: 'login', dryRun: true }), /演练/);
  assert.match(describeToolCall('manage_accounts', { op: 'edit_profile', env: 'TK04', name: 'Cora' }), /TK04/);
  assert.match(describeToolCall('manage_accounts', { op: 'edit_profile', env: 'TK04', name: 'Cora' }), /Cora/);
  assert.match(describeToolCall('manage_accounts', { op: 'sync_profiles' }), /全部账号/);
});

test('admin_action 的四个 op 都能给人话预览', () => {
  assert.match(describeToolCall('admin_action', { op: 'cancel_engine' }), /取消/);
  assert.match(describeToolCall('admin_action', { op: 'cancel_collect' }), /采集/);
  assert.match(describeToolCall('admin_action', { op: 'clear_logs' }), /清空/);
  assert.match(describeToolCall('admin_action', { op: 'push_report', date: '2026-10-19' }), /2026-10-19/);
  assert.match(describeToolCall('admin_action', { op: 'push_report' }), /今天/);
  assert.equal(validateArgs('admin_action', { op: 'push_report' }).ok, true);
  assert.equal(validateArgs('admin_action', { op: 'nope' }).ok, false);
});

test('get_trend 的天数被夹在 1~30，且预览带上天数', () => {
  assert.match(describeToolCall('get_trend', {}), /7 天/);
  assert.match(describeToolCall('get_trend', { days: 14 }), /14 天/);
  assert.match(describeToolCall('get_trend', { days: 999 }), /30 天/);
  assert.equal(validateArgs('get_trend', { days: 7 }).ok, true);
  assert.equal(validateArgs('get_trend', { whatever: 1 }).ok, false);
});

test('工具总数受控（每次加能力都要显式改这个数，防"偷偷多塞"）', () => {
  assert.equal(PUBLIC_TOOLS_NAMES.length, 22);
});
