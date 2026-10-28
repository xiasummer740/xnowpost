#!/usr/bin/env node
/**
 * TikTok 批量登录（用户名 + 密码 + 本地 2FA）—— 方案 A「文件即命令」
 *
 *   node scripts/tk-login-batch.mjs --auto                 扫收件箱 import/accounts/*.txt
 *   node scripts/tk-login-batch.mjs --file <txt路径>       指定文件
 *   node scripts/tk-login-batch.mjs --auto --dry-run       只出计划，不开浏览器
 *   node scripts/tk-login-batch.mjs --from 3 --to 5        只跑其中几个
 *   node scripts/tk-login-batch.mjs --auto --force         已登录也重登（先退旧号）
 *
 * 其它开关：--gap 60（间隔秒）、--no-create（环境不够不新建）、--no-config（不改应用配置）
 *
 * 没有账号密码、只能用手机扫码登录的新号：
 *   node scripts/tk-login-batch.mjs --qr                 # 下一个空号环境（TK11…），打开二维码等你扫
 *   node scripts/tk-login-batch.mjs --qr --qr-count 3    # 连续加 3 个号（每个扫一次）
 *   node scripts/tk-login-batch.mjs --qr --only TK12     # 指定环境
 *   扫完自动读用户名 → 写 env-accounts.json / config → 备份 cookie → 关窗口
 *
 * 账号文件格式（每行一个；全角/半角竖线、制表符、逗号都认；自动跳过表头）：
 *   用户名｜密码｜邮箱｜邮箱密码｜2FA密钥｜地区
 *
 * 流程（2026-10-18 实测 9/9 成功）：
 *   /login → Use phone / email / username → Log in with email or username
 *   → 填用户名+密码 → Log in → /login/2sv/totp → 本地算 6 位码 → Next
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';
import { listFoxProfiles, foxCreateProfile, foxExportCookies, foxHealth } from '../src/collector/foxprofile.js';
import { allocateAccountEnvs } from '../src/account-env.js';
import { applyUniformScreen } from '../src/collector/uniform-screen.js';
import { nextRelayPort, proxyUrl, portListening } from '../src/collector/proxy-ports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------- 路径 ----------
const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const FOX_DATA = process.env.FOXPROFILE_DATA || 'E:/software/FoxProfile/camoufox_data';
const INBOX = process.env.XNOWPOST_INBOX || path.join(ROOT, 'import', 'accounts');
const INBOX_DONE = path.join(INBOX, 'done');
const SHOTS = process.env.XNOWPOST_SHOTS || path.join(ROOT, 'output', 'login-shots');
const BACKUPS = process.env.XNOWPOST_BACKUPS || path.join(ROOT, 'backups', 'cookies');
const REPORTS = process.env.XNOWPOST_REPORTS || path.join(ROOT, 'output');
const APP_DATA = process.env.APPDATA ? path.join(process.env.APPDATA, 'xnowpost') : path.join(ROOT, 'runtime');
const APP_CFG = path.join(APP_DATA, 'config', 'user.json');
const STATE_FILE = path.join(APP_DATA, 'data', 'env-accounts.json');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = '') => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const AUTO = has('--auto');
const FILE = val('--file');
const DRY = has('--dry-run');
const FORCE = has('--force');
const GAP = Number(val('--gap', '60')) || 60;
const FROM = Number(val('--from', '1')) || 1;
const TO = Number(val('--to', '0')) || 0;
const ONLY = val('--only').toUpperCase();
const NO_CREATE = has('--no-create');
const NO_CONFIG = has('--no-config');
/** 遇到人机验证时，留多少秒给人工拖动（默认 5 分钟） */
const CAPTCHA_WAIT = Number(val('--captcha-wait', '300')) || 300;
/** 扫码登录模式：没有账号密码的号（手机 TikTok 扫二维码授权） */
const QR = has('--qr');
const QR_COUNT = Number(val('--qr-count', '1')) || 1;
const QR_TIMEOUT = Number(val('--qr-timeout', '600')) || 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowStamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const today = () => new Date().toISOString().slice(0, 10);

// ---------- 账号解析（容错）----------
const HEADER_WORDS = /用户名|帐号|账号|密码|邮箱|密钥|username|password|email|secret|2fa/i;

function parseAccounts(text) {
  const rows = [];
  const skipped = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // 分隔符：全角竖线 ｜ / 半角 | / 制表符 / 逗号（后者要求至少 5 列）
    let parts = line.split(/[｜|]/).map((s) => s.trim());
    if (parts.length < 5) parts = line.split(/\t+/).map((s) => s.trim());
    if (parts.length < 5) parts = line.split(/\s*,\s*/).map((s) => s.trim());
    if (parts.length < 5) {
      // 表头或说明行
      if (HEADER_WORDS.test(line)) { skipped.push(line.slice(0, 40)); continue; }
      skipped.push(line.slice(0, 40));
      continue;
    }
    // 表头
    if (/^(用户名|账号|帐号|username|account)$/i.test(parts[0])) { skipped.push(line.slice(0, 40)); continue; }
    const [username, password, email, emailPassword, totpSecret, region = ''] = parts;
    if (!username || !password) { skipped.push(line.slice(0, 40)); continue; }
    rows.push({ username, password, email, emailPassword, totpSecret: totpSecret || '', region });
  }
  return { rows, skipped };
}

