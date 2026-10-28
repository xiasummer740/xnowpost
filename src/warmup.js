/**
 * 养号（warm-up）的核心规则：随机但不失控。
 *
 * 为什么单独抽一层：
 *  - 「随机看 8~25 秒」这种规则如果散在脚本里，就没法单测，阈值也会被随手改坏；
 *  - 养号是**会留下真实痕迹**的动作（点赞/收藏/关注），预算必须有硬上限，
 *    不能因为随机数跑飞就一天关注 50 个号；
 *  - 日志与证据需要一份统一的汇总口径（看了几条、真的播了几条、点了几个）。
 *
 * 实测依据（2026-10-22 探针，TK01）：
 *  - 首页 /foryou 的 <video> 全是 paused（自动播放被 Firefox 策略拦住），
 *    必须"点开视频"才会播；详情/播放页 paused=false 且 currentTime 真实前进；
 *  - 按钮选择器：like-icon(aria-pressed) / comment-icon / favorite-icon / share-icon / feed-follow。
 */

/** 默认参数（可在 config/user.json 的 warmup 段覆盖） */
export const WARMUP_DEFAULTS = {
  minutesPerAccount: 10,
  watchSec: [8, 25],
  // 每个账号「一次养号」的动作预算上限（硬上限，随机只在此基础上取）
  likes: [2, 4],
  favorites: [0, 2],
  follows: [0, 1],
  comments: 0,            // 默认不评论（用户 2026-10-22 定）
  accountGapSec: [45, 120],
  videosMax: 40,          // 兜底：就算时长没到，看满这么多条也收工
};

