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
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';
import { judgeProfileCompleteness, isNavigationInterrupted } from '../src/profile-quality.js';

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
    // 头像是不是真的加载出来了（页面上没加载完时 src 可能还在、尺寸还是 0）
    avatarLoaded: (() => {
      const el = document.querySelector('img[class*="ImgAvatar"]') || document.querySelector('img.user-avatar');
      return !!(el && el.naturalWidth >= 40);
    })(),
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
      const { page } = await openFoxPage(env, API, { minimize: true });   // 只读：不用看窗口，缩到任务栏
      // ⚠️ 必须带 cache-buster：2026-10-20 实测，不带参数的 /@user 会被 Camoufox/TikTok 边缘缓存住，
      // 读回来的是**上一次**的昵称/简介/头像地址（用户口径「资料抓的不准」就是它），
      // 而错得"很像真的"（字段齐全、头像也能下载），比报错更难发现。
      const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}?lang=en&_r=${Date.now()}`;
      // 2026-10-21 13:41 实测：TikTok 自己会把带参数的地址**跳回干净地址**
      // （`Navigation ... is interrupted by another navigation to https://www.tiktok.com/@user`），
      // Playwright 把这个跳转当成异常抛出来 → 整轮判失败，而页面其实已经打开了。
      // 这种"页面自己跳转"对我们无害（目标还是同一个主页），容忍它，继续等资料卡。
      try {
        await page.goto(profileUrl, { waitUntil: 'commit' });
      } catch (e) {
        const msg = String(e?.message || '');
        if (!/interrupted by another navigation|NS_BINDING_ABORTED|navigation aborted/i.test(msg)) throw e;
        console.log('     ↪️ 页面自己跳回了不带参数的地址（TikTok 会去掉 ?_r=），继续等资料卡');
      }
      // 等资料卡出现（最多 25 秒）；头像 <img> 真的加载出来（naturalWidth>=40）才算数
      let data = null;
      for (let i = 0; i < 25; i++) {
        await page.waitForTimeout(1000);
        data = await page.evaluate(EXTRACT).catch(() => null);
        if (data && (data.nickname || data.followers) && data.avatarLoaded) break;
      }
      // 被打断/读到空 → 再试一次（TikTok 去掉参数后可能直接吃缓存；换一种参数再要一次）
      if (!data || (!data.nickname && !data.followers)) {
        console.log('     🔁 第一次没读到资料卡，换参数再要一次...');
        try {
          await page.goto(`https://www.tiktok.com/@${encodeURIComponent(username)}?lang=en&_t=${Date.now()}`, {
            waitUntil: 'commit',
          });
        } catch (e) {
          if (!isNavigationInterrupted(e)) throw e;
        }
        for (let i = 0; i < 25; i++) {
          await page.waitForTimeout(1000);
          data = await page.evaluate(EXTRACT).catch(() => null);
          if (data && (data.nickname || data.followers) && data.avatarLoaded) break;
        }
      }
      if (!data || (!data.nickname && !data.followers)) {
        throw new Error('页面没加载出资料卡（可能被验证/未登录）');
      }
      if (data.blocked && !data.followers) throw new Error('页面要求登录或人机验证');
      // 再读一遍：两次一致才采信（防止拿到半渲染的中间态）
      await page.waitForTimeout(2500);
      const data2 = await page.evaluate(EXTRACT).catch(() => null);
      if (data2 && (data2.nickname || data2.followers)) {
        const diff = ['nickname', 'bio', 'followers', 'following', 'likes'].filter((k) => data2[k] !== data[k]);
        if (diff.length) console.log(`     ℹ️ 两次读数不一致（${diff.join('/')}）→ 用后一次`);
        data = data2;
      }

      let info = { createTime: '', email: '', screenName: '', region: '' };
      try {
        info = (await page.evaluate(FETCH_INFO)) || info;
      } catch (_) {
        /* 拿不到就算了 */
      }
      // 地区：接口不给 → 用账号文件里那一列（登录时写进状态文件）
      let region = info.region || regionFromAccountFile(env, cfg, state);

      // 头像落盘（CDN 图不需要登录态）
      // 除了存图，还要存**内容哈希**：只比 URL 会被签名参数骗过去，
      // 只有哈希才能回答「线上这张到底换没换」（2026-10-20 被平台换回头像就是这样发现的）。
      const prev = profiles[env] || {};
      let avatarFile = '';
      const downloadAvatar = async (url) => {
        const sep = url.includes('?') ? '&' : '?';
        const res = await fetch(`${url}${sep}_cb=${Date.now()}`, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 500) throw new Error(`图片太小（${buf.length} 字节）`);
        return buf;
      };
      if (data.avatar && /^https?:/.test(data.avatar)) {
        try {
          let buf = await downloadAvatar(data.avatar);
          let sha = crypto.createHash('sha1').update(buf).digest('hex');
          // 和上次一模一样时再确认一次：可能页面上还是缓存的旧 src
          if (prev.avatarSha && sha === prev.avatarSha) {
            await page.waitForTimeout(3000);
            const again = await page.evaluate(EXTRACT).catch(() => null);
            if (again && again.avatar && again.avatar !== data.avatar) {
              console.log('     ℹ️ 头像地址变了（刚才是缓存的旧地址）→ 重新下载');
              data.avatar = again.avatar;
              buf = await downloadAvatar(data.avatar);
              sha = crypto.createHash('sha1').update(buf).digest('hex');
            }
          }
          const f = path.join(AVATAR_DIR, `${env}.jpg`);
          fs.writeFileSync(f, buf);
          avatarFile = f;
          data.avatarSha = sha;
          if (prev.avatarSha && prev.avatarSha !== sha) {
            console.log(`     🖼️ 头像内容变了：${prev.avatarSha.slice(0, 8)} → ${sha.slice(0, 8)}`);
          }
        } catch (e) {
          console.log(`     ⚠️ 头像下载失败：${e.message}`);
          // 下载失败就保留上一次的结论，别把已有信息抹掉
          data.avatarSha = prev.avatarSha || '';
        }
      }

      const handle = String(data.handle || '').replace(/^@/, '').trim() || username;
      // 「No bio yet.」是 TikTok 的空简介占位文案，不是用户写的简介 —— 存成空串，
      // 否则界面/日报会把平台的默认提示当成"他自己写的"，这也是"资料不准"的一种。
      const bioRaw = String(data.bio || '').trim();
      const bio = /^no bio yet\.?$/i.test(bioRaw) ? '' : bioRaw;
      const sha = data.avatarSha || prev.avatarSha || '';
      // 「平台把头像换回了」：我们上传时记下过 intended 哈希，现在线上不是那张
      const intended = prev.avatarIntendedSha || '';
      const reverted = !!(intended && sha && sha !== intended);
      profiles[env] = {
        username: handle,
        nickname: data.nickname || '',
        avatarFile,
        avatarUrl: data.avatar || '',
        avatarSha: sha,
        avatarChangedAt:
          prev.avatarSha && sha && prev.avatarSha !== sha
            ? new Date().toISOString()
            : prev.avatarChangedAt || prev.fetchedAt || '',
        // 改资料脚本上传成功后写进来，用来判断"线上这张还是不是我们传的那张"
        avatarIntendedSha: intended,
        avatarIntendedAt: prev.avatarIntendedAt || '',
        avatarReverted: reverted,
        avatarRevertedAt: reverted ? prev.avatarRevertedAt || new Date().toISOString() : '',
        followers: data.followers || '',
        following: data.following || '',
        likes: data.likes || '',
        bio,
        verified: !!data.verified,
        region,
        createTime: info.createTime || '',
        email: info.email || '',
        fetchedAt: new Date().toISOString(),
      };
      writeJson(PROFILES_FILE, profiles);
      if (reverted) {
        console.log(
          `  ⚠️ ${env} 头像已经不是我们上传的那张了（线上 ${sha.slice(0, 8)} ≠ 上传 ${intended.slice(0, 8)}）→ 疑似被平台换回`,
        );
      }

      // 顺手把真实用户名补进状态文件
      state[env] = { ...(state[env] || {}), username: handle };
      writeJson(STATE_FILE, state);

      // ⚠️ 抓到了 ≠ 资料是好的：2026-10-20 23:36 实测 TK07 昵称被平台退回成用户名、简介为空，
      // 旧代码照样打 ✅，看日志的人会以为一切正常。现在把这种情况单独标出来。
      const nickStr = String(data.nickname || '').trim();
      // 判定口径与单测共用一份（tests/unit/profile-quality.test.js）
      const { problems } = judgeProfileCompleteness({
        username: handle, nickname: nickStr, bio, avatarUrl: data.avatar, avatarSha: sha,
      });
      const mark = problems.length ? '⚠️' : '✅';
      console.log(
        `  ${mark} ${env} ${nickStr || handle} · 粉丝 ${data.followers || '?'} / 关注 ${data.following || '?'} / 赞 ${data.likes || '?'} · 地区 ${region || '?'}`,
      );
      if (problems.length) {
        console.log(`     ↳ ${problems.join('、')}（资料抓取成功，但账号资料不完整，多半是平台侧改的）`);
      }
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