/** 从 otpauth:// 里抽 secret，或清洗 base32 */
function normalizeSecret(secret) {
  const s = String(secret || '').trim();
  if (!s) return '';
  const m = s.match(/secret=([A-Za-z2-7]+)/i);
  const raw = m ? m[1] : s;
  return raw.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

// ---------- TOTP ----------
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of String(input).toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

function totp(secret, offsetSteps = 0) {
  const key = base32Decode(normalizeSecret(secret));
  if (!key.length) return '';
  const counter = Math.floor(Date.now() / 1000 / 30) + offsetSteps;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
const totpLeft = () => 30 - (Math.floor(Date.now() / 1000) % 30);

// ---------- 登录态检测 ----------
/**
 * 通过 FoxProfile 导出的 cookie 判断是否已登录。
 * 不用读 cookies.sqlite：打包后的应用跑在 Electron 的 Node 上，
 * `node:sqlite` 在 Node 22 需要实验性开关，不可靠；接口方式到处都能跑。
 * 环境正在运行时导出会 409，视为「运行中」——那种情况也不该重登。
 */
async function isLoggedIn(env) {
  try {
    const text = await foxExportCookies(env, API, 'json');
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return { loggedIn: false, count: 0 };
    const names = new Set(arr.map((c) => String(c.name || '').toLowerCase()));
    const hit = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'].filter((n) => names.has(n));
    return { loggedIn: hit.length > 0, count: arr.length, hit };
  } catch (e) {
    const msg = String(e.message || e);
    if (/409|busy|running/i.test(msg)) return { loggedIn: true, count: 0, running: true };
    return { loggedIn: false, count: 0, error: msg };
  }
}

// ---------- 页面小工具 ----------
function makeKit(page, env) {
  let seq = 0;
  fs.mkdirSync(SHOTS, { recursive: true });
  const shot = async (name) => {
    try {
      seq += 1;
      const f = path.join(SHOTS, `${env}-${String(seq).padStart(2, '0')}-${name}.png`);
      fs.writeFileSync(f, await page.screenshot());
      return path.relative(ROOT, f).replace(/\\/g, '/');
    } catch (_) { return ''; }
  };

  const items = () => page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('div,button,a,span')) {
      const t = (el.innerText || '').trim();
      if (!t || t.length > 40) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) continue;
      if (Array.from(el.children).some((c) => (c.innerText || '').trim() === t)) continue;
      out.push({ t, tag: el.tagName, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    }
    const inputs = Array.from(document.querySelectorAll('input'))
      .map((e) => {
        const r = e.getBoundingClientRect();
        return {
          type: e.type, ph: e.placeholder || '',
          x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
          w: Math.round(r.width), h: Math.round(r.height),
          val: e.type === 'password' ? (e.value ? '***' : '') : e.value,
        };
      })
      .filter((i) => i.w >= 60 && i.h >= 20 && i.y >= 40);
    return { url: location.href, text: (document.body.innerText || '').slice(0, 900), items: out, inputs };
  });

  const click = async (text, { pick = 'first' } = {}) => {
    const st = await items();
    const hits = st.items.filter((i) => i.t === text);
    if (!hits.length) throw new Error(`找不到「${text}」`);
    const p = pick === 'last' ? hits[hits.length - 1] : hits[0];
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(1800);
    return p;
  };

  const fill = async (input, value) => {
    await page.mouse.click(input.x, input.y);
    await page.waitForTimeout(250);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(value, { delay: 35 });
    await page.waitForTimeout(300);
    const st = await items();
    const same = st.inputs.find((i) => i.type === input.type && Math.abs(i.y - input.y) < 14);
    const got = same?.val ?? '';
    return got === value || (input.type === 'password' && got === '***');
  };

  return { shot, items, click, fill };
}

/**
 * 把人机验证的浏览器窗口顶到最前（用户要手动拖，得先看得到）。
 * 用 Win32 ShowWindow + SetForegroundWindow，windowsHide 必须带上，别弹黑框。
 */
/**
 * 新建环境后统一窗口尺寸 —— 必须紧跟在「建完」之后、开浏览器之前：
 * Camoufox 的窗口大小是启动时从指纹里读的，晚一步就白改。
 * （用户 2026-10-24 反馈：扫码加号开出来的窗口比别的号大一圈。）
 */
function unifyScreen(env) {
  try {
    const r = applyUniformScreen(env);
    if (r.ok) console.log('  🖥️ ' + env + ' 窗口尺寸已统一：' + r.before + ' → ' + r.after);
    else console.log('  ⚠️ ' + env + ' 窗口尺寸没改成：' + (r.note || '未知'));
  } catch (e) {
    console.log('  ⚠️ ' + env + ' 窗口尺寸没改成：' + e.message);
  }
}

/**
 * 给新环境分一条**自己的**本地代理端口（1080–1089 是老环境的，新号从 1090 起顺序递增）。
 * 不能再照抄模板环境的代理：那样 TK11 和 TK01 挤同一个 127.0.0.1:1080，
 * 一条中继出问题另一条跟着挂（用户 2026-10-24：「肯定不能共用一个端口呀，按顺序递增嘛」）。
 *
 * ⚠️ 2026-10-28 起端口由**内置内核 xray** 一次开满 1080–1109（src/proxy/engine.js），
 *    这里只需要算号、不需要再补 relay 配置 —— 老的 proxy_relay.py 链路对小白不存在。
 *    只有本机还留着老 relay（开发机兜底）时才补配置，见下面的 ensureRelayPort 分支。
 */
const allocatedProxies = [];
async function allocateProxy() {
  const fake = allocatedProxies.map((p) => ({ proxy: p }));
  const port = nextRelayPort(fake);
  // 端口归内置内核管（一次开满 1080–1109）。这里只做体检：
  // 不通就说明"没配节点/内核没起来"，那要在「配置 → 网络节点」解决，不是在这儿补 relay。
  const up = await portListening(port).catch(() => false);
  if (!up) {
    console.log(
      `  ⚠️ 本地端口 ${port} 没在监听 —— 检查「配置 → 网络节点」是否配了节点、内核是否在跑`,
    );
  }
  allocatedProxies.push(proxyUrl(port));
  return proxyUrl(port);
}

