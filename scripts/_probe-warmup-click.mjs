// 现场测：收藏 / 关注 点下去之后，DOM 到底怎么变（用来定"验证成功"的判据）。
// 只点 1 次收藏 + 1 次关注，测完把它撤回来（再点一次）。
import { foxLaunch, foxRunning, foxStop } from '../src/collector/foxprofile.js';
import { attachFoxPage } from '../src/collector/foxpw.js';

const BASE = 'http://127.0.0.1:8000/api/v1';
const env = process.argv[2] || 'TK01';

const SNAP = () => {
  const one = (sel) => {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx > 0 && cx < innerWidth - 20 && cy > 0 && cy < innerHeight && r.width > 8) {
        return {
          cx: Math.round(cx),
          cy: Math.round(cy),
          label: String(el.getAttribute('aria-label') || '').split('\n')[0].slice(0, 60),
          pressed: el.getAttribute('aria-pressed'),
          e2e: el.getAttribute('data-e2e'),
          cls: String(el.className || '').slice(0, 40),
          // 旁边的数字（收藏数/点赞数）
          near: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 40),
        };
      }
    }
    return null;
  };
  return { favorite: one('[data-e2e="favorite-icon"]'), follow: one('[data-e2e="feed-follow"]') };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const running = await foxRunning(BASE).catch(() => []);
  const list = Array.isArray(running) ? running : running?.running || [];
  if (list.length) {
    console.log('已有环境在跑，不动它:', list.join(','));
    return;
  }
  await foxLaunch(env, BASE, { focus: false });
  const { page } = await attachFoxPage(env, BASE);
  await page.goto('https://www.tiktok.com/foryou?lang=en', { waitUntil: 'load', timeout: 60000 });
  await sleep(7000);

  // 先点开视频让它播（和养号一样）
  const card = await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-e2e="feed-video"]')) {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx > 0 && cx < innerWidth && cy > 40 && cy < innerHeight - 40 && r.width > 150) return { cx: Math.round(cx), cy: Math.round(cy) };
    }
    return null;
  });
  if (card) {
    await page.mouse.click(card.cx, card.cy);
    await sleep(3500);
  }

  for (const kind of ['favorite', 'follow']) {
    const a = await page.evaluate(SNAP);
    const box = a[kind];
    if (!box) {
      console.log(`${kind}: 视口里没有这个按钮，跳过`);
      continue;
    }
    console.log(`\n=== ${kind} 点击前 ===`);
    console.log('  ', JSON.stringify(box));
    await page.mouse.move(box.cx, box.cy);
    await sleep(200);
    await page.mouse.click(box.cx, box.cy);
    await sleep(2500);
    const b = await page.evaluate(SNAP);
    console.log(`=== ${kind} 点击后 ===`);
    console.log('  ', JSON.stringify(b[kind]));
    const changed = JSON.stringify(a[kind]) !== JSON.stringify(b[kind]);
    console.log(`  → 判据可用吗: ${changed ? '✅ label/e2e/pressed 至少变了一样' : '❌ DOM 完全没变（aria-pressed 不能当判据）'}`);

    // 撤回来：如果点了之后状态变了，再点一次还原
    if (changed && b[kind]) {
      await page.mouse.click(b[kind].cx, b[kind].cy);
      await sleep(1800);
      const c = await page.evaluate(SNAP);
      console.log(`  撤回后:`, JSON.stringify(c[kind]));
    }
  }

  await foxStop(env, BASE).catch(() => {});
  console.log(`\n${env} 已关闭`);
}

main().catch(async (e) => {
  console.error('探查失败:', e.message);
  await foxStop(env, BASE).catch(() => {});
});
