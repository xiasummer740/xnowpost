/**
 * 养号规则的单测（v1.6.58）。
 *
 * 这些数字不是装饰：点赞/收藏/关注都会在平台上留下真实痕迹，
 * 预算跑飞就是"账号被判 spam 的加速器"。所以上限必须有测试守着。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WARMUP_DEFAULTS, pickInt, planWatchSeconds, planBudgets, shouldAct, actionRegistered, toastRegistered,
  judgeWarmupRun, summarizeWarmup, planAccountMinutes, planSessionMinutes,
} from '../../src/warmup.js';

/** 可复现的假随机（LCG），避免测试随机波动 */
function seeded(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('pickInt 永远落在区间内，且首尾都可能取到', () => {
  const rng = seeded(7);
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const v = pickInt(rng, [2, 4]);
    assert.ok(v >= 2 && v <= 4, `越界: ${v}`);
    seen.add(v);
  }
  assert.deepEqual([...seen].sort(), [2, 3, 4]);
});

test('观看时长默认在 8~25 秒之间', () => {
  const rng = seeded(11);
  for (let i = 0; i < 300; i++) {
    const v = planWatchSeconds(rng, WARMUP_DEFAULTS.watchSec, 600);
    assert.ok(v >= 8 && v <= 25, `越界: ${v}`);
  }
});

test('剩余时间不够一条时，不会超支（宁可 0 也不看半条）', () => {
  const rng = seeded(3);
  assert.equal(planWatchSeconds(rng, [8, 25], 2), 0, '只剩 2 秒不该再开一条');
  assert.equal(planWatchSeconds(rng, [8, 25], 0), 0);
  assert.equal(planWatchSeconds(rng, [8, 25], 5), 5, '剩 5 秒就看 5 秒');
});

test('动作预算不超过硬上限（关注最多 1 个）', () => {
  const rng = seeded(23);
  for (let i = 0; i < 300; i++) {
    const b = planBudgets(rng);
    assert.ok(b.likes >= 2 && b.likes <= 4, `点赞预算越界: ${b.likes}`);
    assert.ok(b.favorites >= 0 && b.favorites <= 2, `收藏预算越界: ${b.favorites}`);
    assert.ok(b.follows >= 0 && b.follows <= 1, `关注预算越界: ${b.follows}`);
    assert.equal(b.comments, 0, '默认不评论');
  }
});

test('shouldAct：额度必须会花掉，但不会在开头一次花光', () => {
  const rng = seeded(5);
  // 视频很多、额度 1 → 只有小概率触发
  let hits = 0;
  for (let i = 0; i < 200; i++) hits += shouldAct(rng, 1, 20) ? 1 : 0;
  assert.ok(hits > 0 && hits < 60, `概率不合理: ${hits}/200`);
  // 视频数 == 剩余额度 → 必点
  assert.equal(shouldAct(rng, 2, 2), true);
  // 没额度了 → 绝不点
  assert.equal(shouldAct(rng, 0, 5), false);
});

test('一条都没播 → 判不成功（这是"页面没打开"最常见的样子）', () => {
  const r = judgeWarmupRun([
    { played: false, watchedSec: 0, actions: [] },
    { played: false, watchedSec: 0, actions: [] },
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('没有一条视频真的在播放')));
});

test('正常一轮：有播放、动作在预算内 → 通过', () => {
  const r = judgeWarmupRun(
    [
      { played: true, watchedSec: 12, actions: ['like'] },
      { played: true, watchedSec: 9, actions: ['favorite'] },
      { played: true, watchedSec: 15, actions: [] },
    ],
    { likes: 4, favorites: 2, follows: 1, comments: 0 },
  );
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.equal(r.videos, 3);
  assert.equal(r.playedCount, 3);
  assert.equal(r.watchedSec, 36);
  assert.equal(r.counts.like, 1);
  assert.equal(r.counts.favorite, 1);
});

test('动作超预算 → 必须报问题（代码没守住上限时能被发现）', () => {
  const r = judgeWarmupRun(
    [{ played: true, watchedSec: 10, actions: ['like', 'like', 'like', 'follow', 'follow'] }],
    { likes: 2, favorites: 0, follows: 1, comments: 0 },
  );
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('点赞 3 次，超过预算 2')));
  assert.ok(r.problems.some((p) => p.includes('关注 2 个，超过预算 1')));
});

test('看是看了但总时长接近 0 → 不算成功', () => {
  const r = judgeWarmupRun([{ played: true, watchedSec: 1, actions: [] }]);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('基本等于没看')));
});

