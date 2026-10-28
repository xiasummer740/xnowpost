/** 点 Save 之后 TikTok 到底说了什么：把每一层浮层/弹窗的文字原样抓下来（最后点 Cancel，不确认） */
import fs from 'fs';
import path from 'path';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = (process.argv[2] || 'TK07').toUpperCase();
const NAME = process.argv[3] || '';
const BIO = process.argv[4] || '';
const SHOT = path.join(process.env.TEMP || '.', 'xnow-probe');
fs.mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { env: ENV, name: NAME, bio: BIO, overlays: [] };
let page = null;

const overlays = () =>
  page.evaluate(() => {
    const res = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('div,section,[role="dialog"]')) {
      const s = getComputedStyle(el);
      if (s.position !== 'fixed' && el.getAttribute('role') !== 'dialog') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 80) continue;
      const t = String(el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 600) continue;
      const key = t.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      res.push({ text: t, box: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` });
    }
    return res;
  });

try {
  const opened = await openFoxPage(ENV, API);
  page = opened.page;
  const st = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'xnowpost', 'data', 'env-accounts.json'), 'utf8'));
  const handle = (st[ENV] && st[ENV].username) || '';
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(`https://www.tiktok.com/@${handle}?lang=en&_r=${Date.now()}`, { waitUntil: 'commit' });
      break;
    } catch {
      await sleep(2000);
    }
  }
  await sleep(8000);
  const clickText = async (re, tag) => {
    const p = await page.evaluate((src) => {
      const r = new RegExp(src, 'i');
      const cands = [...document.querySelectorAll('button,div[role="button"],a')].filter(
        (e) => r.test(String(e.textContent || '').trim()) && e.offsetParent !== null
      );
      if (!cands.length) return null;
      const e = cands.reduce((a, b) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height <= b.getBoundingClientRect().width * b.getBoundingClientRect().height ? a : b));
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), text: String(e.textContent || '').trim().slice(0, 30) };
    }, re);
    if (!p) return null;
    await page.mouse.click(p.x, p.y);
    out[tag] = p.text;
    return p;
  };
  // 开弹窗
  const ent = await page.evaluate(() => {
    const b = document.querySelector('[data-e2e="edit-profile-entrance"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (!ent) throw new Error('没找到编辑资料入口');
  await page.mouse.click(ent.x, ent.y);
  await sleep(4500);

  // 填 Name
  if (NAME) {
    const np = await page.evaluate(() => {
      const e = [...document.querySelectorAll('input')].find((x) => /^name$/i.test(x.getAttribute('placeholder') || ''));
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (np) {
      await page.mouse.click(np.x, np.y);
      await sleep(250);
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await sleep(150);
      await page.keyboard.type(NAME, { delay: 45 });
      await sleep(600);
      out.nameTyped = await page.evaluate(() => {
        const e = [...document.querySelectorAll('input')].find((x) => /^name$/i.test(x.getAttribute('placeholder') || ''));
        return e ? String(e.value) : '';
      });
    } else out.nameFieldMissing = true;
  }
  // 填 Bio
  if (BIO) {
    const bp = await page.evaluate(() => {
      const e = document.querySelector('textarea[data-e2e="edit-profile-bio-input"]');
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (bp) {
      await page.mouse.click(bp.x, bp.y);
      await sleep(250);
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await sleep(150);
      await page.keyboard.type(BIO, { delay: 25 });
      await sleep(700);
    }
  }
  out.beforeSaveShots = await overlays();
  out.saveShot = path.join(SHOT, `${ENV}-save-before.png`);
  await page.screenshot({ path: out.saveShot }).catch(() => {});

  // 点 Save
  const sp = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^(save|保存)$/i.test(String(x.textContent || '').trim()));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), disabled: b.disabled };
  });
  out.saveBtn = sp;
  if (sp && !sp.disabled) {
    await page.mouse.click(sp.x, sp.y);
    const seen = new Set();
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      const ov = await overlays();
      for (const o of ov) {
        const key = o.text.slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        out.overlays.push({ t: i * 0.5, ...o });
        const p2 = path.join(SHOT, `${ENV}-ov-${out.overlays.length}.png`);
        await page.screenshot({ path: p2 }).catch(() => {});
        out.overlays[out.overlays.length - 1].shot = p2;
      }
    }
    out.afterSaveShot = path.join(SHOT, `${ENV}-save-after.png`);
    await page.screenshot({ path: out.afterSaveShot }).catch(() => {});
    out.finalModal = await page.evaluate(() => {
      const t = String(document.body.innerText || '').replace(/\s+/g, ' ');
      const i = t.indexOf('Edit profile');
      return i >= 0 ? t.slice(i, i + 300) : t.slice(0, 300);
    });
  }
  // 收尾：Cancel（不确认任何弹窗）
  const c = await clickText('^(cancel|取消|not now|stay)$', 'cancelClicked');
  await sleep(600);
  if (!c) {
    await page.keyboard.press('Escape').catch(() => {});
  }
} catch (e) {
  out.error = String(e.message || e);
} finally {
  if (page) await closeFoxPage(ENV, API).catch(() => {});
  console.log(JSON.stringify(out, null, 1));
}