function bringBrowserToFront() {
  const ps = [
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class W {',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
    '}',
    '"@',
    '$p = Get-Process camoufox -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;',
    'if ($p) { [W]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; "ok" } else { "none" }',
  ].join('\n');
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      timeout: 20000,
      encoding: 'utf8',
    });
    return (r.stdout || '').trim() === 'ok';
  } catch (_) {
    return false;
  }
}

/**
 * 人机验证检测：文字 + DOM 双保险（有的验证框在 iframe 里，主文档读不到文字）
 */
async function detectCaptcha(page) {
  try {
    return await page.evaluate(() => {
      const t = (document.body.innerText || '').toLowerCase();
      const byText = /slide to verify|slide the puzzle|rotate|press and hold|verify you are human|human verification|滑动|拖动|旋转|请完成(安全)?验证|安全验证/.test(t);
      const byDom = !!document.querySelector(
        'iframe[src*="captcha"], iframe[src*="verify"], [id*="captcha"], [class*="captcha"], [id*="verify-container"], [class*="secsdk"]',
      );
      return byText || byDom;
    });
  } catch (_) {
    return false;
  }
}

/**
 * 人机验证 → 交给人手动拖。窗口保持打开，脚本在旁边等。
 * 返回 true 表示验证框已消失（不一定通过，回主循环再判断）。
 */
async function waitManualCaptcha(page, kit, env, maxSeconds) {
  const focused = bringBrowserToFront();
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log(`  ║  ⚠️  ${env} 出现人机验证，需要你手动拖一下（就一下）   ║`);
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log(`     窗口${focused ? '已顶到最前' : '已打开（如果没看到请点任务栏的 Camoufox）'}，把滑块/拼图拖完即可。`);
  console.log(`     我在这儿等，最多 ${Math.round(maxSeconds / 60)} 分钟，拖完我会自动接着登录。`);
  console.log('     （不想等就关掉那个浏览器窗口，脚本会跳过这个号继续下一个）');
  console.log('');

  const started = Date.now();
  let lastHint = 0;
  try {
    while (Date.now() - started < maxSeconds * 1000) {
      await sleep(2000);
      const gone = !(await detectCaptcha(page));
      if (gone) {
        const waited = Math.round((Date.now() - started) / 1000);
        console.log(`  ✅ 验证框已消失（你用了 ${waited} 秒），继续登录流程`);
        return true;
      }
      const waited = Math.round((Date.now() - started) / 1000);
      if (waited - lastHint >= 30) {
        lastHint = waited;
        console.log(`     …还在等人工验证（已等 ${waited} 秒 / 最多 ${maxSeconds} 秒）`);
      }
    }
  } catch (e) {
    console.log(`  ⚠️ 等待期间窗口没了（${e.message}），跳过这个号`);
    return false;
  }
  return false;
}

