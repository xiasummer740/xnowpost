/**
 * 拉取 TikTok 账号资料：头像 / 昵称 / 粉丝 / 关注 / 赞 / 地区
 *
 * 用法：
 *   node scripts/tk-profile-sync.mjs                # 全部环境（跳过没有用户名的）
 *   node scripts/tk-profile-sync.mjs --only TK01    # 只跑一个
 *   node scripts/tk-profile-sync.mjs --stale 24     # 只要超过 24 小时没更新的
 *   node scripts/tk-profile-sync.mjs --dry-run
 *
 * 产出：<DATA_DIR>/data/account-profiles.json + <DATA_DIR>/data/avatars/<env>.jpg
 * 界面（账号页）读它来显示头像与数据，登录完可以自动补。
 *
 * 为什么不做数据接口调用：TikTok 的 /api/user/detail 需要 X-Bogus 签名，
 * 直接请求必然 403。走真实页面 DOM 反而稳（跟人工看的一致）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const APP_DATA = process.env.APPDATA ? path.join(process.env.APPDATA, 'xnowpost') : path.join(ROOT, 'runtime');
const APP_CFG = path.join(APP_DATA, 'config', 'user.json');
const STATE_FILE = path.join(APP_DATA, 'data', 'env-accounts.json');
const PROFILES_FILE = path.join(APP_DATA, 'data', 'account-profiles.json');
const AVATAR_DIR = path.join(APP_DATA, 'data', 'avatars');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = '') => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const ONLY = val('--only').toUpperCase();
const DRY = has('--dry-run');
const GAP = Number(val('--gap', '3')) || 3;
const STALE_HOURS = Number(val('--stale', '0')) || 0;

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

/** 页面里跑的提取逻辑（尽量多套选择器，TikTok 改版频繁） */
const EXTRACT = () => {
  const txt = (sel) => {
    const el = document.querySelector(sel);
    return el ? (el.textContent || '').trim() : '';
  };
  const img = (sel) => {
    const el = document.querySelector(sel);
    return el ? (el.getAttribute('src') || el.getAttribute('data-src') || '').trim() : '';
  };
  // 头像：data-e2e="user-avatar" 是一个空 div，真正的 <img> 在里面；
  // 实测最靠谱的是 class 里带 ImgAvatar 的 299px 大图，其次 user-avatar。
  const avatar =
    img('img[class*="ImgAvatar"]') ||
    img('img.user-avatar') ||
    img('[data-e2e="user-avatar"] img') ||
    img('img[src*="tiktokcdn"]');
  return {
    url: location.href,
    nickname: txt('[data-e2e="user-title"]'),
    handle: txt('[data-e2e="user-subtitle"]'),
    avatar,
    following: txt('[data-e2e="following-count"]'),
    followers: txt('[data-e2e="followers-count"]'),
    likes: txt('[data-e2e="likes-count"]'),
    bio: txt('[data-e2e="user-bio"]'),
    verified: !!document.querySelector(
      '[data-e2e="user-title"] [class*="Verify"], [class*="verified-badge"], svg[class*="verify"]',
    ),
    // 是否踩到了登录墙 / 验证码
    blocked: /log in to tiktok|verify to continue|captcha|拖动|滑动/.test(
      (document.body.innerText || '').toLowerCase(),
    ),
  };
};

/**
 * 页面内取账号信息（注册时间 / 邮箱 / 内部昵称）。
 * 注意：这个接口的 country_code 实测是 0（网页端不给地区），
 * 所以地区只能靠账号文件里那一列，接口只用来拿 create_time。
 */
const FETCH_INFO = async () => {
  const out = { createTime: '', email: '', screenName: '', region: '' };
  try {
    const r = await fetch('/passport/web/account/info/?aid=1988&app_language=en&channel=tiktok_web&device_platform=web', {
      credentials: 'include',
    });
    const j = await r.json();
    const d = (j && j.data) || {};
    if (d.create_time) out.createTime = new Date(Number(d.create_time) * 1000).toISOString();
    out.email = d.email || '';
    out.screenName = d.screen_name || '';
    // 万一以后接口开始给地区，这里能自动接上
    const reg = d.region || d.region_code || d.country || '';
    if (reg && reg !== '0') out.region = String(reg).toUpperCase();
  } catch (_) {
    /* 拿不到就算了 */
  }
  return out;
};

function regionFromAccountFile(env, cfg, state) {
  const acc = (cfg.accounts || []).find((a) => String(a.bitEnvId || '').toUpperCase() === env) || {};
  const st = state[env] || {};
  const raw = String(acc.region || st.region || '').trim().toLowerCase();
  const map = { gb: 'GB', uk: 'GB', us: 'US', de: 'DE', fr: 'FR', jp: 'JP', ca: 'CA', au: 'AU' };
  return map[raw] || (raw ? raw.toUpperCase() : '');
}

