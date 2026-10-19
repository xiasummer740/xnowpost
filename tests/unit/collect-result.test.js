import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResult, resolveUsername } from '../../src/collector/result.js';
import { looksInsufficient } from '../../src/collector/scrapers/tiktok.js';
import { parseCount } from '../../src/collector/scrapers/tiktok-profile.js';

// 2026-10-19 事故：10 个号全部 `{"stats":null,"username":""}`，
// 却被记成 ✅ 有数据 + 覆盖了「今天已采集」时间戳，analytics.db 当天 0 行。
test('采集器返回 {stats:null} 空壳 → 必须判为无数据（不能把包装对象当数据）', () => {
  const r = normalizeResult({ stats: null, username: '' });
  assert.equal(r.stats, null);
  assert.equal(r.username, '');
});

test('采集器返回 {stats:null, insufficient:true} → 无数据 + 标记数据不足', () => {
  const r = normalizeResult({ stats: null, username: 'ryloclyjdcf', insufficient: true });
  assert.equal(r.stats, null);
  assert.equal(r.username, 'ryloclyjdcf');
  assert.equal(r.insufficient, true);
});

test('正常数据原样保留（含 0 值：0 播放是真话，不能当空数据）', () => {
  const r = normalizeResult({ stats: { views: 0, likes: 0, profile_views: 3 }, username: 'abc' });
  assert.deepEqual(r.stats, { views: 0, likes: 0, profile_views: 3 });
  assert.equal(r.username, 'abc');
  assert.equal(r.insufficient, false);
});

test('直接返回 stats 对象（老采集器的写法）也能认', () => {
  assert.deepEqual(normalizeResult({ views: 47, profile_views: 1 }).stats, { views: 47, profile_views: 1 });
});

test('非数字/空串/NaN 一律剔除，全剔除后判无数据', () => {
  assert.equal(normalizeResult({ stats: { views: '--', likes: '', shares: NaN, reach: null } }).stats, null);
  assert.deepEqual(normalizeResult({ stats: { views: '--', likes: 2 } }).stats, { likes: 2 });
});

test('null / undefined / 字符串 → 无数据，不抛异常', () => {
  for (const v of [null, undefined, '', 0, 'abc']) {
    const r = normalizeResult(v);
    assert.equal(r.stats, null);
    assert.equal(r.username, '');
  }
});

test('用户名兜底：页面抓不到就用 env-accounts.json', () => {
  const env = { TK01: { username: 'ryloclyjdcf' } };
  assert.equal(resolveUsername('', env, [], 'TK01', '01'), 'ryloclyjdcf');
  assert.equal(resolveUsername('@pagero', env, [], 'TK01', '01'), 'pagero', '抓到的优先（去掉 @）');
});

test('用户名兜底：env-accounts 没有就用配置 accounts[].username；都没有返回空串', () => {
  const cfg = [{ name: '01', username: 'from-config' }];
  assert.equal(resolveUsername('', {}, cfg, 'TK99', '01'), 'from-config');
  assert.equal(resolveUsername('', {}, cfg, 'TK99', '09'), '');
});

test('识别「--」占位（数据不足），别报成页面结构变了', () => {
  const placeholder = ['Last 7 days', 'Download data', 'Video views', '--', '0', '(--)', 'Profile views', '--', '0', '(--)'];
  assert.equal(looksInsufficient(placeholder), true);

  const real = ['Video views', '47', '-9', '(-16.1%)', 'Profile views', '1', '0', '(0.0%)'];
  assert.equal(looksInsufficient(real), false);

  assert.equal(looksInsufficient([]), false);
  assert.equal(looksInsufficient(['No top posts']), false);
});

test('部分指标是 -- 但有真数字 → 不算数据不足（照常入库存真值）', () => {
  const mixed = ['Video views', '47', '-9', 'Likes', '--', '0'];
  assert.equal(looksInsufficient(mixed), false);
  assert.deepEqual(normalizeResult({ stats: { views: 47 } }).stats, { views: 47 });
});

// 主页数字（粉丝/关注/获赞）：分析页不给，必须靠主页资料卡
test('主页数字解析：0 是真值，K/M 万要换算，-- 一律 null', () => {
  assert.equal(parseCount('0'), 0);
  assert.equal(parseCount('47'), 47);
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('1.2K'), 1200);
  assert.equal(parseCount('3.4M'), 3400000);
  assert.equal(parseCount('2.1万'), 21000);
  assert.equal(parseCount('--'), null);
  assert.equal(parseCount(''), null);
  assert.equal(parseCount(null), null);
  assert.equal(parseCount('粉丝'), null);
});

test('partial：分析页是 -- 但主页读到粉丝 → 入库的同时标记"只拿到一部分"', () => {
  const r = normalizeResult({ stats: { followers: 0, following: 0, total_likes: 0 }, username: 'x', partial: true });
  assert.deepEqual(r.stats, { followers: 0, following: 0, total_likes: 0 });
  assert.equal(r.partial, true);
  assert.equal(r.insufficient, false, '有主页数字就不算"完全没数据"');
});

test('partial 不会把"只有主页数字"变成"什么都没有"', () => {
  const r = normalizeResult({ stats: { followers: 12 }, partial: true });
  assert.equal(r.stats.followers, 12);
  assert.equal(normalizeResult({ stats: null, partial: true }).stats, null);
});
