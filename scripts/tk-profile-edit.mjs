/**
 * 修改 TikTok 账号资料：头像 / 名字（昵称）/ 用户名 / 个人简介
 *
 * 用法：
 *   node scripts/tk-profile-edit.mjs --only TK01 --name "Cora" --bio "UK lifestyle" --avatar D:\\img\\a.jpg
 *   node scripts/tk-profile-edit.mjs --only TK01 --name "Cora" --dry-run     # 只填不保存（推荐先跑）
 *   node scripts/tk-profile-edit.mjs --job C:\\path\\jobs.json                # 批量（界面走这条）
 *
 * job 文件格式：
 *   { "dryRun": false, "jobs": [ { "env":"TK01", "name":"...", "bio":"...",
 *                                 "newUsername":"...", "avatar":"C:\\a.jpg" } ] }
 *   字段缺省 = 不改那一项。
 *
 * 平台限制（网页版实测）：
 * - 用户名全站唯一，通常 30 天改一次；
 * - 昵称（Name）7 天才能改一次；
 * - 简介最多 80 字。
 *
 * 判定成败的方式：**保存后回主页读回头像 URL / 昵称 / 简介**，一致才算成功。
 * 不靠页面上的错误文案猜（TikTok 的 class 名里带 error 的容器到处都是，之前误判过）。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';
import { avatarReadbackPlan, avatarRetryDelayMs } from '../src/avatar-verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const APP_DATA = process.env.APPDATA ? path.join(process.env.APPDATA, 'xnowpost') : path.join(ROOT, 'runtime');
const CFG_FILE = path.join(APP_DATA, 'config', 'user.json');
const STATE_FILE = path.join(APP_DATA, 'data', 'env-accounts.json');
const PROFILES_FILE = path.join(APP_DATA, 'data', 'account-profiles.json');
const AVATAR_DIR = path.join(APP_DATA, 'data', 'avatars');
const SHOT_DIR = process.env.XNOWPOST_SHOTS || path.join(APP_DATA, 'output', 'edit-shots');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = '') => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const ONLY = val('--only').toUpperCase();
const JOB_FILE = val('--job');
const DRY = has('--dry-run');
const GAP = Number(val('--gap', '4')) || 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) || {};
  } catch (_) {
    return {};
  }
};
const writeJson = (f, o) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(o, null, 2));
};

const SEL = {
  name: 'input[placeholder="Name"]',
  bio: 'textarea[data-e2e="edit-profile-bio-input"]',
  username: 'input[placeholder="Username"]',
  file: 'input[type=file]',
};

/** 页面可见元素的存在性查询（带尺寸过滤，TikTok 有很多不可见的同名元素） */
async function visible(page, sel, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await page
      .evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 40 && r.height > 15;
      }, sel)
      .catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(700);
  }
  return false;
}

/**
 * 在弹窗范围内按文字点按钮。
 * scope='dialog' 只找「包含 Name 输入框的那个弹窗」内的元素，避免点到背后的主页按钮。
 *
 * 为什么要做 elementFromPoint 校验：TikTok 会同时渲染桌面/移动/隐藏的多份按钮，
 * 它们都有非零尺寸（只是被移出视口或被遮住），按坐标点下去等于点空 —— 之前头像
 * 「已上传但没保存」就是点到隐藏副本上。这里要求「这一点最上层的元素确实是我」。
 */
async function clickButton(page, texts, opts = {}) {
  const { scope = 'dialog', prefer = 'largest', mustBeEnabled = false } = opts;
  const box = await page.evaluate(
    ({ texts, scope, prefer, mustBeEnabled }) => {
      const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
      const wants = texts.map(norm);
      const nameInput = document.querySelector('input[placeholder="Name"]');
      let root = document.body;
      if (scope === 'dialog' && nameInput) {
        let el = nameInput.parentElement;
        while (el && el !== document.body) {
          const cls = String(el.className || '');
          const role = el.getAttribute && el.getAttribute('role');
          if (role === 'dialog' || /Modal|Dialog/i.test(cls)) {
            root = el;
            break;
          }
          el = el.parentElement;
        }
      }
      const diag = [];
      const good = [];
      for (const el of root.querySelectorAll('button,div,span,a,li')) {
        const t = norm(el.textContent);
        if (!wants.includes(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 28 || r.height < 15 || r.width > 520 || r.height > 120) continue;
        const disabled =
          el.disabled === true ||
          /disabled/i.test(String(el.className || '')) ||
          el.getAttribute('aria-disabled') === 'true';
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const inView = cx > 2 && cy > 2 && cx < window.innerWidth - 2 && cy < window.innerHeight - 2;
        // 这一点的最上层元素必须落在候选元素内部（否则说明它被遮住或是隐藏副本）
        const top = inView ? document.elementFromPoint(cx, cy) : null;
        const hit = !!(top && (top === el || el.contains(top) || top.contains(el)));
        const item = { x: cx, y: cy, area: r.width * r.height, text: String(el.textContent || '').trim(), disabled, inView, hit };
        diag.push(item);
        if (inView && hit && (!mustBeEnabled || !disabled)) good.push(item);
      }
      const pick = (arr) => {
        if (!arr.length) return null;
        arr.sort((a, b) => (prefer === 'smallest' ? a.area - b.area : b.area - a.area));
        return arr[0];
      };
      const chosen = pick(good);
      if (chosen) return { ...chosen, ok: true };
      // 没通过校验：把候选情况带回去，方便看日志判断是「隐藏副本」还是「按钮本来就灰」
      if (diag.length) return { ...pick(diag), ok: false };
      return null;
    },
    { texts, scope, prefer, mustBeEnabled },
  );
  if (!box) return null;
  if (!box.ok) {
    // 被遮住/隐藏/禁用，点了也没用，直接告诉调用方
    return { ...box, clicked: false };
  }
  await page.mouse.click(box.x, box.y);
  return { ...box, clicked: true };
}

/** 读回指定控件的值 */
async function readField(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? String(el.value ?? el.textContent ?? '') : null;
  }, sel);
}