test('总结文案包含账号、条数、真播数与动作', () => {
  const line = summarizeWarmup({ videos: 9, playedCount: 8, watchedSec: 95, counts: { like: 2, favorite: 1, follow: 0, comment: 0 } }, 'TK01');
  assert.match(line, /^TK01 看了 9 条/);
  assert.match(line, /真播 8 条/);
  assert.match(line, /赞2/);
  assert.match(line, /藏1/);
  assert.doesNotMatch(line, /关注0/);
});

test('空输入不抛异常', () => {
  const r = judgeWarmupRun();
  assert.equal(r.ok, false);
  assert.equal(r.videos, 0);
  assert.doesNotThrow(() => summarizeWarmup(null, null));
});

test('看了很多条但内容指纹都相同 → 报「翻页没生效」（用户 2026-10-22 亲眼指出）', () => {
  const same = Array.from({ length: 9 }, (_, i) => ({ played: true, watchedSec: 12, actions: [], key: 'hannah + oscar my life’s dream' }));
  const r = judgeWarmupRun(same);
  assert.equal(r.ok, false);
  assert.equal(r.distinctVideos, 1);
  assert.ok(r.problems.some((p) => p.includes('翻页多半没生效')));
});

test('正常翻页：9 条 9 种不同视频 → 通过', () => {
  const distinct = Array.from({ length: 9 }, (_, i) => ({ played: true, watchedSec: 12, actions: [], key: `video-${i}` }));
  const r = judgeWarmupRun(distinct);
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.equal(r.distinctVideos, 9);
});
test('传 undefined 不能把默认预算吃掉（2026-10-22 真机踩到的 赞≤0 bug）', () => {
  const rng = seeded(9);
  const b = planBudgets(rng, { likes: undefined, favorites: undefined, follows: undefined });
  assert.ok(b.likes >= 2 && b.likes <= 4, `默认点赞预算被吃掉了: ${b.likes}`);
  assert.ok(b.favorites >= 0 && b.favorites <= 2);
  assert.ok(b.follows >= 0 && b.follows <= 1);
});

test('显式传 0 才是真的关掉（命令行 --likes 0 生效）', () => {
  const b = planBudgets(seeded(1), { likes: [0, 0], follows: [0, 0] });
  assert.equal(b.likes, 0);
  assert.equal(b.follows, 0);
  assert.ok(b.favorites >= 0, '没传的收藏预算仍走默认');
});
test('每号时长在区间内随机抽，且各个号不总是一样长', () => {
  const rng = seeded(77);
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const m = planAccountMinutes(rng, [8, 15]);
    assert.ok(m >= 8 && m <= 15, `越界: ${m}`);
    seen.add(m);
  }
  assert.ok(seen.size >= 5, `随机性不足，只出现过 ${seen.size} 种时长`);
});

test('区间传反了 / 传单个值也能用', () => {
  const rng = seeded(5);
  assert.equal(planAccountMinutes(rng, [10, 10]), 10);
  const m = planAccountMinutes(rng, [15, 8]);
  assert.ok(m >= 8 && m <= 15, `反区间没纠正: ${m}`);
});

test('一轮总时长 = 各号时长 + 号间休息，至少等于 n×最短', () => {
  const rng = seeded(31);
  const total = planSessionMinutes(rng, { accounts: 3, minutes: [8, 15] });
  assert.ok(total >= 3 * 8, `太短: ${total}`);
  assert.ok(total <= 3 * 15 + 2 * 2 + 1, `太长: ${total}`);
});
// ───────────────── 动作验证判据（2026-10-23 真机实测） ─────────────────
// 事故背景：收藏按钮没有 aria-pressed，旧判据永远 false → 真点了也记失败 →
// 额度不减 → 下一条视频接着点。同一轮里可能对十几个视频重复收藏/关注。

test('actionRegistered：点赞只看 aria-pressed', () => {
  assert.deepEqual(actionRegistered('like', { pressed: 'false' }, { pressed: 'true' }), { ok: true, why: 'aria-pressed=true' });
  assert.equal(actionRegistered('like', { pressed: 'false' }, { pressed: 'false' }).ok, false);
  assert.equal(actionRegistered('like', {}, null).ok, false);
});

