/** 一次性测多个候选用户名：每个填进去看 aria-invalid / Save 是否可用，最后恢复原值（不保存） */
import path from 'path';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = (process.argv[2] || 'TK01').toUpperCase();
const HANDLE = process.argv[3] || 'ryloclyjdcf';
const CANDS = (process.argv[4] || 'xnowmatrix').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page = null;
const out = { env: ENV, handle: HANDLE, results: [] };

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
  if (!ent) throw new Error('没找到 编辑资料 入口');
  await page.mouse.click(ent.x, ent.y);
  await sleep(4000);

  const fieldPos = async () =>
    page.evaluate(() => {
      const e = [...document.querySelectorAll('input')].find((x) => /username/i.test(x.getAttribute('placeholder') || ''));
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
  const state = async () =>
    page.evaluate(() => {
      const e = [...document.querySelectorAll('input')].find((x) => /username/i.test(x.getAttribute('placeholder') || ''));
      const save = [...document.querySelectorAll('button')].find((b) => /^(save|保存)$/i.test(String(b.textContent || '').trim()));
      // 用户名下方那行红字/提示
      let hint = '';
      let n = e;
      for (let i = 0; i < 4 && n; i++) {
        n = n.parentElement;
        if (!n) break;
        const t = String(n.innerText || '').replace(/\s+/g, ' ').trim();
        const m = t.match(/(available|contain|invalid|taken|使用|不可用|只能)[^.]{0,120}/i);
        if (m) hint = m[0];
      }
      return {
        value: e ? String(e.value || '') : '',
        invalid: e ? e.getAttribute('aria-invalid') : '',
        saveDisabled: save ? save.disabled : null,
        hint,
      };
    });

  const pos = await fieldPos();
  if (!pos) throw new Error('没找到用户名输入框');
  for (const cand of CANDS) {
    await page.mouse.click(pos.x, pos.y);
    await sleep(300);
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await sleep(150);
    await page.keyboard.type(cand, { delay: 50 }).catch(() => {});
    await sleep(5000);
    const st = await state();
    out.results.push({ cand, ...st, ok: st.invalid !== 'true' && st.saveDisabled === false });
  }
  // 还原成原来的用户名（不保存，直接取消）
  await page.mouse.click(pos.x, pos.y);
  await sleep(200);
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  await page.keyboard.type(HANDLE, { delay: 40 }).catch(() => {});
  await sleep(500);
  const cancel = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^(cancel|取消)$/i.test(String(x.textContent || '').trim()));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (cancel) {
    await page.mouse.click(cancel.x, cancel.y);
    out.cancelled = true;
  }
  await sleep(800);
} catch (e) {
  out.error = String(e && e.message ? e.message : e);
} finally {
  if (page) await closeFoxPage(ENV, API).catch(() => {});
  console.log(JSON.stringify(out, null, 1));
}