/** 填一个输入框：点进去 → 全选 → 删除 → 逐字符输入；读回不一致再整体插入一次 */
async function setField(page, sel, text) {
  const loc = page.locator(sel);
  await loc.click({ timeout: 15000 });
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(120);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(120);
  await page.keyboard.type(text);
  await page.waitForTimeout(400);
  let got = await readField(page, sel);
  if (String(got || '').trim() !== String(text).trim()) {
    await loc.click({ timeout: 15000 }).catch(() => {});
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText(text);
    await page.waitForTimeout(400);
    got = await readField(page, sel);
  }
  return got;
}

/** 头像地址去掉签名参数再比：TikTok 的 refresh_token / x-signature 每次都不一样，整串比会永远「已变」 */
const avatarKey = (u) => String(u || '').split('?')[0];

const AVATAR_READBACK_TIMEOUT_MS = 45000;

/**
 * 保存后「等头像真的生效」。
 *
 * 2026-10-19 实测：点完 Save 立刻读主页，TikTok 还没刷新 → 4 个号里 3 个被误判成
 * 「头像地址没变（大概率没真正保存）」，其实全成功了。所以这里改成反复读主页，
 * 读到头像 URL 变了就收工，最多等 45 秒。
 */
async function waitAvatarEffective(page, beforeUrl, username) {
  const t0 = Date.now();
  let attempt = 0;
  for (;;) {
    attempt++;
    const cur = await readProfilePage(page).catch(() => ({ avatar: '' }));
    const plan = avatarReadbackPlan({
      beforeUrl,
      afterUrl: cur.avatar,
      elapsedMs: Date.now() - t0,
      timeoutMs: AVATAR_READBACK_TIMEOUT_MS,
    });
    if (plan.reason === 'changed') {
      console.log(`     ✅ 头像已生效（第 ${attempt} 次复查，用时 ${Math.round((Date.now() - t0) / 1000)}s）`);
      return { changed: true, page: cur, waits: attempt };
    }
    if (plan.done) {
      console.log(`     ⚠️ ${Math.round(AVATAR_READBACK_TIMEOUT_MS / 1000)} 秒内没读到新头像地址（可能只是延迟，稍后点「拉取资料」再看）`);
      return { changed: false, page: cur, waits: attempt };
    }
    const delay = avatarRetryDelayMs(attempt);
    console.log(`     ⏳ 头像还没刷新，${Math.round(delay / 1000)}s 后复查（第 ${attempt} 次）`);
    await sleep(delay);
    // 重新进主页：TikTok 的头像走的是另一个接口，S PA 不导航往往不重取
    await page
      .goto(`https://www.tiktok.com/@${encodeURIComponent(username)}?lang=en`, { waitUntil: 'commit' })
      .catch(() => {});
    await sleep(2500);
  }
}

/** 把线上真实头像下载下来（TikTok 已裁成 200x200 方图），界面缩略图才和真号一致 */
async function downloadAvatar(url, env) {
  if (!url) return '';
  try {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    const res = await fetch(url);
    if (!res.ok) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) return '';
    const dest = path.join(AVATAR_DIR, `${env}.jpg`);
    fs.writeFileSync(dest, buf);
    const other = path.join(AVATAR_DIR, `${env}.png`);
    if (fs.existsSync(other)) fs.rmSync(other, { force: true });
    return dest;
  } catch (_) {
    return '';
  }
}

