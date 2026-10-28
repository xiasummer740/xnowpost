/** 只看当前页面（不跳转）：把「编辑资料」弹窗里的输入框/按钮/文字全部 dump 出来 */
import fs from 'fs';
import { openFoxPage } from '../src/collector/foxpw.js';

const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = (process.argv[2] || 'TK09').toUpperCase();

const opened = await openFoxPage(ENV, API);
const page = opened.page;
const out = await page.evaluate(() => {
  const q = (s) => [...document.querySelectorAll(s)];
  const info = (el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      name: el.getAttribute('name') || '',
      placeholder: el.getAttribute('placeholder') || '',
      dataE2e: el.getAttribute('data-e2e') || '',
      value: String(el.value ?? '').slice(0, 40),
      w: Math.round(r.width),
      h: Math.round(r.height),
      visible: r.width > 20 && r.height > 8,
    };
  };
  return {
    url: location.href,
    title: document.title,
    hasEntrance: q('[data-e2e="edit-profile-entrance"]').map(info),
    inputs: q('input,textarea').filter((e) => { const r = e.getBoundingClientRect(); return r.width > 60 && r.height > 10; }).map(info),
    textareas: q('textarea').map(info),
    buttons: q('button,[role="button"]').map((e) => String(e.textContent || '').trim()).filter(Boolean).slice(0, 20),
    dialogText: (() => {
      const t = String(document.body.innerText || '').replace(/\s+/g, ' ');
      const i = t.indexOf('Edit profile');
      return i >= 0 ? t.slice(i, i + 300) : t.slice(0, 300);
    })(),
  };
});
console.log(JSON.stringify(out, null, 1));
// 故意不关环境：留着现场给用户看
