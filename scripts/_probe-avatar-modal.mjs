/** 头像到底哪张在生效：主页头图 vs 编辑资料弹窗里的「Profile photo」预览
 *  如果两个 src/内容不一样 → 主页 HTML 是缓存，真身是新的
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = (process.argv[2] || 'TK01').toUpperCase();
const SHOT = path.join(process.env.TEMP || '.', 'xnow-probe');
fs.mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { env: ENV };
let page = null;

const grab = () =>
  page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')].filter((i) => i.naturalWidth >= 60);
    return imgs.slice(0, 12).map((i) => {
      const r = i.getBoundingClientRect();
      return {
        src: i.src.slice(0, 120),
        id: (i.src.match(/avt-[0-9a-f]+-([0-9a-zA-Z]{8})/) || [])[1] || '',
        nat: `${i.naturalWidth}x${i.naturalHeight}`,
        box: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        cls: String(i.className || '').slice(0, 40),
      };
    });
  });

try {
  const st = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'xnowpost', 'data', 'env-accounts.json'), 'utf8'));
  const handle = (st[ENV] && st[ENV].username) || '';
  const opened = await openFoxPage(ENV, API);
  page = opened.page;
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(`https://www.tiktok.com/@${handle}?lang=en&_r=${Date.now()}`, { waitUntil: 'commit' });
      break;
    } catch {
      await sleep(2000);
    }
  }
  await sleep(8000);
  out.profileImgs = await grab();
  out.profileShot = path.join(SHOT, `${ENV}-p1-profile.png`);
  await page.screenshot({ path: out.profileShot }).catch(() => {});

  const ent = await page.evaluate(() => {
    const b = document.querySelector('[data-e2e="edit-profile-entrance"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (ent) {
    await page.mouse.click(ent.x, ent.y);
    await sleep(5000);
    out.modalImgs = await grab();
    out.modalText = await page.evaluate(() => {
      const t = String(document.body.innerText || '').replace(/\s+/g, ' ');
      const i = t.indexOf('Edit profile');
      return i >= 0 ? t.slice(i, i + 400) : t.slice(0, 400);
    });
    out.modalShot = path.join(SHOT, `${ENV}-p2-modal.png`);
    await page.screenshot({ path: out.modalShot }).catch(() => {});
    const cancel = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^(cancel|取消)$/i.test(String(x.textContent || '').trim()));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (cancel) await page.mouse.click(cancel.x, cancel.y);
  }
} catch (e) {
  out.error = String(e.message || e);
} finally {
  if (page) await closeFoxPage(ENV, API).catch(() => {});
  console.log(JSON.stringify(out, null, 1));
}
