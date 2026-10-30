/**
 * 自动养号：像人一样刷 TikTok（看视频、点赞、收藏、关注），到点自动关浏览器、换下一个号。
 *
 * 设计口径（2026-10-22 与用户确认）：
 *  - **一次只开一个环境**（用户只有 1 个出口 IP，并发 = 自己举报自己）；
 *  - **不评论**（默认；评论是最容易被判 spam 的动作）；
 *  - 每条视频的观看时长 8~25 秒随机；点赞 2~4 / 收藏 0~2 / 关注 0~1 是**每号每次的硬上限**；
 *  - 动作点完必须**读回状态**（`aria-pressed`）才算数，点不中不假装成功；
 *  - 到设定时长就关浏览器，休眠一小会儿再开下一个账号。
 *
 * 为什么必须"点开视频"：实测（2026-10-22 TK01）首页 /foryou 的 <video> 全是 `paused:true`，
 * 自动播放被 Firefox 策略拦住；点开后的播放页 `paused:false` 且 `currentTime` 真实前进。
 * 所以养号靠"点开 → 确认在播 → 看一会儿 → 往下翻下一条"驱动，而不是干等首页自动播。
 *
 * 用法：
 *   node scripts/tk-warmup.mjs --only TK01 --minutes 10          # 养一个号
 *   node scripts/tk-warmup.mjs --accounts 01,02 --minutes 10      # 串行养两个号
 *   node scripts/tk-warmup.mjs --only TK01 --minutes 3 --dry-run  # 只看不点（不点赞/不关注）
 */
import fs from 'fs';
import path from 'path';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';
import { dataPath } from '../src/paths.js';
import {
  WARMUP_DEFAULTS, planWatchSeconds, planBudgets, shouldAct, actionRegistered, toastRegistered, judgeWarmupRun, summarizeWarmup,
  planAccountMinutes,
} from '../src/warmup.js';

const BASE = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = '') => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const num = (k, d) => {
  const v = Number(val(k, ''));
  return Number.isFinite(v) && v > 0 ? v : d;
};
// 预算类参数必须能接受 0（"这次一个赞都别点"）。
// 2026-10-29 实测：`--favorites 1 --likes 0` 里那个 0 被上面的 `v > 0` 挡掉 →
// 悄悄退回默认 2~4 个赞，命令看着生效、其实没生效（同 planBudgets 那个 undefined 坑）。
const num0 = (k, d) => {
  const raw = val(k, '');
  if (raw === '') return d;                        // 没给这个参数 → 用默认
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : d;
};

const DRY = has('--dry-run') || has('--no-actions');
// 每个账号养多久：
//   固定写法  --minutes 10        （老参数，仍兼容）
//   随机写法  --minutes-min 8 --minutes-max 15   （界面「随机/号」用的就是这条）
const MINUTES_FIXED = num('--minutes', 0);
const MIN_MIN = num('--minutes-min', 0);
const MAX_MIN = num('--minutes-max', 0);
const MINUTES_RANGE = (() => {
  if (MIN_MIN > 0 || MAX_MIN > 0) {
    const lo = MIN_MIN > 0 ? MIN_MIN : (MAX_MIN > 0 ? MAX_MIN : WARMUP_DEFAULTS.minutesPerAccount);
    const hi = MAX_MIN > 0 ? MAX_MIN : lo;
    return [Math.min(lo, hi), Math.max(lo, hi)];
  }
  if (MINUTES_FIXED > 0) return [MINUTES_FIXED, MINUTES_FIXED];
  return [WARMUP_DEFAULTS.minutesPerAccount, WARMUP_DEFAULTS.minutesPerAccount];
})();
const MINUTES = Math.round((MINUTES_RANGE[0] + MINUTES_RANGE[1]) / 2);   // 只用于文案里的"大约"
const ONLY = (val('--only') || '').toUpperCase();
const ACCOUNTS = (val('--accounts') || '').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_VIDEOS = num('--videos', WARMUP_DEFAULTS.videosMax);
const OUT_DIR = dataPath('data', 'warmup');
const LOG_JSONL = dataPath('data', 'warmup-log.jsonl');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rng = Math.random;
const nowIso = () => new Date().toISOString();

