/**
 * 日志文件保留策略（纯函数，单测在 tests/unit/log-prune.test.js）
 *
 * 用户问「日志多了占不占内存」——
 *   内存：不占。`logBuffer` 硬上限 500 行，日志写文件后就不再驻留内存。
 *   磁盘：一天两份文件（app + scheduler）各 0.1~0.3 MB，30 天也就 10 MB 上下，
 *         但**以前没人清理**，从 2026-06 攒到 10 月也就 30 个文件 / 2.95 MB。
 * 所以这里做一层温和的保留策略：只删**超过保留天数**的 `app-<日期>.log` /
 * `scheduler-<日期>.log`，其它文件（备份、JSON 证据、别的日志）一概不碰。
 */

const LOG_NAME_RE = /^(app|scheduler)-(\d{4}-\d{2}-\d{2})\.log$/;

/**
 * @param {Array<{name:string, mtimeMs:number}>} files 目录里的文件
 * @param {{nowMs?:number, days?:number}} [opts]
 * @returns {string[]} 要删除的文件名
 */
export function pickLogsToPrune(files, { nowMs = Date.now(), days = 30 } = {}) {
  const list = Array.isArray(files) ? files : [];
  if (!Number.isFinite(days) || days <= 0) return [];
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  const out = [];
  for (const f of list) {
    const name = String(f && f.name || '');
    if (!LOG_NAME_RE.test(name)) continue;
    const mt = Number(f && f.mtimeMs);
    if (!Number.isFinite(mt)) continue;
    if (mt < cutoff) out.push(name);
  }
  return out;
}

/**
 * 按文件名里的日期判断（比 mtime 可靠：拷贝/恢复过的文件 mtime 会变，
 * 但文件名里的日期就是那天）。只删「日期早于 cutoffDate」的文件。
 * @param {Array<{name:string}>} files
 * @param {{today:string, days?:number}} opts today = 'YYYY-MM-DD'（本地日期）
 */
export function pickLogsByDate(files, { today, days = 30 } = {}) {
  const list = Array.isArray(files) ? files : [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return [];
  if (!Number.isFinite(days) || days <= 0) return [];
  const t = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) return [];
  const cutoff = new Date(t.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const out = [];
  for (const f of list) {
    const m = String(f && f.name || '').match(LOG_NAME_RE);
    if (!m) continue;
    if (m[2] < cutoff) out.push(f.name);   // 日期串定长，直接比大小
  }
  return out;
}
