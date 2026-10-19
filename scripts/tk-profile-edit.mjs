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
      await page.goto(`https://www.tiktok.com/@${encodeURIComponent(t.username)}`, { waitUntil: 'commit' });
      await sleep(6000);
      const before = await readProfilePage(page);
      if (!before.handle) {
        console.log('     ⚠️ 主页没读到用户名，可能没登录或页面没加载完，继续尝试');
      }

      // 1) 打开「编辑资料」
      let entry = await clickButton(page, ['Edit profile', '编辑资料'], { scope: 'page' });
      if (!entry || !entry.clicked) {
        const ok2 = await page
          .locator('[data-e2e="edit-profile-entrance"]')
          .click({ timeout: 15000 })
          .then(() => true)
          .catch(() => false);
        if (!ok2 && (!entry || !entry.clicked)) throw new Error('没找到可点击的 Edit profile 按钮');
      }
      if (!(await visible(page, SEL.name, 25000))) throw new Error('编辑资料弹窗没出现');

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
      if (t.name) {
        const got = await setField(page, SEL.name, t.name);
        if (String(got || '').trim() !== String(t.name).trim()) {
          throw new Error(`名字没写进去（读回「${got}」）`);
        }
        console.log(`     名字 → ${t.name}`);
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
        if (saveBtn.disabled) throw new Error('Save 按钮是灰的（没有可提交的改动）');
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

      // 8) 回主页读回校验（这是唯一可信的成功判据）
      const finalName = t.newUsername || t.username;
      await page.goto(`https://www.tiktok.com/@${encodeURIComponent(finalName)}?lang=en`, { waitUntil: 'commit' });
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
      if (t.name && after.name !== t.name) diffs.push(`名字读回「${after.name}」`);
      if (t.bio && after.bio !== t.bio) diffs.push(`简介读回「${after.bio.slice(0, 24)}」`);
      if (t.newUsername && after.handle !== t.newUsername) diffs.push(`用户名读回「${after.handle}」`);

      if (diffs.length) {
        console.log(`  ⚠️ ${t.env} 已保存，但读回不一致：${diffs.join('，')}`);
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
          profiles[t.env].avatarFile = dest;
          profiles[t.env].hasAvatar = true;
          profiles[t.env].avatarUrl = after.avatar || profiles[t.env].avatarUrl || '';
          writeJson(PROFILES_FILE, profiles);
          console.log(`     🖼️ 头像缩略图已更新：${path.basename(dest)}`);
        }
      }

      console.log(
        `  ✅ ${t.env} 已保存 → 名字「${after.name}」${t.newUsername ? ` 用户名 @${after.handle}` : ''}${
          t.avatar ? ` 头像${avatarChanged ? '已更新' : '未变化'}` : ''
        }${t.bio ? ` 简介「${after.bio.slice(0, 24)}」` : ''}`,
      );
      ok++;
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
  console.log(`  合计：成功 ${ok} 个${bad ? `，失败 ${bad} 个` : ''}${skipped ? `，跳过 ${skipped} 个` : ''}`);
  if (ok && !dryRun) {
    console.log('  提示：资料已改，头像缩略图已自动更新；账号页会自动刷新（也可手动点「刷新」）。');
  }
}

main().catch((e) => {
  console.log(`  ❌ ${e.message}`);
  process.exitCode = 1;
});
