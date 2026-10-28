/**
 * 逐个账号开环境 → 打开主页 → 截图 + 读关键字段 → 关环境。
 * 用途：改完资料后「用眼睛」逐个核对（不只是读文本）。
 * 用法：node scripts/_verify-profiles.mjs [TK01,TK02,...]
 * 产出：%TEMP%\xnow-verify\<环境>.png + 控制台 JSON
 */
import fs from 'fs';
import path from 'path';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const DATA = process.env.APPDATA ? path.join(process.env.APPDATA, 'xnowpost') : '.';
const STATE = JSON.parse(fs.readFileSync(path.join(DATA, 'data', 'env-accounts.json'), 'utf8'));
const OUT = path.join(process.env.TEMP || '.', 'xnow-verify');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = (process.argv[2] || 'TK01,TK02,TK03,TK04,TK05,TK06,TK07,TK08,TK09,TK10')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const rows = [];
for (const env of list) {
  const handle = String((STATE[env] || {}).username || '').trim();
  const row = { env, handle };
  let page = null;
  const t0 = Date.now();
  try {
    const opened = await openFoxPage(env, API);
    page = opened.page;
    await page.goto(`https://www.tiktok.com/@${encodeURIComponent(handle)}`, { waitUntil: 'commit' });
    await sleep(9000);
    row.read = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const txt = (el) => (el ? String(el.textContent || '').trim() : '');
      return {
        title: document.title,
        name: txt(q('[data-e2e="user-title"]')),
        handle: txt(q('[data-e2e="user-subtitle"]')).replace(/^@/, ''),
        bio: txt(q('[data-e2e="user-bio"]')),
        followers: txt(q('[data-e2e="followers-count"]')),
        likes: txt(q('[data-e2e="likes-count"]')),
        avatar: (q('img[class*="ImgAvatar"]') || {}).src || '',
      };
    });
    const b64 = await page.screenshot();
    if (b64) fs.writeFileSync(path.join(OUT, `${env}.png`), Buffer.from(b64, 'base64'));
    row.shot = path.join(OUT, `${env}.png`);
  } catch (e) {
    row.error = String(e && e.message ? e.message : e);
  } finally {
    if (page) await closeFoxPage(env, API).catch(() => {});
  }
  row.seconds = Math.round((Date.now() - t0) / 1000);
  console.log(
    `${row.env} @${row.handle} | ${row.error ? 'ERR ' + row.error : `${row.read.name} | ${(row.read.bio || '').split('\\n')[0].slice(0, 18)} | 粉${row.read.followers} | ${row.seconds}s`}`,
  );
  rows.push(row);
}
fs.writeFileSync(path.join(OUT, 'verify.json'), JSON.stringify(rows, null, 1), 'utf8');
console.log('JSON → ' + path.join(OUT, 'verify.json'));