/** 读主页三件套 + 头像地址 */
/**
 * 保存后的「二次确认」。
 *
 * 2026-10-20 实测（TK01/TK02）：点完 Save，编辑资料弹窗会先关掉，紧接着 TikTok 再弹一层
 *   「Set nickname?」「You can only change your nickname once every 7 days」+ Cancel / Confirm
 * 不点 Confirm 就等于放弃改动 —— 弹窗已经关了，看起来像成功，实际一个字段都没保存。
 * 这个脚本以前只等「编辑弹窗关闭」就去年读主页，所以每次都读回旧值。
 *
 * 只在这种**明确签名**的确认框上点 Confirm；其它弹窗（放弃作品、未知框）一律不碰。
 */
const CONFIRM_SIG =
  /Set (?:your )?nickname\?|Change (?:your )?nickname\?|Set (?:your )?username\?|Change (?:your )?username\?|change your nickname once every 7 days|change your username once every 30 days|Changing your nickname|Changing your username|昵称.{0,8}(7|七)\s*天|用户名.{0,8}(30|三十)\s*天/i;

async function readConfirmSig(page) {
  return page
    .evaluate((src) => {
      const re = new RegExp(src, 'i');
      const txt = String(document.body.innerText || '').replace(/\s+/g, ' ');
      return re.test(txt) ? txt.slice(0, 240) : '';
    }, CONFIRM_SIG.source)
    .catch(() => '');
}

async function confirmSavePrompts(page, maxWaitMs = 12000) {
  const confirmed = [];
  let locked = false;
  const t0 = Date.now();
  let clicks = 0;
  while (Date.now() - t0 < maxWaitMs) {
    const sig = await readConfirmSig(page);
    if (!sig) {
      if (confirmed.length) break; // 确认过且框没了 = 收工
      // 前 4 秒没出现就认为这次改动不需要二次确认（只改简介时通常不弹）
      if (Date.now() - t0 > 4000) break;
      await page.waitForTimeout(600);
      continue;
    }
    if (clicks >= 2) break; // 最多点两次，绝不连环点
    const c = await clickButton(page, ['Confirm', '确认', '确定'], { scope: 'page', prefer: 'smallest' });
    if (!c || !c.clicked) {
      await page.waitForTimeout(800);
      continue;
    }
    clicks++;
    confirmed.push(String(sig).slice(0, 60));
    // 点完只等「框消失」，不再无条件补点第二下。
    // 2026-10-20 事故：旧版每 1.5 秒再点一次 Confirm，第二下把「刚改过的昵称」又提交一遍，
    // TikTok 于是弹「You can't change your nickname because you just changed it in the last 7 days」——
    // 那是我们自己点出来的假警报，第一次其实已经改成功（TK06 就是这样：日志报失败，主页已是新昵称）。
    let gone = false;
    for (let i = 0; i < 6 && !gone; i++) {
      await page.waitForTimeout(1000);
      gone = !(await readConfirmSig(page));
    }
    if (!gone) continue; // 框还在 = 可能真有第二层确认，允许再点一次
    const refused = await page
      .evaluate(() => {
        const t = String(document.body.innerText || '').replace(/\s+/g, ' ');
        return /can'?t change your nickname|can not change your nickname|昵称.{0,12}(不能|无法).{0,6}(改|修改)/i.test(t)
          ? t.slice(0, 200)
          : '';
      })
      .catch(() => '');
    if (refused) {
      locked = true;
      console.log('     ⚠️ TikTok 拒绝改昵称：7 天内已经改过一次（本次昵称不会生效）');
    }
    break;
  }
  return { confirmed, locked };
}

/**
 * 打开「编辑资料」弹窗，最多试 3 次。
 *
 * 2026-10-20 实测：主路径按文字点 Edit profile 有时点不到（页面上有两份同名按钮 +
 * 隐藏在视口外的副本），以前靠一次兜底 locator，兜底也失败就整号判死
 * （TK06 连续两次「编辑资料弹窗没出现」，其实再点一次就开）。
 * 现在：规范选择器优先 → 文字兜底 → 都没开就等 1.5 秒重试，最多 3 轮。
 */
/**
 * 打开页面，被"另一次导航"打断时重试。
 * 2026-10-20 实测：头像上传/保存后紧接着 goto，FoxProfile 那边上一跳还没落地，
 * 就报 `NS_BINDING_ABORTED` / `NS_ERROR_CONNECTION_REFUSED` —— 5 个号因为这一句被判失败，
 * 其实头像已经换好了（只是没走到回读）。重试 3 次即可，别把它当成号坏了。
 */
/** 轮询等 Save 变亮（TikTok 改用户名时有异步可用性校验） */
async function waitSaveEnabled(page, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await page
      .evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /^(save|保存)$/i.test(String(x.textContent || '').trim()));
        return b ? !!b.disabled : null;
      })
      .catch(() => null);
    if (st === false) return true;
    await sleep(600);
  }
  return false;
}