/** 读当前视口里那一条视频的状态（真正在播的那条） */
const READ_VIDEO = () => {
  const vis = [...document.querySelectorAll('video')].map((v) => {
    const r = v.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    return {
      inView: cx > 0 && cx < innerWidth && cy > 0 && cy < innerHeight && r.width > 100,
      paused: v.paused,
      t: Math.round(v.currentTime * 10) / 10,
      dur: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
      muted: v.muted,
      cx: Math.round(cx),
      cy: Math.round(cy),
    };
  });
  const idx = vis.findIndex((x) => x.inView);
  const v = vis[idx >= 0 ? idx : 0] || null;
  // 给"当前这条视频"取个指纹：用来确认翻页真的换了内容。
  // ⚠️ 2026-10-29 踩到：以前用 `item.innerText.slice(0, 50)`，而 TikTok 的卡片正文
  // 大量以「CapCut · Try this template…」这种模板文案开头 → 不同视频的指纹一模一样，
  // 于是 4 个号被误报「看了 21 条只出现 5 种不同视频，翻页多半没生效」。
  // 视频地址里的 id 才是真正唯一的；拿不到才退回「作者 + 更长的正文」。
  let key = '';
  if (v) {
    const el = [...document.querySelectorAll('video')][idx >= 0 ? idx : 0];
    const item = el && el.closest('[data-e2e="recommend-list-item-container"]');
    const src = String((el && (el.currentSrc || el.src)) || '');
    const m = src.match(/\/video\/(\d+)/) || src.match(/\/([0-9a-f]{16,})\./i) || src.match(/\/([A-Za-z0-9_-]{16,})\?/);
    if (m) key = `v${m[1]}`;
    if (!key && item) {
      const a = item.querySelector('a[href^="/@"]');
      const author = a ? String(a.getAttribute('href') || '') : '';
      key = `${author}|${(item.innerText || '').replace(/\s+/g, ' ').slice(0, 80)}`;
    }
  }
  return {
    video: v ? { ...v, key } : null,
    count: vis.length,
    atBottom: innerHeight + scrollY >= document.body.scrollHeight - 200,
  };
};

/** 读动作按钮（点赞/收藏/关注）的位置与状态 */
const READ_ACTIONS = () => {
  const pick = (sel) => {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx > 0 && cx < innerWidth - 20 && cy > 0 && cy < innerHeight && r.width > 8) {
        return {
          cx: Math.round(cx), cy: Math.round(cy),
          pressed: el.getAttribute('aria-pressed'),
          label: String(el.getAttribute('aria-label') || '').split('\n')[0].slice(0, 30),
          // 收藏按钮没有 aria-pressed（2026-10-23 实测），只能靠「计数 / aria-label / class」有没有变
          count: String(el.innerText || '').replace(/[^\d.KkMm\u4e07]/g, '').slice(0, 12),
          cls: String(el.className || '').slice(0, 40),
        };
      }
    }
    return null;
  };
  return {
    like: pick('[data-e2e="like-icon"]'),
    favorite: pick('[data-e2e="favorite-icon"]'),
    follow: pick('[data-e2e="feed-follow"]'),
  };
};

/** 读页面刚弹的提示条（收藏/关注成功时只有它有反应，见 src/warmup.js#toastRegistered） */
const READ_TOAST = () => {
  const out = [];
  for (const sel of ['[role="alert"]', '.TUXToast', '[class*="Toast"]', '[class*="toast"]']) {
    for (const el of document.querySelectorAll(sel)) {
      const t = String(el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && t.length > 2) out.push(t.slice(0, 80));
    }
  }
  return [...new Set(out)].join(' | ');
};

/** 点一下并读回（点赞看 aria-pressed；收藏/关注还要看页面提示条） */
async function clickAndVerify(page, kind, before, deadlineMs = 4000) {
  try {
    await page.mouse.move(before.cx, before.cy);
    await sleep(120 + rng() * 260);
    await page.mouse.click(before.cx, before.cy);
  } catch (e) {
    return { ok: false, why: `点击失败: ${e.message}` };
  }
  const t0 = Date.now();
  let lastToast = '';
  while (Date.now() - t0 < deadlineMs) {
    await sleep(400);
    const st = await page.evaluate(READ_ACTIONS).catch(() => null);
    if (st) {
      const cur = st[kind];
      // 判据统一放在 src/warmup.js#actionRegistered（有单测），脚本里不再各写一套
      const v = actionRegistered(kind, before, cur);
      if (v.ok) return v;
    }
    // 收藏按钮的 aria-label / 计数点完不变（2026-10-29 真机实测），只能靠提示条
    lastToast = await page.evaluate(READ_TOAST).catch(() => '') || lastToast;
    const vt = toastRegistered(kind, lastToast);
    if (vt && vt.ok) return vt;
  }
  return { ok: false, why: lastToast ? `没读到状态变化（页面提示：「${lastToast.slice(0, 30)}」）` : '没读到状态变化' };
}