/** [min,max] 闭区间取整（rng 可注入，便于测试） */
export function pickInt(rng, range) {
  const [min, max] = Array.isArray(range) ? range : [0, 0];
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  if (hi <= lo) return lo;
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** 单条视频看多久：不超过本次剩余的预算（剩太少就不看了，返回 0） */
export function planWatchSeconds(rng, watchSec, remainingSec) {
  const remain = Math.max(0, Math.floor(Number(remainingSec) || 0));
  if (remain <= 2) return 0;
  const want = pickInt(rng, watchSec);
  if (want <= remain) return want;
  // 剩余不够一个完整区间 → 看剩下的，但少于 3 秒就没意义
  return remain >= 3 ? remain : 0;
}

/** 本次要做的动作预算（随机取，但都落在硬上限内） */
export function planBudgets(rng, opts = {}) {
  // ⚠️ 2026-10-22 真机踩到：调度器那一轮日志写「预算：赞≤0 藏≤0 关注≤0」，
  // 养号变成纯看视频一个动作都不做。原因是调用方传了 `{ likes: undefined }`
  // （命令行没给 `--likes`），`{...默认, ...opts}` 把默认的 [2,4] 覆盖成 undefined
  // → pickInt 拿不到区间退回 0。所以 undefined / null 一律当"没传"。
  const o = { ...WARMUP_DEFAULTS };
  for (const k of Object.keys(opts)) {
    if (opts[k] !== undefined && opts[k] !== null) o[k] = opts[k];
  }
  return {
    likes: pickInt(rng, o.likes),
    favorites: pickInt(rng, o.favorites),
    follows: pickInt(rng, o.follows),
    comments: Math.max(0, Math.floor(Number(o.comments) || 0)),
  };
}

/**
 * 这条视频要不要点赞/收藏/关注？
 * 概率 = 剩余额度 / 剩余视频数，保证"额度会在整轮里慢慢花掉"，
 * 而不是开头连点 4 个、后面 20 条一个都不点（那样更像机器）。
 */
export function shouldAct(rng, remaining, videosLeft) {
  const left = Math.max(0, Math.floor(Number(videosLeft) || 0));
  const rem = Math.max(0, Math.floor(Number(remaining) || 0));
  if (!rem) return false;
  if (left <= rem) return true;               // 视频不够分了，剩下的必须花掉
  return rng() < rem / left;
}

/**
 * 点了一个动作之后，怎么算「真的生效了」？
 *
 * 2026-10-23 现场实测（TK01 真机）：三个按钮的成功信号完全不一样，
 * 用同一套 aria-pressed 判据会让「收藏/关注」永远判失败 ——
 * 失败 → 额度不减 → 下一条视频接着点，等于对同一个号反复收藏/关注。
 *
 *  - like     : aria-pressed 会翻成 true（可靠）
 *  - favorite : 元素上**没有** aria-pressed；计数与 aria-label 会变（7689 → 7690）
 *  - follow   : aria-label 是空串；class 会变，或按钮直接消失
 *
 * @param {'like'|'favorite'|'follow'} kind
 * @param {object|null} before 点击前的快照（cx/cy/pressed/label/count/cls）
 * @param {object|null} after  点击后读到的快照；null = 这一帧没读到
 * @returns {{ ok: boolean, why: string }}
 */
export function actionRegistered(kind, before, after) {
  const b = before || {};
  const a = after || null;
  if (kind === 'follow') {
    if (!a) return { ok: true, why: '按钮消失' };
    if (/following/i.test(a.label || '')) return { ok: true, why: '变成 Following' };
    if (b.cls && a.cls && a.cls !== b.cls) return { ok: true, why: '按钮样式变了' };
    return { ok: false, why: '没读到状态变化' };
  }
  if (kind === 'favorite') {
    if (String(a && a.pressed) === 'true') return { ok: true, why: 'aria-pressed=true' };
    if (a && b.count && a.count && a.count !== b.count) return { ok: true, why: `计数 ${b.count}→${a.count}` };
    if (a && b.label && a.label && a.label !== b.label) return { ok: true, why: 'aria-label 变了' };
    return { ok: false, why: '没读到状态变化' };
  }
  if (String(a && a.pressed) === 'true') return { ok: true, why: 'aria-pressed=true' };
  return { ok: false, why: '没读到状态变化' };
}

/**
 * 汇总一轮养号的结果，并判断"这轮有没有真的干成活"。
 *
 * 判据只看落盘的数字：
 *  - 一条视频都没真正播放（playedCount===0）→ 不算成功（页面可能没打开/播放被拦）；
 *  - 看了但总时长几乎为 0 → 也不算成功；
 *  - 动作数超过预算 → 报问题（说明代码没守住上限）。
 */
export function judgeWarmupRun(records = [], budgets = null) {
  const list = Array.isArray(records) ? records : [];
  const played = list.filter((r) => r && r.played);
  const watchedSec = list.reduce((s, r) => s + (Number(r && r.watchedSec) || 0), 0);
  const counts = { like: 0, favorite: 0, follow: 0, comment: 0 };
  for (const r of list) {
    for (const a of (r && r.actions) || []) {
      if (counts[a] !== undefined) counts[a]++;
    }
  }
  const problems = [];
  // 翻页失效的典型症状：看了 9 条，但内容指纹只有 1~2 种（用户 2026-10-22 一眼看出来
  // 「我没看到你滑动刷视频」——当时用的 window.scrollBy 在固定播放器页面上根本不换视频）
  const keys = new Set(list.map((r) => (r && r.key) || '').filter(Boolean));
  const distinct = keys.size;
  if (!list.length) problems.push('一条视频都没看（页面可能没打开）');
  else if (!played.length) problems.push('没有一条视频真的在播放（播放被拦或白屏）');
  if (played.length >= 3 && distinct && distinct < Math.ceil(played.length / 2)) {
    problems.push(`看了 ${played.length} 条但只出现 ${distinct} 种不同视频，翻页多半没生效`);
  }
  if (list.length && watchedSec < 5) problems.push(`总观看只有 ${watchedSec} 秒，基本等于没看`);
  if (budgets) {
    if (counts.like > budgets.likes) problems.push(`点赞 ${counts.like} 次，超过预算 ${budgets.likes}`);
    if (counts.favorite > budgets.favorites) problems.push(`收藏 ${counts.favorite} 次，超过预算 ${budgets.favorites}`);
    if (counts.follow > budgets.follows) problems.push(`关注 ${counts.follow} 个，超过预算 ${budgets.follows}`);
    if (counts.comment > budgets.comments) problems.push(`评论 ${counts.comment} 条，超过预算 ${budgets.comments}`);
  }
  return {
    ok: problems.length === 0,
    videos: list.length,
    playedCount: played.length,
    distinctVideos: distinct,
    watchedSec,
    counts,
    problems,
  };
}

/** 一行总结（日志/证据共用，避免两处措辞不一致） */
export function summarizeWarmup(result, env) {
  const r = result || {};
  const who = env ? `${env} ` : '';
  const act = [];
  if (r.counts) {
    if (r.counts.like) act.push(`赞${r.counts.like}`);
    if (r.counts.favorite) act.push(`藏${r.counts.favorite}`);
    if (r.counts.follow) act.push(`关注${r.counts.follow}`);
    if (r.counts.comment) act.push(`评论${r.counts.comment}`);
  }
  return `${who}看了 ${r.videos || 0} 条（真播 ${r.playedCount || 0} 条，共 ${Math.round((r.watchedSec || 0) / 1) || 0} 秒）${act.length ? ' · ' + act.join(' ') : ' · 无动作'}`;
}

/**
 * 每个账号养多久：在区间里随机抽（2026-10-22 用户口径「选随机养号时长」）。
 * 固定同一分钟数每个号都一模一样，反而更像脚本，所以默认就带随机。
 */
export function planAccountMinutes(rng, range) {
  const [lo, hi] = Array.isArray(range) ? range : [8, 15];
  return Math.max(1, Math.min(60, pickInt(rng, [lo, hi])));
}

/** 一轮总时长预算（分钟）：每号随机时长 + 号与号之间的歇脚时间 */
export function planSessionMinutes(rng, { accounts = 1, minutes = [8, 15], gapSec = WARMUP_DEFAULTS.accountGapSec } = {}) {
  const n = Math.max(1, Math.floor(Number(accounts) || 1));
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += planAccountMinutes(rng, minutes);
    if (i < n - 1) total += pickInt(rng, gapSec) / 60;
  }
  return Math.round(total * 10) / 10;
}