// ---------- 单环境登录 ----------
async function loginEnv(env, acct) {
  const res = {
    env, username: acct.username, ok: false, step: 'launch',
    startedAt: new Date().toISOString(), shots: [], note: '',
  };
  const t0 = Date.now();
  console.log(`\n──── ${env} ← ${acct.username} ────`);

  const { page } = await openFoxPage(env, API);
  const kit = makeKit(page, env);

  try {
    await page.setDialogPolicy('pre');

    // 1) 登录页（若还登着旧号，先退出）
    res.step = 'open-login';
    await page.goto('https://www.tiktok.com/login', { waitUntil: 'commit' });
    await page.waitForTimeout(6000);
    let st = await kit.items();
    const hasEntry = () => st.items.some((i) => /Use phone \/ email \/ username|Log in with email or username|Username or email/.test(i.t));
    if (!hasEntry()) {
      console.log('  页面不是登录页（可能登着旧号）→ 先退出');
      await page.goto('https://www.tiktok.com/logout', { waitUntil: 'commit' }).catch(() => {});
      await page.waitForTimeout(5000);
      await page.goto('https://www.tiktok.com/login', { waitUntil: 'commit' }).catch(() => {});
      await page.waitForTimeout(6000);
      st = await kit.items();
    }
    res.shots.push(await kit.shot('login-page'));

    // 2) 选择「用户名 / 邮箱」登录方式
    res.step = 'pick-method';
    if (st.items.some((i) => i.t === 'Use phone / email / username')) {
      await kit.click('Use phone / email / username');
      await page.waitForTimeout(2000);
      st = await kit.items();
    }
    if (st.items.some((i) => i.t === 'Log in with email or username')) {
      await kit.click('Log in with email or username');
    } else if (st.items.some((i) => i.t === 'Username or email')) {
      await kit.click('Username or email');
    }
    await page.waitForTimeout(2000);
    st = await kit.items();

    // 兜底：有的环境默认是「手机+验证码」，要点 Log in with password 才有密码框
    for (const label of ['Log in with email or username', 'Username or email', 'Log in with password', 'Use password']) {
      if (st.inputs.some((i) => i.type === 'password')) break;
      if (!st.items.some((i) => i.t === label)) continue;
      console.log(`  兜底：再点「${label}」`);
      await kit.click(label);
      await page.waitForTimeout(2000);
      st = await kit.items();
    }

    // 3) 填表
    res.step = 'fill';
    const userBox = st.inputs.find((i) => i.type !== 'password' && /username|email/i.test(i.ph)) ||
      st.inputs.find((i) => i.type !== 'password');
    const passBox = st.inputs.find((i) => i.type === 'password');
    if (!userBox || !passBox) throw new Error(`找不到账号密码框（页面：${st.items.map((i) => i.t.replace(/\n/g, ' ')).slice(0, 8).join(' | ')}）`);
    const okU = await kit.fill(userBox, acct.username);
    const okP = await kit.fill(passBox, acct.password);
    console.log(`  填表: 用户名${okU ? '✓' : '✗'} 密码${okP ? '✓' : '✗'}`);
    res.shots.push(await kit.shot('filled'));
    if (!okU || !okP) throw new Error('账号密码没填进去');

    // 4) 提交
    res.step = 'submit';
    st = await kit.items();
    await kit.click(st.items.some((i) => i.t === 'Log in') ? 'Log in' : 'Continue', { pick: 'last' });
    await page.waitForTimeout(8000);
    res.shots.push(await kit.shot('after-submit'));

    // 5) 2FA / 结果
    let totpTried = 0;
    for (let round = 1; round <= 6; round++) {
      st = await kit.items();
      const body = st.text;
      console.log(`  第 ${round} 轮 | ${st.url.slice(0, 52)} | 输入: ${st.inputs.map((i) => i.ph || i.type).join(',') || '无'}`);

      if (/maximum number of attempts|too many attempts/i.test(body)) {
        res.step = 'rate-limited';
        throw new Error('TikTok 提示尝试次数过多（IP 或该号被限，隔几小时再试）');
      }
      if (await detectCaptcha(page)) {
        res.step = 'captcha-manual';
        res.captcha = true;
        res.shots.push(await kit.shot('captcha'));
        const solved = await waitManualCaptcha(page, kit, env, CAPTCHA_WAIT);
        if (!solved) throw new Error(`人机验证超过 ${CAPTCHA_WAIT} 秒未完成`);
        res.shots.push(await kit.shot('captcha-solved'));
        // 验证通过后如果还停在登录表单，帮它再点一次提交
        st = await kit.items();
        if (/\/login/.test(st.url) && st.items.some((i) => i.t === 'Log in')) {
          console.log('  验证后表单还在，再点一次 Log in');
          await kit.click('Log in', { pick: 'last' }).catch(() => {});
          await page.waitForTimeout(7000);
        }
        continue;
      }
      if (/incorrect password|password is incorrect|wrong password|invalid password|密码错误/i.test(body)) {
        res.step = 'bad-password';
        throw new Error('密码被拒');
      }

      const boxes = await page.evaluate(() => document.querySelectorAll('input[maxlength="1"]').length);
      const onTotp = /2sv\/totp/.test(st.url) || boxes >= 6 ||
        /authenticator|verification code|6-digit|2-step|2 Factor|Enter the code|验证码/i.test(body);

      if (onTotp) {
        res.step = 'totp';
        if (totpTried >= 3) throw new Error('2FA 验证码连续错误');
        // 第一次用当前窗口；失败后换下一个时间窗（应对时钟偏差）
        const offset = totpTried;
        const code = totp(acct.totpSecret, offset);
        const left = totpLeft();
        console.log(`  2FA 验证码 ${code.slice(0, 2)}****（剩余 ${left} 秒，窗口偏移 ${offset}）`);
        if (!code) throw new Error('账号文件里没有可用的 2FA 密钥');
        if (boxes >= 6) {
          const first = st.inputs[0];
          await page.mouse.click(first.x, first.y);
          await page.waitForTimeout(250);
          for (const ch of code) await page.keyboard.type(ch, { delay: 130 });
        } else {
          const box = st.inputs.find((i) => i.type !== 'password') || st.inputs[0];
          if (!box) throw new Error('找不到 2FA 输入框');
          await kit.fill(box, code);
        }
        res.shots.push(await kit.shot('totp-filled'));
        st = await kit.items();
        const goLabel = ['Next', 'Log in', 'Continue', 'Verify'].find((l) => st.items.some((i) => i.t === l));
        if (goLabel) await kit.click(goLabel, { pick: 'last' });
        else await page.keyboard.press('Enter');
        await page.waitForTimeout(9000);
        totpTried += 1;
        res.shots.push(await kit.shot('after-2fa'));
        continue;
      }

      if (!/\/login/.test(st.url)) {
        res.ok = true;
        res.step = 'logged-in';
        res.url = st.url;
        break;
      }
      await page.waitForTimeout(4000);
    }

    if (!res.ok) throw new Error(`未登录成功（停在 ${res.step}）`);

    const st2 = await kit.items();
    res.url = st2.url;
    res.shots.push(await kit.shot('success'));
    console.log(`  ✅ 登录成功 → ${st2.url}`);
  } catch (e) {
    res.note = e.message;
    res.shots.push(await kit.shot('error'));
    console.log(`  ❌ ${e.message}`);
  } finally {
    try { await closeFoxPage(env, API); } catch (_) {}
  }

  // 6) 关掉浏览器后核实 cookie + 备份
  if (res.ok) {
    await sleep(1500);
    const chk = await isLoggedIn(env);
    res.cookieOk = chk.loggedIn;
    if (!chk.loggedIn) {
      res.ok = false;
      res.note = '登录后没读到 sessionid cookie';
      console.log('  ⚠️ 登录后没读到 sessionid cookie，判为失败');
    } else {
      try {
        const dir = path.join(BACKUPS, today());
        fs.mkdirSync(dir, { recursive: true });
        const text = await foxExportCookies(env, API, 'json');
        fs.writeFileSync(path.join(dir, `${env}.json`), text);
        res.cookieBackup = path.relative(ROOT, path.join(dir, `${env}.json`)).replace(/\\/g, '/');
        console.log(`  💾 cookie 已备份 → ${res.cookieBackup}`);
      } catch (e) {
        console.log(`  ⚠️ cookie 备份失败: ${e.message}`);
      }
    }
  }

  res.seconds = Math.round((Date.now() - t0) / 1000);
  console.log(`  结果: ${res.ok ? '✅ 成功' : '❌ 失败'}（${res.step}，${res.seconds}s）`);
  return res;
}