/** 打开首页并点开第一条视频（没有这一步视频不会播） */
async function openFeedAndPlay(page) {
  await page.goto('https://www.tiktok.com/foryou?lang=en', { waitUntil: 'commit' }).catch((e) => {
    if (!/interrupted by another navigation/i.test(String(e.message || ''))) throw e;
  });
  await page.waitForTimeout(7000);
  // 找一个"在视口内"的 feed 卡片，用真实鼠标点它（合成 click 不会触发播放）
  const card = await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-e2e="feed-video"]')) {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx > 0 && cx < innerWidth && cy > 40 && cy < innerHeight - 40 && r.width > 150) {
        return { cx: Math.round(cx), cy: Math.round(cy) };
      }
    }
    return null;
  });
  if (!card) return false;
  await page.mouse.move(card.cx, card.cy);
  await sleep(200 + rng() * 300);
  await page.mouse.click(card.cx, card.cy);
  await page.waitForTimeout(4000);
  return true;
}

/** 确保视频真的在播：暂停就点一下，最多试 3 次 */
async function ensurePlaying(page) {
  for (let i = 0; i < 3; i++) {
    const s = await page.evaluate(READ_VIDEO).catch(() => null);
    const v = s && s.video;
    if (v && !v.paused && v.t > 0) return v;
    if (v && v.paused) {
      await page.mouse.click(v.cx, v.cy).catch(() => {});
      await page.waitForTimeout(1200);
      continue;
    }
    await page.waitForTimeout(1500);
  }
  const s = await page.evaluate(READ_VIDEO).catch(() => null);
  return s && s.video && !s.video.paused ? s.video : null;
}

/** 看一会儿：每 2 秒确认还在播，顺便累计真实观看时长 */
async function watchFor(page, seconds) {
  const t0 = Date.now();
  let watching = 0;
  let last = null;
  while ((Date.now() - t0) / 1000 < seconds) {
    await sleep(1800);
    const s = await page.evaluate(READ_VIDEO).catch(() => null);
    const v = s && s.video;
    if (v && !v.paused) {
      watching += 1.8;
      last = v;
      // 视频播完了就提前结束这条（像真人一样划走）
      if (v.dur && v.t >= v.dur - 0.6) break;
      // 偶尔把鼠标晃一下（纯人类行为，也让页面不进入空闲态）
      if (rng() < 0.25) {
        await page.mouse.move(v.cx + (rng() - 0.5) * 80, v.cy + (rng() - 0.5) * 80).catch(() => {});
      }
    } else if (v && v.paused) {
      await page.mouse.click(v.cx, v.cy).catch(() => {});
    }
  }
  return { watchedSec: Math.round(watching), last };
}

/**
 * 下一条：先点箭头；箭头点了没换内容，就换一种输入方式再推（↓ 键、连点）。
 *
 * 2026-10-30 事故：原来只点箭头、每次等 1.8~2.7 秒，3 次不换就当失败。
 * 实测 `02:00` 那轮 62 次"点了没换内容"全集中在 TK01/02/03/05（TK02 22 次、TK05 20 次），
 * 而 TikTok 的箭头在视频还没加载完时经常"点了不响应" —— 单纯多点几次没用，
 * 换输入方式（键盘 ↓）往往一下就过去了。
 */
async function nextVideo(page, { waits = [1200, 2200, 3400] } = {}) {
  const before = await page.evaluate(READ_VIDEO).catch(() => null);
  const beforeKey = before && before.video ? before.video.key : '';
  for (let i = 0; i < waits.length; i++) {
    await advanceFeed(page, i);
    await page.waitForTimeout(waits[i] + Math.round(rng() * 400));
    const after = await page.evaluate(READ_VIDEO).catch(() => null);
    const afterKey = after && after.video ? after.video.key : '';
    if (afterKey && afterKey !== beforeKey) return true;
  }
  return false;
}

