import { sendMessage } from '../notifier.js';

const platformEmoji = {
  tiktok: '🎵',
  xiaohongshu: '📕',
  facebook: '📘',
  instagram: '📸',
  youtube: '▶️',
  x: '𝕏',
};

const metricLabels = {
  followers: '粉',
  views: '播',
  likes: '赞',
  comments: '评',
  shares: '转',
  reach: '触达',
  engagement: '互动',
};

function getYesterday(dateStr) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

/**
 * @param {string} date - 日期 YYYY-MM-DD
 * @param {Array} todayResults - 当日采集结果
 * @param {object} db - db 实例（来自 src/db.js openDB），可选
 */
export async function generateDailyReport(date, todayResults, db) {
  const yesterday = getYesterday(date);
  const timeStr = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');

  // 如果有用户名，取第一个账号的用户名显示
  const firstUser = (todayResults || []).find(r => r.username)?.username || '';

  const lines = [
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📊 <b>XNOW 数据日报 · ${date}</b>${firstUser ? ` · ${firstUser}` : ''} 🕐${timeStr}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
  ];

  for (const { platform, stats } of (todayResults || [])) {
    const emoji = platformEmoji[platform] || '📡';
    const nameMap = {
      tiktok: 'TikTok', xiaohongshu: '小红书', facebook: 'Facebook',
      instagram: 'Instagram', youtube: 'YouTube', x: 'X',
    };
    const name = nameMap[platform] || platform;

    const parts = [`${emoji} <b>${name}</b>`];

    for (const [metric, value] of Object.entries(stats)) {
      const label = metricLabels[metric] || metric;

      if (db) {
        const yesterdayRow = db.get(
          'SELECT value FROM daily_stats WHERE date = ? AND platform = ? AND metric = ?',
          [yesterday, platform, metric]
        );

        if (yesterdayRow && yesterdayRow.value !== undefined) {
          const diff = value - yesterdayRow.value;
          const arrow = diff >= 0 ? '↑' : '↓';
          parts.push(`${label} ${formatNum(value)} ${arrow}${formatNum(Math.abs(diff))}`);
        } else {
          parts.push(`${label} ${formatNum(value)}`);
        }
      } else {
        parts.push(`${label} ${formatNum(value)}`);
      }
    }

    if (parts.length > 1) {
      lines.push(parts.join(' | '));
    }
  }

  lines.push('');
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━`);

  const text = lines.join('\n');

  try {
    await sendMessage(text);
    console.log('✅ 日报已推送到 TG');
  } catch (err) {
    console.error('❌ 日报推送失败:', err.message);
  }
}

function formatNum(n) {
  if (n >= 10000) {
    return (n / 10000).toFixed(1) + '万';
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1) + 'K';
  }
  return String(n);
}
