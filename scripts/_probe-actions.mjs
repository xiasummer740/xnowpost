/**
 * 只读探针 3：视频详情页的动作栏（点赞/评论/收藏/分享/关注）到底长什么样。
 *
 * ⚠️ 只读：不点赞、不关注、不评论，只读 DOM 与 aria 状态。
 * 这一步决定养号脚本能不能"看得见按钮、点得准、读得回"。
 *
 * 用法：node scripts/_probe-actions.mjs TK01
 */
import { openFoxProfile, closeFoxProfile } from '../src/collector/foxprofile.js';

const BASE = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = (process.argv[2] || 'TK01').toUpperCase();
const VIDEO = process.env.PROBE_VIDEO || 'https://www.tiktok.com/@tiktok/video/7106594312292453675?lang=en';

const ACTIONS = () => {
  const e2e = {};
  for (const el of document.querySelectorAll('[data-e2e]')) {
    const k = el.getAttribute('data-e2e');
    if (!k) continue;
    e2e[k] = (e2e[k] || 0) + 1;
  }
  const describe = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      inView: r.y > -50 && r.y < innerHeight + 50 && r.x > -50 && r.x < innerWidth + 50,
      pressed: el.getAttribute('aria-pressed'),
      label: el.getAttribute('aria-label') || '',
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20),
      e2e: el.getAttribute('data-e2e') || '',
    };
  };
  const sels = [
    '[data-e2e="like-icon"]', '[data-e2e="browse-like-icon"]', '[data-e2e="like-button"]',
    '[data-e2e="comment-icon"]', '[data-e2e="browse-comment-icon"]',
    '[data-e2e="undefined-icon"]', '[data-e2e="favorite-icon"]', '[data-e2e="browse-favorite-icon"]',
    '[data-e2e="share-icon"]', '[data-e2e="follow-button"]', '[data-e2e="feed-follow"]',
    'button[aria-label*="Like"]', 'button[aria-label*="like"]',
    'button[aria-label*="Favorite"]', 'button[aria-label*="Collect"]',
    'span[role="button"][aria-label*="Like"]',
  ];
  const found = {};
  for (const s of sels) {
    const el = document.querySelector(s);
    if (el) found[s] = describe(el);
  }
  const v = document.querySelector('video');
  return {
    url: location.href,
    video: v ? { paused: v.paused, t: Math.round(v.currentTime * 10) / 10, dur: Number.isFinite(v.duration) ? Math.round(v.duration) : null } : null,
    found,
    e2e: Object.entries(e2e).sort((a, b) => b[1] - a[1]).slice(0, 45),
    // 动作栏里的全部按钮（按可见性 + 位置，右侧竖排）
    rightRailButtons: [...document.querySelectorAll('button, span[role="button"], div[role="button"]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 20 && r.width < 90 && r.height > 20 && r.height < 90 && r.x > innerWidth * 0.6;
      })
      .slice(0, 12)
      .map(describe),
  };
};

async function main() {
  console.log(`  ═══ 动作栏探针 ${ENV} ═══`);
  const { page } = await openFoxProfile(ENV, BASE);
  try {
    await page.goto(VIDEO, { waitUntil: 'commit' });
    await page.waitForTimeout(10000);
    const d = await page.evaluate(ACTIONS);
    console.log('\n  url:', d.url);
    console.log('  video:', JSON.stringify(d.video));
    console.log('\n  ── 候选选择器命中 ──');
    if (!Object.keys(d.found).length) console.log('   （一个都没命中）');
    for (const [k, v] of Object.entries(d.found)) console.log(`   ${k}\n      ${JSON.stringify(v)}`);
    console.log('\n  ── 右侧竖排按钮（可能是点赞/评论/收藏/分享）──');
    d.rightRailButtons.forEach((b, i) => console.log(`   #${i} ${JSON.stringify(b)}`));
    console.log('\n  ── data-e2e 清单 ──');
    console.log('  ' + d.e2e.map(([k, n]) => `${k}×${n}`).join('  '));
  } finally {
    await closeFoxProfile(ENV, BASE);
  }
}

main().catch((e) => {
  console.log('  ❌ 探针失败:', e.message);
  process.exitCode = 1;
});