/** 推一次页面：第 0 次点箭头，第 1 次换键盘 ↓，第 2 次连点两下 */
async function advanceFeed(page, round) {
  const arrow = await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-e2e="feed-navigation-next"]')) {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx > 0 && cx < innerWidth && cy > 0 && cy < innerHeight) return { cx: Math.round(cx), cy: Math.round(cy) };
    }
    return null;
  }).catch(() => null);

  if (round === 1) {
    // TikTok 桌面版支持 ↓ 切下一条；箭头卡住时它经常还能用
    await page.keyboard.press('ArrowDown').catch(() => {});
    return;
  }
  if (!arrow) {
    // 箭头没渲染出来时兜底点一次 DOM（不理想，但比卡在同一个视频上强）
    await page.evaluate(() => {
      const el = document.querySelector('[data-e2e="feed-navigation-next"]');
      if (el) el.click();
    }).catch(() => {});
    return;
  }
  await page.mouse.move(arrow.cx, arrow.cy).catch(() => {});
  await page.waitForTimeout(120 + Math.round(rng() * 200));
  await page.mouse.click(arrow.cx, arrow.cy).catch(() => {});
  if (round >= 2) {
    await page.waitForTimeout(220);
    await page.mouse.click(arrow.cx, arrow.cy).catch(() => {});
  }
}

function log(msg) {
  console.log(`  ${msg}`);
}