// ---------- 应用配置 / 状态 ----------
function writeAppConfig(mapping) {
  if (NO_CONFIG) return '跳过（--no-config）';
  try {
    if (!fs.existsSync(APP_CFG)) return `跳过（找不到 ${APP_CFG}）`;
    const raw = fs.readFileSync(APP_CFG, 'utf8');
    const cfg = JSON.parse(raw);
    const list = Array.isArray(cfg.accounts) ? cfg.accounts : [];
    fs.mkdirSync(path.dirname(APP_CFG), { recursive: true });
    fs.writeFileSync(`${APP_CFG}.bak-${nowStamp()}`, raw);
    for (const [env, acct] of Object.entries(mapping)) {
      const idx = Number(env.replace(/\D/g, '')) || 0;
      const name = String(idx).padStart(2, '0');
      let item = list.find((a) => String(a.bitEnvId || a.browserEnv || '').toUpperCase() === env) ||
        list.find((a) => a.name === name);
      if (!item) {
        item = { name, platform: 'tiktok' };
        list.push(item);
      }
      item.name = item.name || name;
      item.platform = item.platform || 'tiktok';
      item.bitEnvId = env;
      item.browserEnv = env;
      if (acct?.username) item.username = acct.username;
    }
    list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    cfg.accounts = list;
    fs.writeFileSync(APP_CFG, JSON.stringify(cfg, null, 2));
    return `已更新 ${list.length} 条账号（备份 .bak-${nowStamp()}）`;
  } catch (e) {
    return `失败: ${e.message}`;
  }
}

function writeState(mapping) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const old = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
    for (const [env, acct] of Object.entries(mapping)) {
      old[env] = {
        username: acct.username,
        email: acct.email,
        // 密码/邮箱落盘是为了界面上能「小眼睛显示 + 点击复制」，
        // 文件在 %APPDATA%（不进 Git 仓库）。不想存就删掉这两个字段。
        password: acct.password || (old[env] && old[env].password) || '',
        emailPassword: acct.emailPassword || (old[env] && old[env].emailPassword) || '',
        // 地区（账号文件里那一列，如 gb）。TikTok 网页端不暴露地区，
        // 「拉取资料」脚本要靠这个字段回填显示，所以登录时就得存下来。
        region: acct.region || (old[env] && old[env].region) || '',
        at: new Date().toISOString(),
      };
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(old, null, 2));
  } catch (_) { /* 状态文件只是辅助信息 */ }
}

function readState() {
  try {
    return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  } catch { return {}; }
}

// ---------- 报告 ----------
function writeReport({ results, skipped, created, filePath, configMsg }) {
  fs.mkdirSync(REPORTS, { recursive: true });
  const f = path.join(REPORTS, `account-login-${nowStamp()}.md`);
  const okList = results.filter((r) => r.ok);
  const failList = results.filter((r) => !r.ok);
  const L = [];
  L.push(`# TikTok 批量登录报告`);
  L.push('');
  L.push(`- 时间：${new Date().toLocaleString('zh-CN')}`);
  L.push(`- 账号文件：\`${filePath}\``);
  L.push(`- 结果：**成功 ${okList.length} / ${results.length}**${failList.length ? `，失败 ${failList.length}` : ''}`);
  L.push(`- 应用配置：${configMsg}`);
  if (created.length) L.push(`- 自动新建环境：${created.join(', ')}`);
  L.push('');
  L.push('| 环境 | 账号 | 结果 | 用时 | 说明 | 截图 |');
  L.push('|---|---|---|---|---|---|');
  for (const r of results) {
    const shot = r.shots?.length ? `[查看](${r.shots[r.shots.length - 1]})` : '-';
    L.push(`| ${r.env} | ${r.username} | ${r.ok ? '✅ 成功' : '❌ ' + (r.step || '失败')} | ${r.seconds ?? '-'}s | ${(r.note || (r.ok ? (r.url || '') : '')).slice(0, 60)} | ${shot} |`);
  }
  if (skipped.length) {
    L.push('');
    L.push('## 跳过的环境（已登录，未覆盖）');
    L.push('');
    L.push('| 环境 | 当前账号 | 说明 |');
    L.push('|---|---|---|');
    for (const s of skipped) L.push(`| ${s.env} | ${s.username || '未知'} | ${s.why} |`);
  }
  fs.writeFileSync(f, L.join('\n'));
  return f;
}

// ---------- 扫码登录（没有账号密码的号也能加）----------
/**
 * 读当前登录账号的 @用户名（TikTok Studio 里指向自己主页的那条链接）。
 */
async function readTkUsername(page) {
  // ⚠️ 别用 /passport/web/account/info/ 的 screen_name：实测它是内部 id（user4837577922302），
  //    不是 @handle（真名 xnow.matrix）。唯一可靠的来源是 TikTok Studio 里那条指向自己主页的链接。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto('https://www.tiktok.com/tiktokstudio');
      await page.waitForTimeout(attempt === 0 ? 7000 : 5000);
      const hrefs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href^="/@"]')).map((a) => a.getAttribute('href') || ''),
      );
      const handles = [];
      for (const h of hrefs) {
        const m = /^\/@([^/?#]+)\/?$/.exec(h || '');
        if (m && m[1] && !handles.includes(m[1])) handles.push(m[1]);
      }
      if (handles.length === 1) return decodeURIComponent(handles[0]);
      if (handles.length > 1) {
        // 多于一个时优先不含 video 的那种（上面正则已经排掉了），仍然取第一个并留痕
        console.log('  ℹ️ Studio 里有多个主页链接：' + handles.slice(0, 4).join(', ') + '，取第一个');
        return decodeURIComponent(handles[0]);
      }
    } catch (_) {
      /* 再试一次 */
    }
  }
  return '';
}
/**
 * 一个环境用二维码登录。实测（2026-10-24）：
 *   /login 有「Use QR code」（div 345x46）→ 点了跳 /login/qrcode
 *   → 二维码是 170x170 的 <canvas>（不是 <img>）→ 手机 TikTok 扫 → 手机上点确认
 *   → 页面离开 /login 即成功。
 */
