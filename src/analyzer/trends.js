import fs from 'fs-extra';
import { dataPath } from '../paths.js';
import { openDB } from '../db.js';
import { formatLocalDate, localDateOffset } from '../organizer.js';

// 与写入方（collector/index.js）保持同一口径：走 paths.js 的数据目录，
// 原来写死 path.resolve('data/analytics.db') 在安装版会去读安装目录里的另一个库。
const DB_PATH = dataPath('data', 'analytics.db');

/**
 * 趋势分析：检测连续 N 天下滑
 *
 * 注意：daily_stats 的唯一键是 (date, account, platform, metric)。
 * 同一平台可能有多个账号，如果只按 platform 查会把不同账号的数据混在一条时间线上，
 * 产生假趋势 —— 所以这里按 account 分组，各自判断。
 *
 * @param {string} platform
 * @param {number} days
 */
export async function analyzeTrends(platform, days = 7) {
  if (!fs.existsSync(DB_PATH)) return [];
  const db = await openDB(DB_PATH, { readonly: true });

  const today = formatLocalDate();                       // 本地日期：toISOString() 是 UTC，会错一天
  const start = localDateOffset(today, -days);
  const metrics = ['followers', 'views', 'likes', 'comments'];
  const alerts = [];

  try {
    for (const metric of metrics) {
      let rows;
      try {
        rows = db.all(
          `SELECT date, account, value FROM daily_stats
           WHERE platform = ? AND metric = ? AND date >= ? AND date <= ?
           ORDER BY date ASC`,
          [platform, metric, start, today]
        );
      } catch (e) {
        // 表不存在 / 库损坏时不要连带把调用方打断
        console.warn(`  ⚠️ 趋势查询失败(${platform}/${metric}): ${e.message}`);
        continue;
      }

      const byAccount = new Map();
      for (const r of rows) {
        const key = r.account || 'default';
        if (!byAccount.has(key)) byAccount.set(key, []);
        byAccount.get(key).push(r.value);
      }

      for (const [account, values] of byAccount) {
        if (values.length < 3) continue;
        const recent = values.slice(-3);
        // 连续下降
        if (recent[0] > recent[1] && recent[1] > recent[2]) {
          alerts.push({
            platform,
            account,
            metric,
            trend: 'down_3_days',
            message: `${platform} ${account} ${metric} 连续3天下降`,
            values: recent,
          });
        }
      }
    }
  } finally {
    db.close();
  }

  return alerts;
}
