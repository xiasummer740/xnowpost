/**
 * 只读校验 2：登录后怎么拿到自己的 @用户名（screen_name 是 user48… 那种内部 id，不能用）。
 * 试三条路：①点头像菜单里的链接 ②studio 页 ③设置页。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = (process.argv[2] || 'TK01').toUpperCase();
const DATA = process.env.APPDATA ? path.join(process.env.APPDATA, 'xnowpost') : '.';
const state = JSON.parse(fs.readFileSync(path.join(DATA, 'data', 'env-accounts.json'), 'utf8'));
console.log(`  期望：@${state[ENV]?.username}`);

const { page } = await openFoxPage(ENV, API, { minimize: true });
try {
  await page.goto('https://www.tiktok.com/foryou');
  await page.waitForTimeout(6000);

  const icon = await page.evaluate(() => {
    const el = document.querySelector('[data-e2e="profile-icon"]');
    if (!el) return { ok: false, keys: Object.keys(window).length };
    const r = el.getBoundingClientRect();
    el.click();
    return { ok: true, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
  });
  console.log('  头像按钮:', JSON.stringify(icon));
  await page.waitForTimeout(4000);

  const menu = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href^="/@"]')).map((a) => a.getAttribute('href'));
    const texts = (document.body.innerText || '').split('\n').filter((t) => /@[\w.]+/.test(t)).slice(0, 8);
    return { links: Array.from(new Set(links)).slice(0, 10), texts };
  });
  console.log('  点开菜单后的 @链接:', JSON.stringify(menu.links));
  console.log('  正文里的 @串:', JSON.stringify(menu.texts));

  await page.goto('https://www.tiktok.com/tiktokstudio');
  await page.waitForTimeout(7000);
  const studio = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href^="/@"]')).map((a) => a.getAttribute('href'));
    const t = (document.body.innerText || '').replace(/\s+/g, ' ');
    const m = t.match(/@[\w.]{3,30}/g) || [];
    return { url: location.href, links: Array.from(new Set(links)).slice(0, 8), ats: Array.from(new Set(m)).slice(0, 8) };
  });
  console.log('  studio:', JSON.stringify(studio));
} finally {
  await closeFoxPage(ENV, API).catch(() => {});
}