async function loginEnvQr(env) {
  const t0 = Date.now();
  const shots = [];
  const elapsed = () => Math.round((Date.now() - t0) / 1000);
  let page;
  try {
    console.log('');
    console.log('  ▶ ' + env + ' 打开环境…');
    const opened = await openFoxPage(env, API, { minimize: false });
    page = opened.page || opened;

    await page.goto('https://www.tiktok.com/login');
    await page.waitForTimeout(8000);

    const startUrl = await page.evaluate(() => location.href).catch(() => '');
    if (startUrl && !/\/login/.test(startUrl)) {
      const username = await readTkUsername(page);
      console.log('  ℹ️ ' + env + ' 打开时已经是登录状态，没扫码');
      return { ok: true, env, username, url: startUrl, note: '已是登录状态，未扫码', shots, seconds: elapsed() };
    }

    // 点「Use QR code」：TikTok 的按钮是 div，取文字匹配的最内层那个
    const clicked = await page
      .evaluate(() => {
        const want = /use qr code|qr code|二维码|扫码/i;
        const cands = Array.from(document.querySelectorAll('div,button,a,span'))
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter((x) => {
            const t = (x.el.innerText || '').replace(/\s+/g, ' ').trim();
            return t && t.length < 40 && want.test(t) && x.r.width > 40 && x.r.height > 15 && x.r.width < 520;
          })
          .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height);
        if (!cands.length) return { ok: false };
        const el = cands[0].el;
        el.click();
        return { ok: true, text: (el.innerText || '').trim() };
      })
      .catch(() => ({ ok: false }));
    if (!clicked.ok) {
      return { ok: false, env, step: '找不到二维码入口', note: '登录页上没有「Use QR code」', shots, seconds: elapsed() };
    }
    console.log('  📷 已切到扫码页（点了「' + clicked.text + '」）');

    let qrReady = false;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000).catch(() => {});
      qrReady = await page
        .evaluate(() => {
          const big = Array.from(document.querySelectorAll('canvas,img')).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width >= 120 && r.height >= 120;
          });
          return big.length > 0;
        })
        .catch(() => false);
      if (qrReady) break;
    }

    const focused = bringBrowserToFront();
    console.log('  📱 二维码' + (qrReady ? '已显示' : '可能还没画出来') + '，浏览器窗口已' + (focused ? '顶到最前' : '打开'));
    console.log('     手机 TikTok → 我 → 右上角扫码 → 扫这个窗口里的二维码 → 手机上点「确认」');
    console.log('     最多等 ' + QR_TIMEOUT + ' 秒；不想加了就直接关掉浏览器窗口');

    const deadline = Date.now() + QR_TIMEOUT * 1000;
    let loggedIn = false;
    let last = '';
    let tick = 0;
    let deadPoll = 0;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000).catch(() => {});
      tick += 3;
      const now = await page.evaluate(() => location.href).catch(() => null);
      if (now === null) {
        deadPoll += 1;
        if (deadPoll >= 8) {
          return { ok: false, env, step: '窗口被关掉了', note: '等待扫码时环境窗口没了', shots, seconds: elapsed() };
        }
        continue;
      }
      deadPoll = 0;
      if (now !== last) {
        last = now;
        console.log('     页面：' + now);
        if (!/\/login/.test(now)) {
          loggedIn = true;
          break;
        }
      }
      if (tick % 60 === 0) console.log('     …还在等你扫码（已 ' + elapsed() + ' 秒）');
    }
    if (!loggedIn) {
      return { ok: false, env, step: '等二维码超时', note: QR_TIMEOUT + ' 秒内没有扫码确认', shots, seconds: elapsed() };
    }

    await page.waitForTimeout(4000).catch(() => {});
    const username = await readTkUsername(page);
    console.log('  ✅ ' + env + ' 已登录' + (username ? '：@' + username : '（没读到用户名，后面「抓全部资料」会补）'));

    // 备份 cookie：环境坏了/换机器时导入就能恢复，不用再扫码。
    // 刚跳转完立刻导出偶尔会失败（2026-10-24 TK11 那次就只留下一句警告、没落盘），
    // 所以重试 3 次，每次间隔 3 秒；还失败就明说「要补一次」。
    {
      const dir = path.join(BACKUPS, today());
      let backed = false;
      for (let i = 0; i < 3 && !backed; i += 1) {
        try {
          const text = await foxExportCookies(env, API, 'json');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, env + '.json'), text);
          const n = (JSON.parse(text).cookies || []).length;
          console.log('  💾 cookie 已备份：backups/cookies/' + today() + '/' + env + '.json（' + n + ' 条）');
          backed = true;
        } catch (e) {
          if (i < 2) {
            console.log('  …cookie 导出失败，3 秒后重试（' + (i + 1) + '/3）：' + e.message);
            await sleep(3000);
          } else {
            console.log('  ❌ cookie 备份失败：' + e.message + '（登录是成功的，但要手动补备份一次）');
          }
        }
      }
    }

    return { ok: true, env, username, url: last, note: '扫码登录', shots, seconds: elapsed() };
  } catch (e) {
    return { ok: false, env, step: '异常', note: String((e && e.message) || e), shots, seconds: elapsed() };
  } finally {
    await closeFoxPage(env, API).catch(() => {});
    // 关掉之后再统一一次窗口尺寸：**创建后的第一次启动**，Camoufox 会按自己的
    // "coherence" 重写 fingerprint.json（实测 TK11 被改成 avail 1280x976 / screen 1280x1024），
    // 把创建时写进去的 1292x994 覆盖掉。关窗后再写一遍，下次开就是标准尺寸。
    unifyScreen(env);
  }
}

