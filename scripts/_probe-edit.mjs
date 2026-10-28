/**
 * 一次性排查脚本：复现「改资料保存了但没生效」，把弹窗/提示/读回全部打出来。
 * 用法：node scripts/_probe-edit.mjs TK02
 * 产出：控制台 JSON + %TEMP%\xnow-probe\*.png
 */
import fs from 'fs';
import path from 'path';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = (process.argv[2] || 'TK02').toUpperCase();
const DATA = process.env.APPDATA ? path.join(process.env.APPDATA, 'xnowpost') : '.';
const STATE = JSON.parse(fs.readFileSync(path.join(DATA, 'data', 'env-accounts.json'), 'utf8'));
const SHOT = path.join(process.env.TEMP || '.', 'xnow-probe');
fs.mkdirSync(SHOT, { recursive: true });

const TARGET = {
  TK01: { name: 'XNOW·涨粉与起号 | 粉丝 养号 破百', bio: '🔥涨粉不是玄学 起号有顺序\n📈养号 | 破百 | 粉丝从0起\n🎯播放与粉丝 每条都记\n💬微信 xnow-fans\n👇 xnow.taikon.top' },
  TK02: { name: 'XNOW·播放量上不去 | 曝光 限流 上热门', bio: '🌐播放量上不去 先查三件事\n📉限流曝光上热门 拆开看\n🔍每条都对比 数据说话\n💬微信 xnow-fans\n👇 xnow.taikon.top' },
  TK03: { name: 'XNOW·点赞评论少 | 互动 完播 评论区', bio: '📡点赞评论少 问题在开头三秒\n🎬完播 | 互动 | 评论区\n🧪同一条视频 两版钩子对比\n👇 xnow.taikon.top' },
  TK05: { name: 'XNOW·直播网络 | 专线 开播 推流 掉帧', bio: '🔥直播卡顿 多半是线路问题\n📡专线 | 推流 | 掉帧 实测\n🎥开播前 检查清单\n💬微信 xnow-fans\n👇 xnow.taikon.top' },
  TK06: { name: 'XNOW·多账号矩阵 | 环境 IP 防关联', bio: '🧩十个号 不关联的关键\n🌐环境 | IP | 登录态 隔离\n📦矩阵不是复制 是分工\n👇 xnow.taikon.top' },
};
const SEL = {
  name: 'input[placeholder="Name"]',
  bio: 'textarea[data-e2e="edit-profile-bio-input"]',
  username: 'input[placeholder="Username"]',
  TK03: { name: 'XNOW·点赞评论少 | 互动 完播 评论区', bio: '📡点赞评论少 问题在开头三秒\n🎬完播 | 互动 | 评论区\n🧪同一条视频 两版钩子对比\n👇 xnow.taikon.top' },
  TK05: { name: 'XNOW·直播网络 | 专线 开播 推流 掉帧', bio: '🔥直播卡顿 多半是线路问题\n📡专线 | 推流 | 掉帧 实测\n🎥开播前 检查清单\n💬微信 xnow-fans\n👇 xnow.taikon.top' },
  TK06: { name: 'XNOW·多账号矩阵 | 环境 IP 防关联', bio: '🧩十个号 不关联的关键\n🌐环境 | IP | 登录态 隔离\n📦矩阵不是复制 是分工\n👇 xnow.taikon.top' },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readProfilePage(page) {
  return page.evaluate(() => {
    const t1 = document.querySelector('[data-e2e="user-title"]');
    const sub = document.querySelector('[data-e2e="user-subtitle"]');
    const bio = document.querySelector('[data-e2e="user-bio"]');
    return {
      name: t1 ? (t1.textContent || '').trim() : '',
      handle: sub ? (sub.textContent || '').trim().replace(/^@/, '') : '',
      bio: bio ? (bio.textContent || '').trim() : '',
      url: location.href,
    };
  });
}

async function clickButton(page, texts, opts = {}) {
  const { scope = 'dialog', prefer = 'largest' } = opts;
  const box = await page.evaluate(
    ({ texts, scope, prefer }) => {
      const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
      const wants = texts.map(norm);
      const nameInput = document.querySelector('input[placeholder="Name"]');
      let root = document.body;
      if (scope === 'dialog' && nameInput) {
        let el = nameInput.parentElement;
        while (el && el !== document.body) {
          const cls = String(el.className || '');
          const role = el.getAttribute && el.getAttribute('role');
          if (role === 'dialog' || /Modal|Dialog/i.test(cls)) { root = el; break; }
          el = el.parentElement;
        }
      }
      const diag = [];
      const good = [];
      for (const el of root.querySelectorAll('button,div,span,a,li')) {
        if (!wants.includes(norm(el.textContent))) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 28 || r.height < 15 || r.width > 520 || r.height > 120) continue;
        const disabled = el.disabled === true || /disabled/i.test(String(el.className || '')) || el.getAttribute('aria-disabled') === 'true';
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const inView = cx > 2 && cy > 2 && cx < window.innerWidth - 2 && cy < window.innerHeight - 2;
        const top = inView ? document.elementFromPoint(cx, cy) : null;
        const hit = !!(top && (top === el || el.contains(top) || top.contains(el)));
        const item = { x: cx, y: cy, area: r.width * r.height, text: String(el.textContent || '').trim(), disabled, inView, hit };
        diag.push(item);
        if (inView && hit) good.push(item);
      }
      const pick = (arr) => (arr.length ? arr.sort((a, b) => (prefer === 'smallest' ? a.area - b.area : b.area - a.area))[0] : null);
      const chosen = pick(good);
      if (chosen) return { ...chosen, ok: true, diag };
      return diag.length ? { ...pick(diag), ok: false, diag } : { ok: false, diag };
    },
    { texts, scope, prefer },
  );
  if (box.ok) await page.mouse.click(box.x, box.y);
  return { ...box, clicked: !!box.ok };
}

