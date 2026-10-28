/**
 * 「抓到了」≠「资料是好的」—— 判定口径的单测（v1.6.56）。
 *
 * 2026-10-20 23:36 实测 TK07：昵称被平台退回成用户名、简介为空，
 * 抓取脚本照样打 ✅，看日志的人会以为 10 个号都正常。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeProfileCompleteness, isNavigationInterrupted } from '../../src/profile-quality.js';

test('完整资料不报问题', () => {
  const r = judgeProfileCompleteness({
    username: 'xnow.matrix',
    nickname: 'XNOW·涨粉与起号',
    bio: '自助涨粉网址👇 xnow.taikon.top',
    avatarUrl: 'https://x/a.jpg',
    avatarSha: 'abc123',
  });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test('昵称退回用户名 + 简介空 → 两条都报（TK07 的真实情况）', () => {
  const r = judgeProfileCompleteness({
    username: 'kiransfkunu', nickname: 'kiransfkunu', bio: '', avatarUrl: 'https://x/a.jpg', avatarSha: 'abc',
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes('昵称退回了用户名'));
  assert.ok(r.problems.includes('简介为空'));
});

test('昵称为空 / 头像没拿到也要报', () => {
  const r = judgeProfileCompleteness({ username: 'a', nickname: '', bio: '有简介', avatarUrl: '', avatarSha: '' });
  assert.ok(r.problems.includes('昵称为空'));
  assert.ok(r.problems.includes('头像没拿到'));
});

test('大小写不同但内容相同，仍算昵称退回用户名', () => {
  const r = judgeProfileCompleteness({ username: 'XNow', nickname: 'xnow', bio: 'b', avatarUrl: 'u', avatarSha: 's' });
  assert.ok(r.problems.includes('昵称退回了用户名'));
});

test('空对象不抛，四类问题全报', () => {
  const r = judgeProfileCompleteness({});
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 3, `实际：${r.problems.join('/')}`);
});

test('页面自己跳转打断导航 → 判为可容忍（TikTok 会去掉 ?_r=）', () => {
  const err = new Error('Page.goto: Navigation to "https://www.tiktok.com/@kiransfkunu?lang=en&_r=1792561005941" is interrupted by another navigation to "https://www.tiktok.com/@kiransfkunu"');
  assert.equal(isNavigationInterrupted(err), true);
});

test('其它导航错误不能被容忍（真打不开要报错）', () => {
  assert.equal(isNavigationInterrupted(new Error('net::ERR_NAME_NOT_RESOLVED')), false);
  assert.equal(isNavigationInterrupted(new Error('Timeout 30000ms exceeded')), false);
  assert.equal(isNavigationInterrupted(null), false);
});