/** --qr 的整轮流程：确定要哪几个环境 → 缺的建出来 → 逐个等扫码 → 写状态/配置/报告 */
async function runQrMode() {
  const profiles = await listFoxProfiles(API);
  const envNames = profiles.map((p) => String(p.name).toUpperCase());
  const template =
    profiles.find((p) => String(p.name).toUpperCase() === 'TK01') || profiles[0] || {};
  console.log('  扫码模式：现有环境 ' + profiles.length + ' 个');

  const targets = [];
  if (ONLY) targets.push(ONLY);
  else {
    const st = readState();
    // ① 先捡「已经建出来、但还没登记账号」的空环境（上次扫码中途关窗留下的），
    //    否则每点一次「扫码加号」都会多建一个 TK12、TK13…，旧空环境永远没人用。
    const orphans = envNames
      .filter((e) => !(st[e] && st[e].username))
      .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
    for (const e of orphans.slice(0, QR_COUNT)) targets.push(e);
    // ② 不够再按空号分配（TK11、TK12…）
    const need = QR_COUNT - targets.length;
    if (need > 0) {
      const fake = Array.from({ length: need }, (_, i) => ({ username: '__qr_' + nowStamp() + '_' + i }));
      for (const a of allocateAccountEnvs(fake, st, envNames)) targets.push(a.env);
    }
    if (targets.length > QR_COUNT) targets.length = QR_COUNT;
  }
  if (!targets.length) {
    console.log('  ⚠️ 没有要处理的环境');
    return 1;
  }
  console.log('  要处理的环境：' + targets.join(', '));
  if (DRY) {
    console.log('  （--dry-run：不建环境、不开浏览器、不扫码）');
    return 0;
  }

  const created = [];
  for (const env of targets) {
    if (envNames.includes(env)) {
      console.log('  ℹ️ 环境 ' + env + ' 已存在，直接扫码登录');
      continue;
    }
    if (NO_CREATE) {
      console.log('  ⚠️ 环境 ' + env + ' 不存在（--no-create），跳过');
      continue;
    }
    try {
      const proxy = await allocateProxy();
      await foxCreateProfile(
        {
          name: env,
          proxy,
          osType: template.osType || template.os_type || 'windows',
          timezone: template.timezone,
          locale: template.locale,
          engine: template.engine || 'camoufox',
        },
        API,
      );
      created.push(env);
      console.log('  ➕ 已新建环境 ' + env + '（代理 ' + (proxy || '无') + '，时区 ' + (template.timezone || '自动') + '）');
      unifyScreen(env);
    } catch (e) {
      console.log('  ⚠️ 新建环境 ' + env + ' 失败：' + e.message);
    }
  }

  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const r = await loginEnvQr(targets[i]);
    results.push(r);
    if (r.ok && r.username) writeState({ [r.env]: { username: r.username } });
    if (i < targets.length - 1) {
      if (!r.ok) console.log('  （上一个没成，继续下一个）');
      console.log('  … 等 ' + GAP + ' 秒再下一个');
      await sleep(GAP * 1000);
    }
  }

  const mapping = {};
  for (const r of results) if (r.ok && r.username) mapping[r.env] = { username: r.username };
  const configMsg = Object.keys(mapping).length
    ? writeAppConfig(mapping)
    : '跳过（没读到用户名，用「抓全部资料」补）';
  const report = writeReport({ results, skipped: [], created, filePath: '（扫码登录）', configMsg });

  const okN = results.filter((r) => r.ok).length;
  console.log('');
  console.log('  ═══ 汇总：成功 ' + okN + ' / ' + results.length + ' ═══');
  for (const r of results) {
    console.log('   ' + (r.ok ? '✅' : '❌') + ' ' + r.env + '  ' + (r.username || '') + '  ' + (r.ok ? r.url || '' : r.step + ': ' + r.note));
  }
  console.log('');
  console.log('  📄 报告：' + path.relative(ROOT, report).replace(/\\/g, '/'));
  console.log('  ⚙️ 应用配置：' + configMsg);
  return okN === results.length ? 0 : 2;
}

