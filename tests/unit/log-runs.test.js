import test from 'node:test';
import assert from 'node:assert/strict';
import { groupLogRuns, filterRuns, formatDuration } from '../../src/renderer/lib/log-runs.js';

const L = (time, type, message, source = 'scheduler') => ({ time, key: time, type, message, source });

const SAMPLE = [
  L('2026-10-19 08:00:00', 'info', '[Scheduler] ready (11 tasks)'),
  L('2026-10-19 08:30:00', 'info', '🔐 TK01 已登录（4 个 session cookie）'),
  L('2026-10-19 08:30:00', 'info', '🚀 仅视频 任务开始（超时预算 1800s）'),
  L('2026-10-19 08:31:00', 'info', '📅 C:\\Users\\x\\output\\2026-10-19\\am_0830 | 模式: video'),
  L('2026-10-19 08:31:10', 'info', '💰 DeepSeek: 2464+658 tokens ≈ ¥0.0038'),
  L('2026-10-19 08:32:00', 'warning', '⚠️ TG 未配置，跳过视频推送'),
  L('2026-10-19 08:32:30', 'info', '🌐 打开指纹环境 TK01'),
  L('2026-10-19 08:32:31', 'info', '📤 自动发布到账号: 01'),
  L('2026-10-19 08:32:37', 'success', '✅ 审查完成，视频已公开 (约24秒)'),
  L('2026-10-19 08:32:37', 'success', '✅ 仅视频 完成'),
  L('2026-10-19 08:35:00', 'info', '🚀 仅视频 任务开始（超时预算 1800s）'),
  L('2026-10-19 08:36:00', 'info', '📅 C:\\x\\am_0835 | 模式: video'),
  L('2026-10-19 08:37:00', 'error', '❌ 仅视频 失败：Locator.click: Timeout 30000ms exceeded'),
  L('2026-10-19 10:00:00', 'info', '🚀 数据采集 + 日报 任务开始（超时预算 900s）'),
  L('2026-10-19 10:02:43', 'success', '✅ 数据采集 + 日报 完成'),
];

test('按 🚀 任务开始切轮：3 轮 + 1 个启动组', () => {
  const runs = groupLogRuns(SAMPLE);
  assert.equal(runs.length, 4);
  assert.equal(runs[0].pre, true, '第一轮之前的启动/配置行要单独一组');
  assert.deepEqual(runs.slice(1).map((r) => r.title), ['仅视频', '仅视频', '数据采集 + 日报']);
});

test('一轮的摘要：结果、耗时、账号、环境、花费、发布数', () => {
  const run = groupLogRuns(SAMPLE)[1];
  assert.equal(run.result, 'success');
  assert.equal(run.startTime, '2026-10-19 08:30:00');
  assert.equal(run.endTime, '2026-10-19 08:32:37', '取轮内最后一行的时间');
  assert.equal(run.durationText, '2 分 37 秒');
  assert.deepEqual(run.accounts, ['01']);
  assert.deepEqual(run.envs, ['TK01']);
  assert.equal(run.published, 1);
  assert.equal(run.cost, 0.0038);
  assert.equal(run.session, 'C:\\Users\\x\\output\\2026-10-19\\am_0830');
  assert.equal(run.warnings.length, 1);
});

test('失败的一轮要能一眼看出原因', () => {
  const run = groupLogRuns(SAMPLE)[2];
  assert.equal(run.result, 'error');
  assert.match(run.failReason, /Locator\.click: Timeout 30000ms exceeded/);
});

test('轮次边界：下一轮的 🔐 预检行会落在上一轮末尾，但不会改变上一轮结果', () => {
  const runs = groupLogRuns([
    L('2026-10-19 08:30:00', 'info', '🚀 仅视频 任务开始'),
    L('2026-10-19 08:32:37', 'success', '✅ 仅视频 完成'),
    L('2026-10-19 08:35:00', 'info', '🔐 TK02 已登录（4 个 session cookie）'),
    L('2026-10-19 08:35:00', 'info', '🚀 仅视频 任务开始'),
    L('2026-10-19 08:37:00', 'error', '❌ 仅视频 失败：超时'),
  ]);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].result, 'success');
  assert.equal(runs[1].result, 'error');
});

test('耗时取「明确的收尾行」，不被下一轮的预检行拖长', () => {
  const runs = groupLogRuns([
    L('2026-10-19 09:15:00', 'info', '🚀 仅视频 任务开始（超时预算 1800s）'),
    L('2026-10-19 09:17:43', 'success', '✅ 仅视频 完成'),
    L('2026-10-19 09:17:43', 'info', '🔐 TK01 已登录（4 个 session cookie）'),
    L('2026-10-19 10:00:00', 'info', '🔐 TK02 已登录（4 个 session cookie）'),
    L('2026-10-19 10:00:00', 'info', '🚀 数据采集 + 日报 任务开始（超时预算 900s）'),
  ]);
  assert.equal(runs[0].durationText, '2 分 43 秒');
  assert.equal(runs[0].endTime, '2026-10-19 09:17:43');
});

test('环境只认「真的打开了哪个」，不能把 10 个号的登录预检都算进来', () => {
  const runs = groupLogRuns([
    L('2026-10-19 08:30:00', 'info', '🚀 仅视频 任务开始'),
    L('2026-10-19 08:30:01', 'info', '🔐 TK01 已登录（4 个 session cookie）'),
    L('2026-10-19 08:30:02', 'info', '🔐 TK02 已登录（4 个 session cookie）'),
    L('2026-10-19 08:32:00', 'info', '🌐 打开指纹环境 TK01'),
    L('2026-10-19 08:32:37', 'success', '✅ 仅视频 完成'),
  ]);
  assert.deepEqual(runs[0].envs, ['TK01']);
});
test('没有 🚀 的日志（比如采集器单独跑）全部归到启动组，不丢行', () => {
  const runs = groupLogRuns([L('2026-10-19 09:00:00', 'info', '普通一行')]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].pre, true);
  assert.equal(runs[0].count, 1);
});

test('筛选：按类型过滤后只留还有匹配行的轮次，并给出匹配数', () => {
  const runs = groupLogRuns(SAMPLE);
  const onlyErr = filterRuns(runs, { type: 'error' });
  assert.equal(onlyErr.length, 1);
  assert.equal(onlyErr[0].result, 'error');
  assert.equal(onlyErr[0].matched, 1);
  assert.equal(filterRuns(runs, { type: 'success' }).length >= 2, true);
});

test('formatDuration：秒/分/时 三档', () => {
  assert.equal(formatDuration(45 * 1000), '45 秒');
  assert.equal(formatDuration(120 * 1000), '2 分');
  assert.equal(formatDuration(157 * 1000), '2 分 37 秒');
  assert.equal(formatDuration(3.5 * 3600 * 1000), '3 小时 30 分');
  assert.equal(formatDuration(NaN), '');
});