test('actionRegistered：收藏靠计数/标签变化（它没有 aria-pressed）', () => {
  // 真机实测：点收藏后 7689 → 7690，元素上始终没有 aria-pressed
  const before = { cx: 1, cy: 1, pressed: null, label: 'Add to Favorites. 7689', count: '7689', cls: 'a' };
  const after = { cx: 1, cy: 1, pressed: null, label: 'Add to Favorites. 7690', count: '7690', cls: 'a' };
  const r = actionRegistered('favorite', before, after);
  assert.equal(r.ok, true);
  assert.match(r.why, /计数/);

  // 只有 label 变（计数被四舍五入抹平时）也算
  const onlyLabel = actionRegistered('favorite', before, { ...before, label: 'Remove from Favorites. 7689' });
  assert.equal(onlyLabel.ok, true);

  // 完全没变 = 没成功（这时额度已经先扣了，不会再重复点）
  assert.equal(actionRegistered('favorite', before, { ...before }).ok, false);
});

test('actionRegistered：关注靠 class 变化或按钮消失（aria-label 是空串）', () => {
  const before = { cls: 'elfe6iu1 css-co7ut0', label: '' };
  assert.equal(actionRegistered('follow', before, { cls: 'elfe6iu1 css-d2rrar', label: '' }).ok, true);
  assert.equal(actionRegistered('follow', before, null).ok, true);          // 按钮消失
  assert.equal(actionRegistered('follow', before, { cls: 'x', label: 'Following' }).ok, true);
  assert.equal(actionRegistered('follow', before, { ...before }).ok, false);
});
// ============ 提示条判据（2026-10-29 真机探针后补） ============
// 背景：收藏成功后 `[data-e2e="favorite-icon"]` 的 aria-label 与计数**都不变**，
// 只有页面弹的「Added to Favorites  Manage」提示条能证明点成功了。
// 养号那 13/17 次「收藏没确认到变化」就是判据瞎了 —— 收藏其实都成功。

test('toastRegistered：收藏成功只认提示条', () => {
  const v = toastRegistered('favorite', 'Added to Favorites Manage');
  assert.equal(v.ok, true);
  assert.match(v.why, /Added to Favorites/);
});

test('toastRegistered：提示条重复出现（选择器命中多个节点）也算成功', () => {
  const v = toastRegistered('favorite', 'Added to Favorites Manage | Added to Favorites Manage | Added to Favorites Manage');
  assert.equal(v.ok, true);
});

test('toastRegistered：取消收藏是另一句话，不能被当成"没收藏"', () => {
  assert.match(toastRegistered('favorite', 'Removed from Favorites').why, /Removed/);
});

test('toastRegistered：无关提示条不算数（复制链接、网络错误…）', () => {
  assert.equal(toastRegistered('favorite', 'Link copied'), null);
  assert.equal(toastRegistered('favorite', ''), null);
  assert.equal(toastRegistered('favorite', null), null);
  assert.equal(toastRegistered('like', 'Added to Favorites Manage'), null);
});

test('toastRegistered：点赞先排除 Unliked（含 liked 字样）', () => {
  assert.match(toastRegistered('like', 'Unliked').why, /Unliked/);
  assert.match(toastRegistered('like', 'Liked').why, /Liked/);
  assert.equal(toastRegistered('like', 'Comment posted'), null);
});

test('toastRegistered：关注/取关', () => {
  assert.match(toastRegistered('follow', 'Following').why, /Following/);
  assert.match(toastRegistered('follow', 'Now following this account').why, /Following/);
  assert.match(toastRegistered('follow', 'Unfollowed').why, /Unfollowed/);
  assert.equal(toastRegistered('follow', 'Something went wrong'), null);
});

test('翻页卡住 → 按"卡了多少次"说清楚，而不是含糊的"翻页没生效"（2026-10-30 事故）', () => {
  const recs = Array.from({ length: 11 }, (_, i) => ({ played: true, watchedSec: 14, actions: [], key: `video-${i}` }));
  const r = judgeWarmupRun(recs, null, { stuck: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.stuck, 20);
  const msg = r.problems.join('; ');
  assert.ok(msg.includes('翻页卡住 20 次'), msg);
  assert.ok(msg.includes('只看到 11 种不同视频'), msg);
  assert.ok(!msg.includes('翻页多半没生效'), '有卡住证据时不该再报含糊说法: ' + msg);
});

test('卡住 1~2 次算抖一下，不判失败（不能因为网络慢一次就报红）', () => {
  const recs = Array.from({ length: 12 }, (_, i) => ({ played: true, watchedSec: 15, actions: [], key: `video-${i}` }));
  const r = judgeWarmupRun(recs, null, { stuck: 2 });
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.equal(r.stuck, 2);
});

test('总结行会带上"卡住N次"（日志/回报一眼能看出是翻页问题）', () => {
  const line = summarizeWarmup({ videos: 11, playedCount: 11, watchedSec: 160, stuck: 20, counts: { like: 1, favorite: 0, follow: 0, comment: 0 } }, 'TK02');
  assert.match(line, /卡住20次/);
});