async function warmOne(env, minutes) {
  // minutes 由调用方按区间随机抽好再传进来（每个号都不一样长）
  const budgetMs = minutes * 60 * 1000;
  const clampTo = (n) => (Number.isFinite(n) && n >= 0 ? [n, n] : undefined);
  const budgets = planBudgets(rng, {
    likes: clampTo(num0('--likes', -1)) || undefined,
    favorites: clampTo(num0('--favorites', -1)) || undefined,
    follows: clampTo(num0('--follows', -1)) || undefined,
  });
  const caps = { ...budgets };   // 开跑前的预算 = 本次硬上限（判定用，别拿跑完扣减过的值）
  const records = [];
  // 翻页卡住的次数：判定在 try/finally 之后才做，所以必须声明在外面（2026-10-30 踩过：
  // 声明在 try 里 → 判定那行直接 `stuckEvents is not defined`，整轮白跑）
  let stuckEvents = 0;
  const startedAt = Date.now();
  log(`🏃 ${env} 开始养号（${minutes} 分钟，预算：赞≤${budgets.likes} 藏≤${budgets.favorites} 关注≤${budgets.follows}${DRY ? '｜演练：不看也不点' : ''}）`);

  const { page } = await openFoxPage(env, BASE);
  try {
    const opened = await openFeedAndPlay(page);
    if (!opened) log('⚠️ 首页没找到可点的视频卡片，直接尝试读取当前页');

    let videosLeft = MAX_VIDEOS;
    let minutesLeft = minutes;
    let noPlayStreak = 0;   // 连续几条放不起来
    let stuckStreak = 0;    // 连续几次推不动页面（总次数 stuckEvents 在外面声明）
    let lastKey = '';       // 刚看完那条的指纹：推不动时不能把同一条视频再记一遍
    let loops = 0;          // 兜底：防止"推不动 → 又看同一条"吃掉整个时间预算
    while (videosLeft > 0 && Date.now() - startedAt < budgetMs) {
      if (++loops > MAX_VIDEOS * 6) {
        log('   ⚠️ 循环次数到上限（一直在同一条上推不动），本轮提前结束');
        break;
      }
      // 上一条看完后没推动页面：这条视频已经看过了，不重复看、不重复记账，先把页面推过去
      if (lastKey) {
        const peek = await page.evaluate(READ_VIDEO).catch(() => null);
        const peekKey = peek && peek.video ? peek.video.key : '';
        if (peekKey && peekKey === lastKey) {
          stuckStreak++;
          stuckEvents++;
          log(`   ↻ 还停在第 ${records.length} 条（推不动，连续 ${stuckStreak} 次）—— 不重复记账，再推一次`);
          if (await nextVideo(page)) {
            stuckStreak = 0;
          } else if (stuckStreak >= 4) {
            log('   ❌ 连续 4 次都推不动：这个号的推荐页现在不换内容，本轮提前结束');
            break;
          }
          continue;
        }
      }

      const remainingSec = Math.max(0, Math.round((budgetMs - (Date.now() - startedAt)) / 1000));
      const watchSec = planWatchSeconds(rng, WARMUP_DEFAULTS.watchSec, remainingSec);
      if (!watchSec) break;

      const playing = await ensurePlaying(page);
      if (!playing) {
        noPlayStreak++;
        log(`   ⚠️ 第 ${records.length + 1} 条没能播放（可能被拦/白屏），往下翻（连续 ${noPlayStreak} 条）`);
        records.push({ played: false, watchedSec: 0, actions: [] });
        await nextVideo(page);
        videosLeft--;
        // 2026-10-23 实测：TK04/TK05 整轮 12 分钟、40 条全是「没能播放」，
        // 相当于开着浏览器干耗着（那一轮因为这两个号多花了 20 分钟）。
        // 连续 6 条都放不起来就认输退出，把真相写进 problems。
        if (noPlayStreak >= 6) {
          log('   ❌ 连续 6 条都放不起来：这个号的首页现在不给播（大概率要验证/被拦），本轮提前结束');
          break;   // 不 throw：保留已看到的记录，由 judgeWarmupRun 判「一条都没播」
        }
        continue;
      }
      noPlayStreak = 0;

      const { watchedSec } = await watchFor(page, watchSec);
      const cur = await page.evaluate(READ_VIDEO).catch(() => null);
      const keyNow = cur && cur.video ? cur.video.key : '';
      const actions = [];

      if (!DRY) {
        const st = await page.evaluate(READ_ACTIONS).catch(() => null);
        const videosRemain = Math.max(1, Math.round(remainingSec / 14));   // 按平均 14 秒估还剩几条，不能用 MAX_VIDEOS（那会把概率摊成 5%）
        // 点赞
        if (st && st.like && String(st.like.pressed) !== 'true' && shouldAct(rng, budgets.likes, videosRemain)) {
          const r = await clickAndVerify(page, 'like', st.like);
          if (r.ok) { actions.push('like'); budgets.likes--; log(`   👍 点赞（${r.why}）`); }
          else log(`   ⚠️ 点赞没成功：${r.why}`);
        }
        // 收藏
        if (st && st.favorite && shouldAct(rng, budgets.favorites, videosRemain)) {
          // 先扣额度再点：万一验证判据失效（TikTok 改版），也不会下一条又点一次
          budgets.favorites--;
          const r = await clickAndVerify(page, 'favorite', st.favorite);
          if (r.ok) { actions.push('favorite'); log(`   ⭐ 收藏（${r.why}）`); }
          else log(`   ⚠️ 收藏点了但没确认到变化（${r.why}），按已尝试计，不重复点`);
        }
        // 关注（上限很小，且只在这条视频的作者上有按钮时才做）
        if (st && st.follow && shouldAct(rng, budgets.follows, Math.max(videosRemain * 3, 1))) {
          budgets.follows--;   // 同上：先扣，避免反复关注不同作者
          const r = await clickAndVerify(page, 'follow', st.follow);
          if (r.ok) { actions.push('follow'); log(`   ➕ 关注作者（${r.why}）`); }
          else log(`   ⚠️ 关注点了但没确认到变化（${r.why}），按已尝试计，不重复点`);
        }
      }

      records.push({ played: true, watchedSec, actions, key: keyNow });
      videosLeft--;
      if (keyNow) lastKey = keyNow;
      minutesLeft = Math.round((budgetMs - (Date.now() - startedAt)) / 60000);
      const tag = keyNow ? `「${keyNow.slice(0, 18)}」` : '';
      log(`   ▶️ 第 ${records.length} 条 ${tag}：看 ${watchedSec} 秒${actions.length ? ' · ' + actions.join('+') : ''}（还剩约 ${minutesLeft} 分钟）`);

      const moved = await nextVideo(page);
      if (moved) stuckStreak = 0;
      else log('   ⚠️ 点「下一个」后内容没变（可能卡在同一条），下一轮换 ↓ 键再推');
    }
  } finally {
    await closeFoxPage(env, BASE);
  }

  // 判定用**开跑前的预算**当上限（budgets 跑到后面会被扣减，不能拿扣完的值当上限）
  const verdict = judgeWarmupRun(records, caps, { stuck: stuckEvents });
  log(`${verdict.ok ? '✅' : '⚠️'} ${summarizeWarmup(verdict, env)}`);
  if (verdict.problems.length) log(`   ↳ ${verdict.problems.join('；')}`);
  return { env, minutes, dryRun: DRY, startedAt: new Date(startedAt).toISOString(), ...verdict, records };
}

