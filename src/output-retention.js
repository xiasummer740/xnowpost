/**
 * `output/` 保留策略（纯函数，单测在 tests/unit/output-retention.test.js）
 *
 * 用户口径（2026-10-19）：**保留 15 天**，超出只清「中间件 + 调试产物」，
 * `video.mp4` / `封面.png` / 文案 / `.published` / 各种 JSON 证据**一律保留**（它们是交付物/凭证）。
 *
 * 只清这两类（2026-10-19 实测 22 个 15 天前的目录里：expanded_debug.html 221 个 51.9 MB、
 * `_video/` 84.1 MB）：
 *   ① `<会话>/expanded_debug.html`   —— 每次发布都写一份，纯调试用
 *   ② `<会话>/_video/**`             —— 配音/分镜/切片等中间件
 * 明确**不碰**：video.mp4、封面.png、scene_*.png、文案.txt/描述.txt、.published、
 * browser-trace.json、cost.json、publish.log、page-events.log、eye-*.png 等证据。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 15 天前那天的日期串（本地日期口径，和日志一致） */
export function cutoffDate({ today, days = 15 }) {
  if (!DATE_RE.test(String(today || ''))) return '';
  if (!Number.isFinite(days) || days <= 0) return '';   // 0/负数 = 不清理
  const t = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) return '';
  return new Date(t.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * @param {string[]} names output 下的目录名
 * @param {{today:string, days?:number}} opts
 * @returns {string[]} 需要清理的日期目录名（早于 cutoff）
 */
export function pickOldDateDirs(names, { today, days = 15 } = {}) {
  const cut = cutoffDate({ today, days });
  if (!cut) return [];
  return (Array.isArray(names) ? names : [])
    .filter((n) => DATE_RE.test(String(n || '')) && String(n) < cut);
}

/**
 * 这条路径该不该删（相对会话目录，统一用 / 分隔）。
 * 只认中间件和调试产物；其它一律 false（保守，宁可不删）。
 */
export function isCleanable(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p) return false;
  const parts = p.split('/');
  if (parts.includes('_video')) return true;                       // _video 目录连同内容
  if (p === 'expanded_debug.html' || p.endsWith('/expanded_debug.html')) return true;
  return false;
}
