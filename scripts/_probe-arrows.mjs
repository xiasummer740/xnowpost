import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';
const BASE = 'http://127.0.0.1:8000/api/v1';
const { page } = await openFoxPage('TK01', BASE);
try {
  await page.goto('https://www.tiktok.com/foryou?lang=en', { waitUntil: 'commit' });
  await page.waitForTimeout(9000);
  const d = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-e2e*="navigation"], [data-e2e*="arrow"], button[aria-label*="ext"], button[aria-label*="revious"]')) {
      const r = el.getBoundingClientRect();
      out.push({
        e2e: el.getAttribute('data-e2e'), aria: el.getAttribute('aria-label'),
        cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2),
        w: Math.round(r.width), h: Math.round(r.height),
      });
    }
    const v = document.querySelector('video');
    const item = v && v.closest('[data-e2e="recommend-list-item-container"]');
    return {
      navs: out,
      key: item ? (item.innerText || '').replace(/\s+/g, ' ').slice(0, 60) : null,
      videoSrc: v ? String(v.currentSrc || '').slice(-24) : null,
    };
  });
  console.log(JSON.stringify(d, null, 1));
} finally { await closeFoxPage('TK01', BASE); }