async function setField(page, sel, text) {
  const loc = page.locator(sel);
  await loc.click({ timeout: 15000 });
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type(text);
  await page.waitForTimeout(400);
  let got = await page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? String(el.value ?? el.textContent ?? '') : null;
  }, sel);
  if (String(got || '').trim() !== String(text).trim()) {
    await loc.click({ timeout: 15000 }).catch(() => {});
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText(text);
    await page.waitForTimeout(400);
    got = await page.evaluate((s) => {
      const el = document.querySelector(s);
      return el ? String(el.value ?? el.textContent ?? '') : null;
    }, sel);
  }
  return got;
}

/** 弹窗里的全部可见文字（含错误提示）+ 各输入框当前值 + Save 状态 */
async function dumpDialog(page) {
  return page.evaluate(() => {
    const nameInput = document.querySelector('input[placeholder="Name"]');
    const bio = document.querySelector('textarea[data-e2e="edit-profile-bio-input"]');
    const user = document.querySelector('input[placeholder="Username"]');
    let root = document.body;
    if (nameInput) {
      let el = nameInput.parentElement;
      while (el && el !== document.body) {
        const cls = String(el.className || '');
        if ((el.getAttribute && el.getAttribute('role') === 'dialog') || /Modal|Dialog/i.test(cls)) { root = el; break; }
        el = el.parentElement;
      }
    }
    const txt = (root.innerText || '').replace(/\s+/g, ' ').trim();
    const saves = [];
    for (const el of root.querySelectorAll('button,div,span')) {
      const t = String(el.textContent || '').trim();
      if (t !== 'Save' && t !== '保存') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 12) continue;
      saves.push({
        text: t,
        w: Math.round(r.width),
        h: Math.round(r.height),
        disabled: el.disabled === true || /disabled/i.test(String(el.className || '')) || el.getAttribute('aria-disabled') === 'true',
      });
    }
    return {
      modalOpen: !!nameInput,
      rootTag: root.tagName + '.' + String(root.className || '').slice(0, 40),
      nameValue: nameInput ? nameInput.value : null,
      bioValue: bio ? bio.value : null,
      usernameValue: user ? user.value : null,
      saves,
      dialogText: txt.slice(0, 700),
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
    };
  });
}