async function gotoSafe(page, url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      await page.goto(url, { waitUntil: 'commit' });
      return true;
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (i === tries) throw e;
      console.log(`     ↻ 页面打开被打断（${msg.slice(0, 40)}…），2 秒后重试`);
      await sleep(2000);
    }
  }
  return false;
}

async function openEditModal(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await visible(page, SEL.bio, 800)) return { ok: true, attempt, how: 'already-open' };
    let how = '';
    const loc = page.locator('[data-e2e="edit-profile-entrance"]');
    const n = await loc.count().catch(() => 0);
    if (n > 0) {
      const ok1 = await loc.click({ timeout: 12000 }).then(() => true).catch(() => false);
      if (ok1) how = 'entrance';
    }
    if (!how) {
      const e = await clickButton(page, ['Edit profile', '编辑资料'], { scope: 'page' });
      if (e && e.clicked) how = 'text';
    }
    if (how && (await visible(page, SEL.bio, 20000))) return { ok: true, attempt, how };
    await sleep(1500);
  }
  return { ok: false };
}

async function readProfilePage(page) {
  return page.evaluate(() => {
    const t1 = document.querySelector('[data-e2e="user-title"]');
    const sub = document.querySelector('[data-e2e="user-subtitle"]');
    const bio = document.querySelector('[data-e2e="user-bio"]');
    const av = document.querySelector('img[class*="ImgAvatar"]') || document.querySelector('img.user-avatar');
    return {
      name: t1 ? (t1.textContent || '').trim() : '',
      handle: sub ? (sub.textContent || '').trim().replace(/^@/, '') : '',
      bio: bio ? (bio.textContent || '').trim() : '',
      avatar: av ? av.getAttribute('src') || '' : '',
    };
  });
}

/** 弹窗内的提示文字（只在「名字被限制」这类场景用，长度卡住，避免抓到页面正文） */
async function readDialogNotes(page) {
  return page.evaluate(() => {
    const nameInput = document.querySelector('input[placeholder="Name"]');
    if (!nameInput) return [];
    let root = document.body;
    let el = nameInput.parentElement;
    while (el && el !== document.body) {
      const cls = String(el.className || '');
      if ((el.getAttribute && el.getAttribute('role') === 'dialog') || /Modal|Dialog/i.test(cls)) {
        root = el;
        break;
      }
      el = el.parentElement;
    }
    const out = [];
    for (const node of root.querySelectorAll('div,span,p,label')) {
      if (node.children.length > 2) continue;
      const t = (node.textContent || '').trim();
      if (!t || t.length > 90) continue;
      const r = node.getBoundingClientRect();
      if (r.width < 10 || r.height < 6) continue;
      if (!/[a-z]{3,}/i.test(t)) continue;
      out.push(t);
    }
    return [...new Set(out)].slice(0, 12);
  });
}

/** 等裁剪框消失（Apply 之后会有一小段过渡，太早点 Save 会点空） */
async function waitNoCropDialog(page, ms = 12000) {  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const still = await page
      .evaluate(() => {
        const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
        for (const el of document.querySelectorAll('button,div,span')) {
          if (!['apply', '应用', 'next', '下一步'].includes(norm(el.textContent))) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 28 && r.height > 15 && r.width < 520) return true;
        }
        return false;
      })
      .catch(() => false);
    if (!still) return true;
    await page.waitForTimeout(700);
  }
  return false;
}

/** 上传/裁剪是否还在处理中（有 loading 圈、进度条就别急着保存） */
async function waitUploadSettled(page, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const busy = await page
      .evaluate(() => {
        const sels = ['[class*="loading"]', '[class*="Loading"]', '[class*="spinner"]', '[role="progressbar"]', '[class*="Uploading"]'];
        for (const s of sels) {
          for (const el of document.querySelectorAll(s)) {
            const r = el.getBoundingClientRect();
            if (r.width > 8 && r.height > 6) return true;
          }
        }
        return false;
      })
      .catch(() => false);
    if (!busy) return true;
    await page.waitForTimeout(800);
  }
  return false;
}

function buildJobs() {
  if (JOB_FILE) {
    const spec = readJson(JOB_FILE);
    const list = Array.isArray(spec.jobs) ? spec.jobs : [];
    return { dryRun: DRY || !!spec.dryRun, jobs: list };
  }
  const name = val('--name');
  const bio = val('--bio');
  const newUsername = val('--username');
  const avatar = val('--avatar');
  if (!ONLY) throw new Error('要么用 --job 给批量任务，要么用 --only TK01 指定单个环境');
  if (!name && !bio && !newUsername && !avatar) throw new Error('没有要改的字段（--name / --bio / --username / --avatar）');
  return { dryRun: DRY, jobs: [{ env: ONLY, name, bio, newUsername, avatar }] };
}

