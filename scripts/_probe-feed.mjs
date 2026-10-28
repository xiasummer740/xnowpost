/**
 * 只读探针：看 TikTok For You 首页长什么样，能不能"像人一样刷"。
 *
 * ⚠️ 本脚本**只读**：不点赞、不关注、不评论、不滚动播放（只读 DOM + 截图）。
 * 用途：在写养号功能之前，先确认真实选择器（feed 容器、点赞/评论/收藏按钮、video 元素状态）。
 *
 * 用法：
 *   node scripts/_probe-feed.mjs TK01
 */
import path from 'path';
import fs from 'fs-extra';
import { openFoxProfile, closeFoxProfile } from '../src/collector/foxprofile.js';
import { dataPath } from '../src/paths.js';

const BASE = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = (process.argv[2] || 'TK01').toUpperCase();
const OUT = dataPath('output', 'probe-feed');

const PROBE = () => {
  const seen = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      visible: r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none',
      aria: el.getAttribute('aria-label') || el.getAttribute('aria-pressed') || '',
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24),
    };
  };

  // 1) 页面上所有 data-e2e 值（这才是真正可靠的选择器来源）
  const e2e = {};
  for (const el of document.querySelectorAll('[data-e2e]')) {
    const k = el.getAttribute('data-e2e');
    if (!k) continue;
    e2e[k] = (e2e[k] || 0) + 1;
  }

  // 2) 视频元素与播放状态（判断是否在自动播放、是否静音）
  const videos = [...document.querySelectorAll('video')].map((v) => {
    const r = v.getBoundingClientRect();
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      paused: v.paused,
      muted: v.muted,
      volume: v.volume,
      currentTime: Math.round(v.currentTime * 10) / 10,
      duration: Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : null,
      src: String(v.currentSrc || v.src || '').slice(0, 60),
    };
  });

  // 3) 侧栏动作按钮（点赞/评论/收藏/分享/关注）—— 登录取 feed 版和未登录 browse 版选择器不同，都试
  const candidates = [
    '[data-e2e="like-icon"]', '[data-e2e="browse-like-icon"]',
    '[data-e2e="comment-icon"]', '[data-e2e="browse-comment-icon"]',
    '[data-e2e="undefined-icon"]', '[data-e2e="browse-favorite-icon"]',
    '[data-e2e="share-icon"]', '[data-e2e="browse-share-icon"]',
    '[data-e2e="feed-follow"]', '[data-e2e="follow-button"]',
    '[data-e2e="recommend-list-item-container"]', '[data-e2e="feed-video"]',
    'article[data-e2e]', 'div[data-e2e="recommend-list-item-container"]',
  ];
  const found = {};
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) found[sel] = seen(el);
  }

  // 4) 页面上一共有多少个"可刷的条目"
  const feedItems = {
    recommendContainer: document.querySelectorAll('[data-e2e="recommend-list-item-container"]').length,
    feedVideo: document.querySelectorAll('[data-e2e="feed-video"]').length,
    articles: document.querySelectorAll('article').length,
    videosInDom: document.querySelectorAll('video').length,
  };

  return {
    url: location.href,
    loginHint: /Log in|登录/i.test((document.body.innerText || '').slice(0, 4000)),
    bodyTextHead: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 240),
    feedItems,
    videos,
    found,
    e2eTop: Object.entries(e2e).sort((a, b) => b[1] - a[1]).slice(0, 40),
  };
};

async function main() {
  await fs.ensureDir(OUT);
  console.log(`  ═══ For You 只读探针 ${ENV} ═══`);
  const { page } = await openFoxProfile(ENV, BASE);
  try {
    await page.goto('https://www.tiktok.com/foryou?lang=en', { waitUntil: 'commit' });
    console.log('  等首页渲染（12 秒）...');
    await page.waitForTimeout(12000);
    const d1 = await page.evaluate(PROBE);
    console.log('\n  ── 第一眼 ──');
    console.log('  url:', d1.url);
    console.log('  feed:', JSON.stringify(d1.feedItems));
    console.log('  videos:', JSON.stringify(d1.videos));
    console.log('  登录提示:', d1.loginHint, '| 正文头部:', d1.bodyTextHead.slice(0, 160));
    console.log('\n  ── 命中的选择器 ──');
    for (const [k, v] of Object.entries(d1.found)) console.log(`   ${k}  ${JSON.stringify(v)}`);
    console.log('\n  ── 页面上的 data-e2e（按数量）──');
    console.log('  ' + d1.e2eTop.map(([k, n]) => `${k}×${n}`).join('  '));

    // 再等 6 秒，看视频是不是真的自己在播（currentTime 会前进）
    await page.waitForTimeout(6000);
    const d2 = await page.evaluate(PROBE);
    console.log('\n  ── 6 秒后（看是否自动播放）──');
    console.log('  videos:', JSON.stringify(d2.videos));

    const shot = path.join(OUT, `${ENV}-foryou.png`);
    try {
      await page.screenshot({ path: shot });
      console.log(`  截图: ${shot}`);
    } catch (e) {
      console.log('  截图失败:', e.message);
    }
  } finally {
    await closeFoxProfile(ENV, BASE);
  }
}

main().catch((e) => {
  console.log('  ❌ 探针失败:', e.message);
  process.exitCode = 1;
});
