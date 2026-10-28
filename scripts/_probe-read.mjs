/** 只读探针：开环境 → 打开个人主页 → 截图 + 打印页面文字（排查「编辑资料弹窗打不开」） */
import fs from 'fs';
import path from 'path';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = (process.argv[2] || 'TK06').toUpperCase();
const DATA = process.env.APPDATA ? path.join(process.env.APPDATA, 'xnowpost') : '.';
const STATE = JSON.parse(fs.readFileSync(path.join(DATA, 'data', 'env-accounts.json'), 'utf8'));
const handle = String((STATE[ENV] || {}).username || '').trim();
const SHOT = path.join(process.env.TEMP || '.', 'xnow-probe');
fs.mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page = null;
const out = { env: ENV, handle };
try {
  const opened = await openFoxPage(ENV, API);
  page = opened.page;
  await page.goto(`https://www.tiktok.com/@${encodeURIComponent(handle)}`, { waitUntil: 'commit' });
  await sleep(8000);
  out.state = await page.evaluate(() => {
    const vis = (s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), text: String(el.textContent || '').trim().slice(0, 30) };
    };
    const fixed = [];
    for (const el of document.querySelectorAll('div[role="dialog"],div[class*="Modal"],div[class*="Dialog"]')) {
      const r = el.getBoundingClientRect();
      if (r.width > 200 && r.height > 80) fixed.push({ cls: String(el.className).slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), txt: String(el.innerText || '').replace(/\s+/g, ' ').slice(0, 120) });
    }
    return {
      url: location.href,
      title: document.title,
      entrance: vis('[data-e2e="edit-profile-entrance"]'),
      editByText: [...document.querySelectorAll('button,div,a,span')]
        .filter((e) => /^(Edit profile|编辑资料)$/i.test(String(e.textContent || '').trim()))
        .map((e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; })
        .slice(0, 6),
      overlays: fixed.slice(0, 5),
      bodyText: String(document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
    };
  });
  await page.screenshot({ path: path.join(SHOT, `${ENV}-read.png`) }).catch(() => {});
} catch (e) {
  out.error = String(e && e.message ? e.message : e);
} finally {
  if (page) await closeFoxPage(ENV, API).catch(() => {});
  console.log(JSON.stringify(out, null, 1));
}