async function main() {
  const cfg = readJson(APP_CFG);
  const state = readJson(STATE_FILE);
  const profiles = readJson(PROFILES_FILE);

  // 环境 → 用户名
  const targets = [];
  const envs = new Set([
    ...(cfg.accounts || []).map((a) => String(a.bitEnvId || a.browserEnv || '').toUpperCase()),
    ...Object.keys(state),
  ]);
  for (const env of [...envs].filter(Boolean).sort()) {
    if (ONLY && env !== ONLY) continue;
    const acc = (cfg.accounts || []).find((a) => String(a.bitEnvId || a.browserEnv || '').toUpperCase() === env) || {};
    const username = String(acc.username || (state[env] || {}).username || '').trim();
    if (!username) continue;
    if (STALE_HOURS > 0) {
      const at = profiles[env] && profiles[env].fetchedAt ? Date.parse(profiles[env].fetchedAt) : 0;
      if (at && Date.now() - at < STALE_HOURS * 3600 * 1000) continue;
    }
    targets.push({ env, username });
  }

  console.log('');
  console.log('  ═══ TikTok 账号资料拉取 ═══');
  console.log(`  FoxProfile: ${API}`);
  console.log(`  目标 ${targets.length} 个环境${DRY ? '（预演，不启动浏览器）' : ''}`);
  for (const t of targets) console.log(`   · ${t.env}  @${t.username}`);
  console.log('');

  if (DRY || !targets.length) {
    if (!targets.length) console.log('  没有可拉取的环境（先登录账号，或在配置页填用户名）');
    return;
  }

  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  let ok = 0;
  let bad = 0;

  for (const { env, username } of targets) {
    console.log(`  ── ${env} @${username} ──`);
    let closed = false;
    try {
      const { page } = await openFoxPage(env, API);
      await page.goto(`https://www.tiktok.com/@${encodeURIComponent(username)}`, { waitUntil: 'commit' });
      // 等资料卡出现（最多 25 秒）
      let data = null;
      for (let i = 0; i < 25; i++) {
        await page.waitForTimeout(1000);
        data = await page.evaluate(EXTRACT).catch(() => null);
        if (data && (data.nickname || data.followers)) break;
      }
      if (!data || (!data.nickname && !data.followers)) {
        throw new Error('页面没加载出资料卡（可能被验证/未登录）');
      }
      if (data.blocked && !data.followers) throw new Error('页面要求登录或人机验证');

      let info = { createTime: '', email: '', screenName: '', region: '' };
      try {
        info = (await page.evaluate(FETCH_INFO)) || info;
      } catch (_) {
        /* 拿不到就算了 */
      }
      // 地区：接口不给 → 用账号文件里那一列（登录时写进状态文件）
      let region = info.region || regionFromAccountFile(env, cfg, state);

      // 头像落盘（CDN 图不需要登录态）
      let avatarFile = '';
      if (data.avatar && /^https?:/.test(data.avatar)) {
        try {
          const res = await fetch(data.avatar, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > 500) {
              const f = path.join(AVATAR_DIR, `${env}.jpg`);
              fs.writeFileSync(f, buf);
              avatarFile = f;
            }
          }
        } catch (_) {
          /* 头像下载失败不影响其它字段 */
        }
      }

      const handle = String(data.handle || '').replace(/^@/, '').trim() || username;
      profiles[env] = {
        username: handle,
        nickname: data.nickname || '',
        avatarFile,
        avatarUrl: data.avatar || '',
        followers: data.followers || '',
        following: data.following || '',
        likes: data.likes || '',
        bio: data.bio || '',
        verified: !!data.verified,
        region,
        createTime: info.createTime || '',
        email: info.email || '',
        fetchedAt: new Date().toISOString(),
      };
      writeJson(PROFILES_FILE, profiles);

      // 顺手把真实用户名补进状态文件
      state[env] = { ...(state[env] || {}), username: handle };
      writeJson(STATE_FILE, state);

      console.log(
        `  ✅ ${env} ${data.nickname || handle} · 粉丝 ${data.followers || '?'} / 关注 ${data.following || '?'} / 赞 ${data.likes || '?'} · 地区 ${region || '?'}`,
      );
      ok++;
    } catch (e) {
      console.log(`  ❌ ${env} 失败：${e.message}`);
      bad++;
    } finally {
      if (!closed) {
        try {
          await closeFoxPage(env, API);
        } catch (_) {
          /* 已经关了 */
        }
        closed = true;
      }
    }
    await sleep(GAP * 1000);
  }

  console.log('');
  console.log(`  合计：成功 ${ok} 个，失败 ${bad} 个`);
  console.log(`  资料文件：${PROFILES_FILE}`);
}

main().catch((e) => {
  console.log(`  ❌ 拉取失败：${e.message}`);
  process.exitCode = 1;
});