// ---------- 主流程 ----------
(async () => {
  console.log('  ═══ TikTok 批量登录 ═══');
  const health = await foxHealth(API).catch((e) => ({ error: e.message }));
  if (!health || health.error) {
    console.log(`  ❌ FoxProfile 连不上：${health?.error || '未知'}`);
    process.exit(1);
  }
  console.log(`  FoxProfile OK（${API}）`);

  // ── 扫码登录模式（--qr）：没有账号密码的号也走这条 ──
  if (QR) {
    const code = await runQrMode();
    process.exit(code);
  }

  // 1) 取账号文件
  let accountFile = '';
  let text = '';
  if (FILE) {
    if (!fs.existsSync(FILE)) { console.log(`  ❌ 文件不存在：${FILE}`); process.exit(1); }
    accountFile = FILE;
    text = fs.readFileSync(FILE, 'utf8');
  } else if (AUTO) {
    fs.mkdirSync(INBOX, { recursive: true });
    const files = fs.readdirSync(INBOX)
      .filter((f) => f.toLowerCase().endsWith('.txt'))
      .map((f) => ({ f, t: fs.statSync(path.join(INBOX, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!files.length) {
      console.log(`  ⚠️ 收件箱是空的：${path.relative(ROOT, INBOX)}\\  （把 txt 丢进去再跑）`);
      process.exit(0);
    }
    accountFile = path.join(INBOX, files[0].f);
    text = fs.readFileSync(accountFile, 'utf8');
    console.log(`  收件箱最新文件：${files[0].f}`);
  } else {
    console.log(
      '  用法：--auto（扫收件箱） | --file <txt路径> | --qr（没有密码、用手机扫码加号）' +
        '，加 --dry-run 只出计划',
    );
    process.exit(0);
  }

  const { rows, skipped: badLines } = parseAccounts(text);
  console.log(`  解析出 ${rows.length} 个账号${badLines.length ? `，忽略 ${badLines.length} 行无效/表头内容` : ''}`);
  if (!rows.length) { console.log('  ❌ 没有可用账号'); process.exit(1); }

  // 2) 现有环境 + 模板
  const profiles = await listFoxProfiles(API);
  const envNames = profiles.map((p) => String(p.name).toUpperCase());
  const template = profiles[0] || {};
  console.log(`  现有环境 ${profiles.length} 个：${envNames.slice(0, 12).join(', ')}${envNames.length > 12 ? ' …' : ''}`);

  // 3) 分配环境（账号 N → TK0N），必要时新建
  const plan = [];
  const created = [];
  const toCreate = [];
  const state = readState();
  // 账号 → 环境：已登记的用户名留在原环境，新用户名自动拿空号（TK11…），
  // 规则只有一份，在 src/account-env.js（界面「导入账号文件」走的是同一份）。
  const alloc = allocateAccountEnvs(rows, state, envNames);
  for (const a of alloc) {
    if (a.duplicate) continue;
    const index = a.index;
    if (index < FROM) continue;
    if (TO && index > TO) continue;
    const env = a.env;
    if (ONLY && env !== ONLY) continue;
    const exists = envNames.includes(env);
    plan.push({ index, env, acct: rows[index - 1], exists });
    if (!exists && !NO_CREATE && !toCreate.includes(env)) toCreate.push(env);
  }
  if (!plan.length) { console.log('  ⚠️ 没有需要处理的环境（检查 --from/--to/--only）'); process.exit(0); }

  // 4) 判定是否已登录
  for (const p of plan) {
    if (p.exists) {
      const chk = await isLoggedIn(p.env);
      p.loggedIn = chk.loggedIn;
      p.currentUser = state[p.env]?.username || '';
    }
  }

  const willRun = plan.filter((p) => FORCE || !p.loggedIn);
  const skippedList = plan.filter((p) => !FORCE && p.loggedIn)
    .map((p) => ({ env: p.env, username: p.currentUser, why: '已有登录态（加 --force 可覆盖）' }));

  // 5) 计划预览
  console.log(`\n  ── 执行计划 ──`);
  for (const p of plan) {
    const tag = !p.exists ? '新建环境' : p.loggedIn ? (FORCE ? '重登' : '跳过（已登录）') : '登录';
    console.log(`   ${p.index}. ${p.env.padEnd(5)} ${p.acct.username.padEnd(16)} ${tag}`);
  }
  console.log(`\n  合计：要跑 ${willRun.length} 个，跳过 ${skippedList.length} 个，新建环境 ${toCreate.length} 个，间隔 ${GAP}s`);

  if (DRY) {
    console.log('\n  （--dry-run：未启动任何浏览器）');
    process.exit(0);
  }
  if (!willRun.length) {
    console.log('  没有需要跑的环境，结束。');
    process.exit(0);
  }

  // 6) 新建缺失环境
  for (const env of toCreate) {
    try {
      const proxy = await allocateProxy();
      await foxCreateProfile({
        name: env,
        proxy,
        osType: template.os_type || template.osType || 'windows',
        timezone: template.timezone,
        locale: template.locale,
        engine: template.engine || 'camoufox',
      }, API);
      created.push(env);
      console.log(`  ➕ 已新建环境 ${env}（代理 ${proxy || '无'}，时区 ${template.timezone || '自动'}）`);
      unifyScreen(env);
    } catch (e) {
      console.log(`  ⚠️ 新建环境 ${env} 失败: ${e.message}`);
    }
  }

  // 7) 逐个登录
  const results = [];
  for (let i = 0; i < willRun.length; i++) {
    const p = willRun[i];
    const r = await loginEnv(p.env, p.acct);
    results.push(r);
    if (r.ok) writeState({ [p.env]: p.acct });
    if (i < willRun.length - 1) {
      console.log(`  … 等待 ${GAP} 秒再下一个`);
      await sleep(GAP * 1000);
    }
  }

  // 8) 收尾：配置、报告、归档文件
  const mapping = {};
  for (const r of results) if (r.ok) {
    const p = willRun.find((x) => x.env === r.env);
    if (p) mapping[r.env] = p.acct;
  }
  if (skippedList.length) {
    const st = readState();
    for (const s of skippedList) {
      if (st[s.env]) {
        mapping[s.env] = {
          username: st[s.env].username,
          email: st[s.env].email,
          password: st[s.env].password,
          emailPassword: st[s.env].emailPassword,
          region: st[s.env].region,
        };
      }
    }
  }
  const configMsg = writeAppConfig(mapping);
  const report = writeReport({ results, skipped: skippedList, created, filePath: accountFile, configMsg });

  if (AUTO && !FILE) {
    try {
      fs.mkdirSync(INBOX_DONE, { recursive: true });
      fs.renameSync(accountFile, path.join(INBOX_DONE, path.basename(accountFile)));
      console.log(`  📦 账号文件已归档到 ${path.relative(ROOT, INBOX_DONE)}\\`);
    } catch (_) {}
  }

  // 9) 汇总
  const okN = results.filter((r) => r.ok).length;
  console.log(`\n  ═══ 汇总：成功 ${okN} / ${results.length} ═══`);
  for (const r of results) {
    console.log(`   ${r.ok ? '✅' : '❌'} ${r.env}  ${r.username}  ${r.ok ? (r.url || '') : `${r.step}: ${r.note}`}`);
  }
  if (skippedList.length) console.log(`   ⏭️ 跳过 ${skippedList.length} 个（已登录）：${skippedList.map((s) => s.env).join(', ')}`);
  console.log(`\n  📄 报告：${path.relative(ROOT, report).replace(/\\/g, '/')}`);
  console.log(`  ⚙️ 应用配置：${configMsg}`);
  process.exit(okN === results.length ? 0 : 2);
})().catch((e) => {
  console.log('  💥 未捕获错误:', e?.stack || e);
  process.exit(1);
});
