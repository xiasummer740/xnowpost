/**
 * 采集结果的归一化 / 用户名兜底 —— 纯函数，故意独立成模块，方便单测（不 import 浏览器）
 */

/**
 * 调一次采集器并归一化返回（scraper 可能返回 { stats, username, insufficient } 或直接返回 stats）
 *
 * ⚠️ 2026-10-19 修的真凶（v1.6.3）：旧实现在 src/collector/index.js 里写的是
 *     `const stats = result && result.stats ? result.stats : result;`
 *   采集器没拿到数据时返回的是 `{stats: null, username: ''}`，`result.stats` 是 null（falsy）
 *   → `stats` 退回成**整个返回对象**，`Object.keys().length === 2 > 0` → 判定"有数据"！
 *   后果链：每个号都记成 ✅ → 一行也没写进 DB（值全是 null/'' 被过滤掉）
 *   → `allResults.length === 10` 骗过了"全军覆没判断" → 覆盖 collect-meta 时间戳
 *   → 界面显示"今天已采集"，实际 analytics.db 当天 0 行（2026-10-19 10:00 那轮实测）。
 *   现在：先认出包装对象，再要求**至少一个有限数字**，否则一律 null。
 */
export function normalizeResult(result) {
  if (!result || typeof result !== 'object') return { stats: null, username: '', insufficient: false, partial: false };

  // 包装对象：采集器按约定返回 { stats, username, insufficient, partial }
  const wrapped = !Array.isArray(result) && ('stats' in result || 'username' in result);
  const raw = wrapped ? result.stats : result;
  const username = String(result.username || '');
  const insufficient = !!result.insufficient;
  // partial = 分析页是占位符，但主页（粉丝/关注/获赞）读到了真数字
  const partial = !!result.partial;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { stats: null, username, insufficient, partial };

  // 只保留有限数字：0 是有效数据（"0 播放"是真话），null/''/'--'/NaN 都不是
  const numeric = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number' && Number.isFinite(v)) numeric[k] = v;
  }
  return {
    stats: Object.keys(numeric).length > 0 ? numeric : null,
    username,
    insufficient,
    partial,
  };
}

/**
 * 用户名兜底：页面抓不到就用本地已有的（`env-accounts.json` > 配置 accounts[].username）
 *
 * 为什么必须有：Studio 分析页**不显示 @handle**（2026-10-19 抓回来的 username 全是空串），
 * 而本地 `env-accounts.json` 里现成有 `ryloclyjdcf` 这种用户名 —— 不该靠抓页面。
 */
export function resolveUsername(scrapedUsername, envAccounts, configAccounts, envId, accountName) {
  const clean = (s) => String(s || '').trim().replace(/^@/, '');
  const fromScrape = clean(scrapedUsername);
  if (fromScrape) return fromScrape;

  const env = String(envId || '').trim();
  if (env && envAccounts && typeof envAccounts === 'object') {
    const hit = envAccounts[env];
    const u = clean(hit && (hit.username || hit.userName));
    if (u) return u;
  }
  const list = Array.isArray(configAccounts) ? configAccounts : [];
  const acc = list.find((a) => a && String(a.name) === String(accountName));
  return clean(acc && acc.username);
}
