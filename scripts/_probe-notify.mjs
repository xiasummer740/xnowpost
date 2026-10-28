/** 看 TikTok 站内通知：有没有「头像被移除 / 违规」之类 */
import fs from 'fs';
import path from 'path';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = (process.argv[2] || 'TK01').toUpperCase();
const SHOT = path.join(process.env.TEMP || '.', 'xnow-probe');
fs.mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { env: ENV };
let page = null;
try {
  const opened = await openFoxPage(ENV, API);
  page = opened.page;
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto('https://www.tiktok.com/activity?lang=en', { waitUntil: 'commit' });
      break;
    } catch {
      await sleep(2000);
    }
  }
  await sleep(9000);
  out.page = await page.evaluate(() => {
    const t = String(document.body.innerText || '').replace(/[ \t]+/g, ' ');
    return { url: location.href, title: document.title, text: t.slice(0, 3000) };
  });
  const p = path.join(SHOT, `${ENV}-notifications.png`);
  await page.screenshot({ path: p }).catch(() => {});
  out.shot = p;
} catch (e) {
  out.error = String(e.message || e);
} finally {
  if (page) await closeFoxPage(ENV, API).catch(() => {});
  console.log(JSON.stringify(out, null, 1));
}