async function main() {
  const { dryRun, jobs } = buildJobs();
  const state = readJson(STATE_FILE);
  const cfg = readJson(CFG_FILE);
  const profiles = readJson(PROFILES_FILE);

  const targets = jobs
    .map((j) => {
      const env = String(j.env || '').toUpperCase();
      const acc =
        (cfg.accounts || []).find((a) => String(a.bitEnvId || a.browserEnv || '').toUpperCase() === env) || {};
      const username = String((state[env] || {}).username || acc.username || '').trim();
      return { ...j, env, username };
    })
    .filter((j) => j.env);

  console.log('');
  console.log('  ═══ TikTok 账号资料修改 ═══');
  console.log(`  FoxProfile: ${API}`);
  console.log(`  目标 ${targets.length} 个环境${dryRun ? '（演练：只填不保存）' : ''}`);
  for (const t of targets) {
    const parts = [];
    if (t.avatar) parts.push('头像');
    if (t.name) parts.push(`名字=${t.name}`);
    if (t.newUsername) parts.push(`改名→${t.newUsername}`);
    if (t.bio) parts.push(`简介=${String(t.bio).slice(0, 20)}${String(t.bio).length > 20 ? '…' : ''}`);
    console.log(`   · ${t.env} @${t.username || '?'} → ${parts.join(' / ') || '（无改动，跳过）'}`);
  }
  console.log('');

  if (!targets.length) {
    console.log('  没有目标环境');
    return;
  }

  let ok = 0;
let failedLike = 0; // 保存成功但头像内容没变（假成功），单列一类
  let bad = 0;
  let skipped = 0;

  for (const t of targets) {
    const todo = Boolean(t.name || t.bio || t.newUsername || t.avatar);
    if (!todo) {
      skipped++;
      continue;
    }
    if (!t.username) {
      console.log(`  ❌ ${t.env} 不知道用户名（先在账号页导入账号文件或登录一次）`);
      bad++;
      continue;
    }
    console.log(`  ── ${t.env} @${t.username} ──`);
    let page = null;
    let shot = '';
    try {
      const opened = await openFoxPage(t.env, API);
      page = opened.page;

      // 0) 先记下改动前的头像/昵称，保存后要靠它判断到底成没成
      await gotoSafe(page, `https://www.tiktok.com/@${encodeURIComponent(t.username)}`);
      await sleep(6000);
      const before = await readProfilePage(page);
      if (!before.handle) {
        console.log('     ⚠️ 主页没读到用户名，可能没登录或页面没加载完，继续尝试');
      }

      // 1) 打开「编辑资料」（规范选择器优先 → 文字兜底 → 重试，最多 3 轮）
      const opened2 = await openEditModal(page);
      if (!opened2.ok) throw new Error('编辑资料弹窗没出现（入口点了 3 次都没打开）');
      if (opened2.attempt > 1) console.log(`     入口重试第 ${opened2.attempt} 次才打开（${opened2.how}）`);

      // 1.5) 先给「现在的头像」拍个指纹：换完头像后文件哈希必须变，否则等于没换。
      //      2026-10-20 事故：TK03/TK06/TK10 报「✅ 头像已生效」（只比了 URL，签名参数每跳都变），
      //      实际头像还是那张老黄图 —— URL 变了不代表图变了。
      const avatarFile = path.join(process.env.APPDATA || '', 'xnowpost', 'data', 'avatars', `${t.env}.jpg`);
      const hashOf = (p) => {
        try {
          return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
        } catch {
          return '';
        }
      };
      const avatarHashBefore = hashOf(avatarFile);
      let avatarSuspect = false;
      // 2) 头像：上传 → 等裁剪框 → Apply → 等裁剪框消失
      if (t.avatar) {
        if (!fs.existsSync(t.avatar)) throw new Error(`头像文件不存在：${t.avatar}`);
        const fl = page.locator(SEL.file);
        if ((await fl.count()) === 0) throw new Error('页面里没有文件选择器，头像上传失败');
        await fl.setInputFiles(t.avatar);
        console.log('     已提交头像文件，等待处理…');
        await sleep(3000);

        // 裁剪框可能晚一点才出来，给它 8 秒
        let cropClicked = null;
        for (let i = 0; i < 10 && !cropClicked; i++) {
          const c = await clickButton(page, ['Apply', '应用', 'Next', '下一步'], { scope: 'page', prefer: 'largest' });
          if (c && c.clicked) cropClicked = c;
          else await sleep(800);
        }
        if (cropClicked) {
          console.log(`     裁剪确认: ${cropClicked.text}`);
          const gone = await waitNoCropDialog(page);
          if (!gone) console.log('     ⚠️ 裁剪框似乎还开着，稍后仍会尝试保存');
        } else {
          console.log('     没有出现裁剪框，直接进入保存');
        }
        const settled = await waitUploadSettled(page);
        console.log(settled ? '     头像处理完成' : '     ⚠️ 头像好像还在处理，仍会尝试保存');
        await sleep(800);
      }

      // 3) 名字
      // TikTok 改了弹窗：昵称进入 7 天冷却后，Name 输入框会**整个不渲染**（只剩一行提示
      // 「Your nickname can only be changed every 7 days. You can change it again after Oct 26, 2026.」），
      // 这时 page 里只有 Username input 和 Bio textarea。
      // 2026-10-20 事故：脚本还在等 input[placeholder="Name"]，于是 10 个号全报「弹窗没出现」，
      // 其实弹窗开着、只是没有昵称框（这些号刚改过昵称）。
      if (t.name) {
        const hasName = await visible(page, SEL.name, 3000);
        if (!hasName) {
          const when = await page
            .evaluate(() => {
              const t = String(document.body.innerText || '').replace(/\s+/g, ' ');
              const m = t.match(/change it again after ([A-Za-z]{3,9} \d{1,2}, \d{4})/i);
              return m ? m[1] : '';
            })
            .catch(() => '');
          t.nameSkipped = true;
          console.log(
            `     ⚠️ 昵称框不在（TikTok 7 天冷却${when ? `，${when} 之后可再改` : ''}）→ 本轮跳过昵称，继续改其它字段`,
          );
        } else {
          const got = await setField(page, SEL.name, t.name);
          if (String(got || '').trim() !== String(t.name).trim()) {
            throw new Error(`名字没写进去（读回「${got}」）`);
          }
          console.log(`     名字 → ${t.name}`);
        }
      }

      // 4) 用户名
      if (t.newUsername) {
        const got = await setField(page, SEL.username, t.newUsername);
        if (String(got || '').trim() !== String(t.newUsername).trim()) {
          throw new Error(`用户名没写进去（读回「${got}」）`);
        }
        console.log(`     用户名 → ${t.newUsername}`);
      }

      // 5) 简介
      if (t.bio) {
        const got = await setField(page, SEL.bio, t.bio);
        if (String(got || '').trim() !== String(t.bio).trim()) {
          throw new Error(`简介没写进去（读回「${String(got).slice(0, 30)}」）`);
        }
        console.log(`     简介 → ${String(t.bio).slice(0, 30)}${String(t.bio).length > 30 ? '…' : ''}`);
      }

      // 6) 演练：直接取消
      if (dryRun) {
        const c = await clickButton(page, ['Cancel', '取消'], { scope: 'dialog' });
        console.log(`  ✅ ${t.env} 演练完成（未保存${c && c.clicked ? '' : '，没找到可点的取消按钮，直接关环境'}）`);
        ok++;
        continue;
      }

      // 7) 保存：只点弹窗里那个「Save」，点完必须看到弹窗关闭，否则重试
      let closed = false;
      let lastNotes = [];
      for (let attempt = 1; attempt <= 3 && !closed; attempt++) {
        const saveBtn = await clickButton(page, ['Save', '保存'], { scope: 'dialog', prefer: 'largest' });
        if (!saveBtn) throw new Error('弹窗里没找到 Save 按钮');
        if (saveBtn.disabled) {
          // Save 是灰的有两种原因，必须分开：
          //  ① 值已经等于服务端（幂等重跑 / 上次已写进去但回读失败）→ 直接去核实；
          //  ② 改用户名时 TikTok 会做**异步可用性校验**（实测 ~3~5 秒），校验没回来之前按钮就是灰的。
          // 2026-10-20 踩过：填完 xnow.matrix 立刻看按钮 → 灰 → 当成"已经是目标值"，
          // 于是报「用户名已保存」其实一个字都没提交。
          const okLater = await waitSaveEnabled(page, 10000);
          if (okLater) {
            console.log('     等可用性校验通过后 Save 亮了，重试提交');
            continue;
          }
          console.log('     弹窗里已经是目标值（Save 一直灰）→ 直接去主页核实');
          closed = true;
          break;
        }
        if (!saveBtn.clicked) {
          console.log(`     ⚠️ 第 ${attempt} 次没点到 Save（按钮被遮住或不在视口内），重试`);
          await sleep(1200);
          continue;
        }
        console.log(`     已点保存${attempt > 1 ? `（第 ${attempt} 次）` : ''}，等待写入…`);

        const t0 = Date.now();
        while (Date.now() - t0 < 15000) {
          const open = await page
            .evaluate((s) => {
              const el = document.querySelector(s);
              if (!el) return false;
              const r = el.getBoundingClientRect();
              return r.width > 40 && r.height > 15;
            }, SEL.name)
            .catch(() => false);
          if (!open) {
            closed = true;
            break;
          }
          await page.waitForTimeout(800);
        }
        if (!closed) {
          lastNotes = await readDialogNotes(page);
          console.log(`     ⚠️ 弹窗还开着，稍后重试保存`);
          await sleep(1500);
        }
      }

      if (!closed) {
        shot = path.join(SHOT_DIR, `${t.env}-${Date.now()}.png`);
        try {
          fs.mkdirSync(SHOT_DIR, { recursive: true });
          const b64 = await page.screenshot();
          if (b64) fs.writeFileSync(shot, Buffer.from(b64, 'base64'));
        } catch (_) {
          /* 截图失败不影响结论 */
        }
        const hint = lastNotes.filter((n) => /only be changed|taken|try again|too many|can't|cannot|限制|不能|失败/i.test(n));
        throw new Error(
          `保存没成功（弹窗一直没关闭）${hint.length ? `：${hint.slice(0, 3).join(' / ')}` : ''}` +
            `${shot ? `（截图 ${shot}）` : ''}`,
        );
      }

      // 7.5) 保存后 TikTok 还会弹一层「Set nickname? … Cancel / Confirm」的二次确认。
      //      不点 Confirm = 放弃改动（弹窗已关，看起来成功，实际什么都没保存）。
      const cp = await confirmSavePrompts(page);
      if (cp.confirmed.length) {
        console.log(`     已点确认（${cp.confirmed.length} 层）：${cp.confirmed[0]}`);
      }

      // 8) 回主页读回校验（这是唯一可信的成功判据）
      const finalName = t.newUsername || t.username;
      await gotoSafe(page, `https://www.tiktok.com/@${encodeURIComponent(finalName)}?lang=en`);
      await sleep(7000);
      let after = await readProfilePage(page);

      // 头像单独处理：TikTok 有延迟，必须反复读到它变，不能读一次就判死
      let avatarChanged = false;
      if (t.avatar) {
        const r = await waitAvatarEffective(page, before.avatar, finalName);
        avatarChanged = r.changed;
        if (r.changed && r.page) after = { ...after, avatar: r.page.avatar };
      }

      const diffs = [];
      if (t.avatar && !avatarChanged) diffs.push('头像地址 45 秒内没变（可能只是延迟，稍后「拉取资料」可核实）');
      if (t.name && !t.nameSkipped && after.name !== t.name) diffs.push(`名字读回「${after.name}」`);
      if (t.bio && after.bio !== t.bio) diffs.push(`简介读回「${after.bio.slice(0, 24)}」`);
      if (t.newUsername && after.handle !== t.newUsername) diffs.push(`用户名读回「${after.handle}」`);

      // 昵称/简介/用户名的读回不一致要**反复读几次**才判失败。
      // 2026-10-20 事故：TK06 明明改成功（主页已是新昵称），这里读到的是旧的缓存页 → 误报失败，
      // 于是又白跑了两轮。所以：带随机参数重新打开（绕开缓存）+ 每次间隔 8 秒，最多读 3 次，
      // 3 次都还是旧值才认账。
      const hard = diffs.filter((d) => !d.startsWith('头像'));
      let lastStill = [];
      for (let i = 0; hard.length && i < 3; i++) {
        await sleep(8000);
        await gotoSafe(page, `https://www.tiktok.com/@${encodeURIComponent(finalName)}?lang=en&_r=${Date.now()}`).catch(() => {});
        await sleep(6000);
        const again = await readProfilePage(page);
        lastStill = [];
        if (t.name && !t.nameSkipped && again.name !== t.name) lastStill.push(`名字读回「${again.name}」`);
        if (t.bio && again.bio !== t.bio) lastStill.push(`简介读回「${again.bio.slice(0, 24)}」`);
        if (t.newUsername && again.handle !== t.newUsername) lastStill.push(`用户名读回「${again.handle}」`);
        if (!lastStill.length) {
          after = again;
          diffs.length = 0;
          break;
        }
      }
      if (lastStill.length) {
        // 三次都读到旧值才算真没写进去：不写本地缓存、不算成功（以前会既报 ⚠️ 又计 ✅）
        const why = cp.locked ? '（TikTok 提示：昵称 7 天内只能改一次，本轮昵称被拒）' : '';
        throw new Error(`保存后连读 3 次都不一致：${lastStill.join('，')}${why}${shot ? `（截图 ${shot}）` : ''}`);
      }

      if (diffs.length) {
        console.log(`  ⚠️ ${t.env} 已保存，但${diffs.join('，')}`);
      }

      // 9) 更新本地缓存
      const prev = profiles[t.env] || {};
      profiles[t.env] = {
        ...prev,
        username: t.newUsername || prev.username || t.username,
        nickname: after.name || t.name || prev.nickname || '',
        bio: after.bio || t.bio || prev.bio || '',
        avatarUrl: after.avatar || prev.avatarUrl || '',
        avatarAt: new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
      };
      writeJson(PROFILES_FILE, profiles);
      if (t.newUsername) {
        state[t.env] = { ...(state[t.env] || {}), username: t.newUsername };
        writeJson(STATE_FILE, state);
        // 配置文件里还有一份 username（`config/user.json` 的 accounts[].username）。
        // 2026-10-20 漏过这里：TK01 改名成 xnow.matrix 后只有 env-accounts 变了，
        // 采集器仍按旧 handle 打开 `@ryloclyjdcf` → 404 → 「主页没读出粉丝/关注/获赞」。
        try {
          const cfg = readJson(CFG_FILE);
          if (cfg && Array.isArray(cfg.accounts)) {
            let touched = false;
            for (const a of cfg.accounts) {
              if ((a.bitEnvId || a.browserEnv) === t.env || `0${a.name}` === t.env.replace('TK', '0')) {
                if (a.username !== t.newUsername) {
                  a.username = t.newUsername;
                  touched = true;
                }
              }
            }
            if (touched) writeJson(CFG_FILE, cfg);
          }
        } catch (e) {
          console.log(`     ⚠️ 配置文件里的用户名没同步（${e.message}）`);
        }
      }

      // 顺手把新头像存一份，界面能立刻看到（avatarFile 是界面读 data URI 的依据）
      // 注意：**下载线上那张**（TikTok 已裁成 200x200 方图），不是拷原图 ——
      // 拷原图会和真号显示不一致（界面缩略图跟真号对不上）。
      if (t.avatar && avatarChanged) {
        let dest = await downloadAvatar(after.avatar, t.env);
        if (!dest) {
          // 下载失败才退回「拷原图」，至少界面能显示新图
          try {
            fs.mkdirSync(AVATAR_DIR, { recursive: true });
            const srcExt = path.extname(t.avatar).toLowerCase();
            dest = path.join(AVATAR_DIR, `${t.env}${srcExt === '.png' ? '.png' : '.jpg'}`);
            fs.copyFileSync(t.avatar, dest);
            const other = path.join(AVATAR_DIR, `${t.env}${srcExt === '.png' ? '.jpg' : '.png'}`);
            if (fs.existsSync(other)) fs.rmSync(other, { force: true });
          } catch (_) {
            dest = '';
          }
        }
        if (dest) {
          const hAfter = hashOf(dest);
          profiles[t.env].avatarFile = dest;
          profiles[t.env].hasAvatar = true;
          profiles[t.env].avatarUrl = after.avatar || profiles[t.env].avatarUrl || '';
          // 记下"我们上传的这张"的哈希：以后任何一次资料同步都能据此回答
          // 「线上这张还是不是我们换的那张」——只比 URL 会被签名参数骗过去。
          if (!avatarSuspect) {
            profiles[t.env].avatarSha = hAfter;
            profiles[t.env].avatarIntendedSha = hAfter;
            profiles[t.env].avatarIntendedAt = new Date().toISOString();
            profiles[t.env].avatarChangedAt = new Date().toISOString();
            profiles[t.env].avatarReverted = false;
            profiles[t.env].avatarRevertedAt = '';
          }
          writeJson(PROFILES_FILE, profiles);
          console.log(`     🖼️ 头像缩略图已更新：${path.basename(dest)}（哈希 ${hAfter.slice(0, 8)}）`);
          // 内容比对：URL 变了不代表图变了（TikTok 的 CDN 会先返回旧图，签名参数每次都不同）
          if (avatarHashBefore && hAfter === avatarHashBefore) {
            avatarSuspect = true;
            console.log('     ⚠️ 下载回来的头像和换之前一模一样（哈希相同）→ 实际没换成，需要重试这张');
          }
        }
      }

      console.log(
        `  ${avatarSuspect ? '⚠️' : '✅'} ${t.env} 已保存 → 名字「${after.name}」${t.newUsername ? ` 用户名 @${after.handle}` : ''}${
          t.avatar ? ` 头像${avatarSuspect ? '⚠️ 可能没换成功（内容没变）' : avatarChanged ? '已更新' : '未变化'}` : ''
        }${t.bio ? ` 简介「${after.bio.slice(0, 24)}」` : ''}`,
      );
      if (avatarSuspect) failedLike++;
      else ok++;
    } catch (e) {
      console.log(`  ❌ ${t.env} 失败：${e.message}`);
      bad++;
    } finally {
      if (page) {
        try {
          await closeFoxPage(t.env, API);
        } catch (_) {
          /* 已关 */
        }
      }
    }
    await sleep(GAP * 1000);
  }

  console.log('');
  console.log(
    `  合计：成功 ${ok} 个${failedLike ? `，头像疑似没换成 ${failedLike} 个` : ''}${bad ? `，失败 ${bad} 个` : ''}${
      skipped ? `，跳过 ${skipped} 个` : ''
    }`,
  );
  if (ok && !dryRun) {
    console.log('  提示：资料已改，头像缩略图已自动更新；账号页会自动刷新（也可手动点「刷新」）。');
  }
}

main().catch((e) => {
  console.log(`  ❌ ${e.message}`);
  process.exitCode = 1;
});
