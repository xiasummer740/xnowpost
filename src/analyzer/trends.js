import path from 'path';
import { openDB } from '../db.js';

const DB_PATH = path.resolve('data/analytics.db');

export async function analyzeTrends(platform, days = 7) {
  const db = await openDB(DB_PATH, { readonly: true });

  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

  const metrics = ['followers', 'views', 'likes', 'comments'];
  const alerts = [];

  for (const metric of metrics) {
    const rows = db.all(
      `SELECT date, value FROM daily_stats
       WHERE platform = ? AND metric = ? AND date >= ? AND date <= ?
       ORDER BY date ASC`,
      [platform, metric, weekAgo, today]
    );

    if (rows.length < 3) continue;

    // 检测连续下降
    const recent = rows.slice(-3);
    if (recent[0].value > recent[1].value && recent[1].value > recent[2].value) {
      alerts.push({
        platform,
        metric,
        trend: 'down_3_days',
        message: `${platform} ${metric} 连续3天下降`,
        values: recent.map(r => r.value),
      });
    }
  }

  db.close();
  return alerts;
}
