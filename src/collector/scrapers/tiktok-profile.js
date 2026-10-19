/**
 * 账号主页的「粉丝 / 关注 / 获赞」—— Studio 分析页根本不给这三个数，
 * 但主页资料卡（`data-e2e="followers-count"` 等）一定给，而且是真实值。
 *
 * 为什么单独一个模块：采集器爬完分析页后**复用同一个浏览器环境**把主页也读一遍
 * （不额外开窗口、不多花时间），比事后再跑一遍 `tk-profile-sync.mjs` 划算。
 *
 * 只读不点：不登录、不点关注、不改任何东西。
 */

/** 把 "1.2K" / "3.4M" / "1,234" / "47" / "--" 解析成数字（解析不了返回 null） */
export function parseCount(text) {
  if (text === null || text === undefined) return null;
  let s = String(text).trim().replace(/,/g, '').replace(/\s+/g, '');
  if (!s || s === '--' || s === '-' || s === '—') return null;
  const m = s.match(/^([\d.]+)\s*([KkMmBb万]?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  const mul = unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : unit === 'b' ? 1e9 : unit === '万' ? 1e4 : 1;
  return Math.round(n * mul);
}

/** 页面里读资料卡（页面侧函数，evaluate 里跑） */
const EXTRACT_COUNTS = `(() => {
  const t = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    // ⚠️ 必须优先读**元素文本**：TikTok 的写法是
    //   <strong title="Followers" data-e2e="followers-count">0</strong>
    //   —— title 是"这是粉丝数"的标签，不是数字本身（2026-10-19 踩过：读 title 拿到 "Followers"）
    const v = (el.textContent || '').trim() || (el.getAttribute('title') || '').trim();
    return v || null;
  };
  return {
    followers: t('[data-e2e="followers-count"]'),
    following: t('[data-e2e="following-count"]'),
    likes: t('[data-e2e="likes-count"]'),
    title: (document.querySelector('[data-e2e="user-title"]')?.textContent || '').trim(),
    handle: (document.querySelector('[data-e2e="user-subtitle"]')?.textContent || '').trim(),
  };
})()`;

/**
 * 打开主页读三个数（粉丝/关注/获赞）
 * @returns {Promise<{followers:number|null, following:number|null, total_likes:number|null, handle:string}|null>}
 *          页面没加载出资料卡时返回 null（不抛错：采集不该因为主页慢就整轮失败）
 */
export async function scrapeProfileCounts(page, username, { attempts = 12, intervalMs = 1000 } = {}) {
  const handle = String(username || '').replace(/^@/, '').trim();
  if (!handle) return null;
  try {
    await page.goto(`https://www.tiktok.com/@${encodeURIComponent(handle)}`, { waitUntil: 'commit', timeout: 25000 });
  } catch (e) {
    console.log(`  ⚠️ 主页打开超时（${handle}）：${String(e.message || e).slice(0, 80)}`);
    return null;
  }

  let raw = null;
  for (let i = 0; i < attempts; i++) {
    await page.waitForTimeout(intervalMs);
    raw = await page.evaluate(EXTRACT_COUNTS).catch(() => null);
    // 三个数里只要有一个读出来了就够用（新号"0 粉"也是真值）
    if (raw && (raw.followers !== null || raw.following !== null || raw.likes !== null)) break;
  }
  if (!raw || (raw.followers === null && raw.following === null && raw.likes === null)) {
    console.log(`  ⚠️ 主页没读出粉丝/关注/获赞（${handle}）`);
    return null;
  }
  const out = {
    followers: parseCount(raw.followers),
    following: parseCount(raw.following),
    total_likes: parseCount(raw.likes),
    handle: String(raw.handle || '').replace(/^@/, '').trim(),
  };
  // 元素在但解析不出数字时把原始值打出来（免得像"什么都没发生"一样静默）
  if (out.followers === null && out.following === null && out.total_likes === null) {
    console.log(
      `  ⚠️ 主页元素读到了但解析不出数字：粉丝="${raw.followers}" 关注="${raw.following}" 获赞="${raw.likes}"`
    );
    return null;
  }
  return out;
}