const handle = String((STATE[ENV] || {}).username || '').trim();
const want = TARGET[ENV] || { name: 'probe', bio: 'probe' };
const out = { env: ENV, handle, steps: [] };
let page = null;

try {
  const opened = await openFoxPage(ENV, API);
  page = opened.page;

  await page.goto(`https://www.tiktok.com/@${encodeURIComponent(handle)}`, { waitUntil: 'commit' });
  await sleep(6000);
  out.before = await readProfilePage(page);
  await page.screenshot({ path: path.join(SHOT, `${ENV}-1-profile.png`) }).catch(() => {});

  const entry = await clickButton(page, ['Edit profile', '编辑资料'], { scope: 'page' });
  out.entry = { ...entry, diag: (entry.diag || []).slice(0, 6) };
  if (!entry.clicked) {
    const ok2 = await page.locator('[data-e2e="edit-profile-entrance"]').click({ timeout: 15000 }).then(() => true).catch(() => false);
    out.entryFallback = ok2;
  }
  await sleep(2500);
  await page.screenshot({ path: path.join(SHOT, `${ENV}-2-modal.png`) }).catch(() => {});
  out.afterOpen = await dumpDialog(page);

  const nameGot = await setField(page, SEL.name, want.name);
  const bioGot = await setField(page, SEL.bio, want.bio);
  await sleep(600);
  out.typed = { nameGot, bioGot, wantName: want.name };
  await page.screenshot({ path: path.join(SHOT, `${ENV}-3-typed.png`) }).catch(() => {});
  out.beforeSave = await dumpDialog(page);

  const save = await clickButton(page, ['Save', '保存'], { scope: 'dialog', prefer: 'largest' });
  out.save = { ...save, diag: (save.diag || []).slice(0, 8) };

  const SIG = /Set nickname\?|Change nickname\?|Set username\?|Change username\?|change your nickname once every 7 days|Changing your nickname|Changing your username|昵称.{0,8}(7|七)\s*天|用户名.{0,8}(30|三十)\s*天/i;
  out.dialogSteps = [];
  for (let i = 0; i < 12; i++) {
    await sleep(1200);
    const st = await page.evaluate(() => ({
      txt: String(document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
      nameInput: !!document.querySelector('input[placeholder="Name"]'),
    }));
    const hit = SIG.test(st.txt);
    const step = { i, modalOpen: st.nameInput, sig: hit, txt: st.txt.slice(0, 220) };
    if (hit) {
      await page.screenshot({ path: path.join(SHOT, `${ENV}-4a-confirm-${i}.png`) }).catch(() => {});
      const c = await clickButton(page, ['Confirm', '确认', '确定'], { scope: 'page', prefer: 'smallest' });
      step.clicked = c && c.clicked;
      step.clickInfo = c ? { text: c.text, x: Math.round(c.x), y: Math.round(c.y), area: c.area } : null;
      step.diag = (c && c.diag ? c.diag : []).slice(0, 5);
    }
    out.dialogSteps.push(step);
    if (!hit && !st.nameInput) break;
  }
  await page.screenshot({ path: path.join(SHOT, `${ENV}-4-after-save.png`) }).catch(() => {});
  out.afterSave = await dumpDialog(page);

  await page.goto(`https://www.tiktok.com/@${encodeURIComponent(handle)}`, { waitUntil: 'commit' });
  await sleep(6000);
  out.after = await readProfilePage(page);
  await page.screenshot({ path: path.join(SHOT, `${ENV}-5-after-profile.png`) }).catch(() => {});
} catch (e) {
  out.error = String(e && e.message ? e.message : e);
} finally {
  if (page) await closeFoxPage(ENV, API).catch(() => {});
  console.log(JSON.stringify(out, null, 1));
}
