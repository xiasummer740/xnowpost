/** 眼见为实：把用户名改成目标值，Save 前后各截一张，并把弹窗文字/报错全 dump 出来（最后按取消，不确认） */
import fs from 'fs';
import path from 'path';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = (process.argv[2] || 'TK01').toUpperCase();
const HANDLE = process.argv[3] || 'ryloclyjdcf';
const TARGET = process.argv[4] || '';
const SHOT = path.join(process.env.TEMP || '.', 'xnow-probe');
fs.mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { env: ENV, from: HANDLE, to: TARGET, steps: [] };
let page = null;

const snap = async (tag) => {
  const p = path.join(SHOT, `${ENV}-rename-${tag}.png`);
  await page.screenshot({ path: p }).catch(() => {});
  out.steps.push({ tag, shot: p });
};
const dialogText = () =>
  page.evaluate(() => {
    const t = String(document.body.innerText || '').replace(/\s+/g, ' ');
    const i = t.indexOf('Edit profile');
    return (i >= 0 ? t.slice(i, i + 700) : t.slice(0, 700));
  });

try {
  const opened = await openFoxPage(ENV, API);
  page = opened.page;
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(`https://www.tiktok.com/@${HANDLE}`, { waitUntil: 'commit' });
      break;
    } catch {
      await sleep(2000);
    }
  }
  await sleep(7000);
  const ent = await page.evaluate(() => {
    const b = document.querySelector('[data-e2e="edit-profile-entrance"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (!ent) throw new Error('没找到编辑资料入口');
  await page.mouse.click(ent.x, ent.y);
  await sleep(4000);

  // 填用户名
  const pos = await page.evaluate(() => {
    const e = [...document.querySelectorAll('input')].find((x) => /username/i.test(x.getAttribute('placeholder') || ''));
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (!pos) throw new Error('没找到用户名输入框');
  await page.mouse.click(pos.x, pos.y);
  await sleep(300);
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  await sleep(200);
  await page.keyboard.type(TARGET, { delay: 55 }).catch(() => {});
  await sleep(6000);
  out.beforeSave = {
    save: await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^(save|保存)$/i.test(String(x.textContent || '').trim()));
      return b ? { disabled: b.disabled } : null;
    }),
    text: await dialogText(),
  };
  await snap('before-save');

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
    await sleep(3500);
    out.afterSave = { text: await dialogText() };
    await snap('after-save');
    await sleep(3000);
    out.afterSave2 = { text: await dialogText(), url: page.url ? page.url() : '' };
    await snap('after-5s');
  }
  // 收尾：点 Cancel（不确认任何弹窗）
  const cp = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^(cancel|取消|not now|稍后|以后)/i.test(String(x.textContent || '').trim()));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: String(b.textContent || '').trim() };
  });
  if (cp) {
    await page.mouse.click(cp.x, cp.y);
    out.cancelled = cp.text;
    await sleep(1000);
  }
} catch (e) {
  out.error = String(e && e.message ? e.message : e);
} finally {
  if (page) await closeFoxPage(ENV, API).catch(() => {});
  console.log(JSON.stringify(out, null, 1));
}