function resolveEnvList() {
  if (ONLY) return [ONLY];
  if (!ACCOUNTS.length) return [];
  return ACCOUNTS.map((a) => (/^TK\d+$/i.test(a) ? a.toUpperCase() : `TK${String(a).padStart(2, '0')}`));
}

async function main() {
  const envs = resolveEnvList();
  if (!envs.length) {
    log('用法：node scripts/tk-warmup.mjs --only TK01 --minutes 10');
    log('      node scripts/tk-warmup.mjs --accounts 01,02 --minutes 10');
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date();
  const runFile = path.join(
    OUT_DIR,
    `${stamp.toLocaleDateString('sv-SE')}-${stamp.toTimeString().slice(0, 5).replace(':', '')}.json`,
  );

  log('');
  log('  ═══ TikTok 自动养号 ═══');
  log(`   FoxProfile: ${BASE}`);
  log(`   账号 ${envs.length} 个（串行，同一时刻只开一个环境）：${envs.join(' → ')}`);
  log(`   每号随机 ${MINUTES_RANGE[0]}~${MINUTES_RANGE[1]} 分钟${DRY ? '｜演练模式（不点赞/不关注）' : ''}`);
  log('');

  const sessions = [];
  for (let i = 0; i < envs.length; i++) {
    const env = envs[i];
    try {
      // 每个号单独抽时长（用户要的「随机养号时长」），同一天不同号长度不一样才像真的
      const minutesForThis = planAccountMinutes(rng, MINUTES_RANGE);
      log(`   🎲 ${env} 这次养 ${minutesForThis} 分钟`);
      const s = await warmOne(env, minutesForThis);
      sessions.push(s);
    } catch (e) {
      log(`  ❌ ${env} 养号失败：${e.message}`);
      sessions.push({ env, error: e.message, ok: false, videos: 0, playedCount: 0, watchedSec: 0, counts: {}, problems: [e.message] });
    }
    if (i < envs.length - 1) {
      const gap = Math.round(45 + rng() * 75);
      log(`  😴 歇 ${gap} 秒再开下一个号（避免两个号紧挨着活动）`);
      await sleep(gap * 1000);
    }
  }

  const okCount = sessions.filter((s) => s.ok).length;
  const totalVideos = sessions.reduce((s, x) => s + (x.videos || 0), 0);
  const totalSec = sessions.reduce((s, x) => s + (x.watchedSec || 0), 0);
  const totalActions = sessions.reduce((s, x) => s + Object.values(x.counts || {}).reduce((a, b) => a + b, 0), 0);

  const evidence = {
    at: nowIso(),
    dryRun: DRY,
    minutesRange: MINUTES_RANGE,
    accounts: envs,
    okCount,
    totalVideos,
    totalWatchedSec: totalSec,
    totalActions,
    sessions,
  };
  fs.writeFileSync(runFile, JSON.stringify(evidence, null, 2), 'utf-8');
  fs.appendFileSync(
    LOG_JSONL,
    JSON.stringify({ at: evidence.at, accounts: envs, ok: okCount, videos: totalVideos, sec: totalSec, actions: totalActions, dryRun: DRY }) + '\n',
    'utf-8',
  );

  log('');
  log(`  合计：成功 ${okCount}/${sessions.length} 个号 · 共看 ${totalVideos} 条 / ${totalSec} 秒 · 动作 ${totalActions} 次`);
  log(`  证据：${runFile}`);
  // 退出码约定：
  //   0 = 全部账号都养成功
  //   4 = 部分成功（有的号播放被拦/白屏，一条都没播），别人是真的养了 ——
  //       调度器会记成「部分完成」，绝不记整轮失败（用户会以为熬夜白跑）。
  //   1 = 一个号都没养成 / 脚本异常
  if (okCount === 0) process.exitCode = 1;
  else if (okCount < sessions.length) process.exitCode = 4;
}

main().catch((e) => {
  log(`  ❌ 养号失败：${e.message}`);
  process.exitCode = 1;
});
