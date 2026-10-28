// 精确测：收藏按钮「点到哪儿才有反应」+ 用什么判据能证明收藏成功。
// 三段测试：① 中心点 ② 按钮上部（避开数字） ③ 直接 DOM click。
// 每次点完读回「图标 svg 的 path 数据 + 计数文本 + class」，看哪个变了。
import { foxLaunch, foxRunning, foxStop } from '../src/collector/foxprofile.js';
import { attachFoxPage } from '../src/collector/foxpw.js';

const BASE = 'http://127.0.0.1:8000/api/v1';
const env = process.argv[2] || 'TK01';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SNAP = () => {
  const one = (sel) => {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx > 0 && cx < innerWidth - 20 && cy > 0 && cy < innerHeight && r.width > 8) {
        const svgPaths = [...el.querySelectorAll('path')].map((p) => String(p.getAttribute('d') || '').slice(0, 24)).join('|');
        return {
          cx: Math.round(cx),
          cy: Math.round(cy),
          top: Math.round(r.y),
          h: Math.round(r.height),
          label: String(el.getAttribute('aria-label') || '').slice(0, 70),
          cls: String(el.className || '').slice(0, 26),
          count: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20),
          svg: svgPaths,
        };
      }
    }
    return null;
  };
  return { favorite: one('[data-e2e="favorite-icon"]') };
};

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

  const a = await page.evaluate(SNAP);
  console.log('初始:', JSON.stringify(a.favorite));
  const f = a.favorite;
  if (!f) {
    console.log('视口里没有收藏按钮');
    await foxStop(env, BASE).catch(() => {});
    return;
  }

  const tries = [
    ['① 中心点', async () => { await page.mouse.move(f.cx, f.cy); await sleep(150); await page.mouse.click(f.cx, f.cy); }],
    ['② 按钮上部(top+18)', async () => { const x = f.cx, y = f.top + 18; await page.mouse.move(x, y); await sleep(150); await page.mouse.click(x, y); }],
    ['③ 直接 DOM click', async () => { await page.evaluate(() => document.querySelector('[data-e2e="favorite-icon"]')?.click()); }],
  ];

  for (const [name, act] of tries) {
    try {
      await act();
    } catch (e) {
      console.log(`  ${name} 失败: ${e.message}`);
      continue;
    }
    await sleep(2200);
    const b = await page.evaluate(SNAP);
    const nb = b.favorite;
    const diff = [];
    if (nb.label !== f.label) diff.push('label');
    if (nb.cls !== f.cls) diff.push('class');
    if (nb.count !== f.count) diff.push('count');
    if (nb.svg !== f.svg) diff.push('svg图标');
    console.log(`  ${name} → ${diff.length ? '✅ 变了: ' + diff.join(',') : '❌ 完全没变'}`);
    console.log(`      label="${nb.label}"  count="${nb.count}"`);
    if (diff.length) {
      console.log('      ★ 这个判据可以用；再点一次撤回…');
      await page.mouse.move(nb.cx, nb.cy);
      await sleep(150);
      await page.mouse.click(nb.cx, nb.cy);
      await sleep(1800);
      const c = await page.evaluate(SNAP);
      console.log(`      撤回后 label="${c.favorite.label}" count="${c.favorite.count}"`);
      break;
    }
  }

  await foxStop(env, BASE).catch(() => {});
  console.log(`${env} 已关闭`);
}

main().catch(async (e) => {
  console.error('失败:', e.message);
  await foxStop(env, BASE).catch(() => {});
});
