/** 只读：打开指定 URL，打印标题/昵称/handle/正文片段 + 截图 */
import fs from 'fs';
import path from 'path';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = (process.argv[2] || 'TK01').toUpperCase();
const URL0 = process.argv[3] || '';
const SHOT = path.join(process.env.TEMP || '.', 'xnow-probe');
fs.mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page = null;
const out = { env: ENV, url: URL0 };
try {
  const opened = await openFoxPage(ENV, API);
  page = opened.page;
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(URL0, { waitUntil: 'commit' });
      break;
    } catch (e) {
      out.gotoRetry = (out.gotoRetry || 0) + 1;
      await sleep(2000);
    }
  }
  await sleep(8000);
  out.state = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const txt = (el) => (el ? String(el.textContent || '').trim() : '');
    return {
      url: location.href,
      title: document.title,
      name: txt(q('[data-e2e="user-title"]')),
      handle: txt(q('[data-e2e="user-subtitle"]')).replace(/^@/, ''),
      bio: txt(q('[data-e2e="user-bio"]')).replace(/\n/g, ' / '),
      notFound: /Couldn't find this account|找不到|not available/i.test(String(document.body.innerText || '')),
      body: String(document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 260),
    };
  });
  await page.screenshot({ path: path.join(SHOT, `${ENV}-url.png`) }).catch(() => {});
} catch (e) {
  out.error = String(e && e.message ? e.message : e);
} finally {
  if (page) await closeFoxPage(ENV, API).catch(() => {});
  console.log(JSON.stringify(out, null, 1));
}
