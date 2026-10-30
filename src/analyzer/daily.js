import { sendMessage, isTelegramConfigured } from '../notifier.js';
import { formatLocalDate, localDateOffset } from '../organizer.js';

const platformEmoji = {
  tiktok: '🎵',
  xiaohongshu: '📕',
  facebook: '📘',
  instagram: '📸',
  youtube: '▶️',
  x: '𝕏',
};

const platformName = {
  tiktok: 'TikTok',
  xiaohongshu: '小红书',
  facebook: 'Facebook',
  instagram: 'Instagram',
  youtube: 'YouTube',
  x: 'X',
};

const metricLabels = {
  followers: '粉',
  views: '播',
  likes: '赞',
  comments: '评',
  shares: '转',
  reach: '触达',
  engagement: '互动',
  following: '关注',
  posts: '帖',
  notes: '笔记',
  saves: '藏',
  profile_views: '主页',
  new_followers: '新增粉',
};

/** HTML 转义：日报走 Telegram parse_mode=HTML，账号名等动态字段转义后才不会把消息打成语法错误 */
function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 生成并推送数据日报
 *
 * @param {string} date - 日期 YYYY-MM-DD（本地日期）
 * @param {Array} todayResults - 当日采集结果 [{ account, platform, stats, username }]
 * @param {object} db - db 实例（来自 src/db.js openDB），用于环比；不传则只输出绝对值
 */
export async function generateDailyReport(date, todayResults, db) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : formatLocalDate();
  // 环比要查"昨天"，必须按本地日历算（原实现经 toISOString 走 UTC，00:00–08:00 会错一天）
  const yesterday = localDateOffset(day, -1);
  const timeStr = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
  const results = Array.isArray(todayResults) ? todayResults.filter(r => r && typeof r === 'object') : [];

  // 如果有用户名，取第一个账号的用户名显示
  const firstUser = results.find(r => r.username)?.username || '';

  const lines = [
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📊 <b>XNOW 数据日报 · ${escapeHtml(day)}</b>${firstUser ? ` · ${escapeHtml(firstUser)}` : ''} 🕐${escapeHtml(timeStr)}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
  ];

  let dbUsable = !!db;
  let missingStats = 0;
  let emitted = 0;   // 真正写进日报的"账号×平台"行数

  for (const item of results) {
    // 模板保护：缺 platform/stats 的条目以前会在这里抛 TypeError，把整个日报（含后续推送）打断
    if (!item.stats || typeof item.stats !== 'object' || Array.isArray(item.stats)) {
      missingStats++;
      continue;
    }

    const platform = item.platform || 'unknown';
    const account = item.account || 'default';
    const emoji = platformEmoji[platform] || '📡';
    const name = platformName[platform] || platform;
    const parts = [`${emoji} <b>${escapeHtml(name)}</b>`];

    // 只认数值型指标：字符串/NaN 一律跳过，避免脏数据进模板
    const entries = Object.entries(item.stats)
      .filter(([, v]) => typeof v === 'number' && Number.isFinite(v));
    if (entries.length === 0) continue;

    for (const [metric, value] of entries) {
      const label = metricLabels[metric] || metric;

      if (dbUsable) {
        let yesterdayRow;
        try {
          // 环比必须带 account 维度：daily_stats 的唯一键是 (date, account, platform, metric)，
          // 原查询漏了 account，多账号时会把别人的值当作自己的"昨天"
          yesterdayRow = db.get(
            'SELECT value FROM daily_stats WHERE date = ? AND account = ? AND platform = ? AND metric = ?',
            [yesterday, account, platform, metric]
          );
        } catch (e) {
          console.warn(`  ⚠️ 日报环比查询失败，后续改为只报绝对值: ${e.message}`);
          dbUsable = false;
        }

        if (yesterdayRow && yesterdayRow.value !== undefined && yesterdayRow.value !== null) {
          const diff = value - Number(yesterdayRow.value);
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
      emitted++;
    }
  }

  if (missingStats > 0) {
    console.warn(`  ⚠️ 日报跳过 ${missingStats} 个缺 stats 的采集结果`);
  }

  lines.push('');
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━`);

  const text = lines.join('\n');

  // 一个数字都没有 → 别推一条只有标题的"空日报"（2026-10-19：10 个号全空，还照样走推送流程）
  if (emitted === 0) {
    console.log('  ⚠️ 日报没有可报的数字（所有账号都没采到数据），本轮不推送');
    return { sent: false, skipped: true, empty: true, text };
  }

  // TG 没配 ≠ 推送失败：不能再把"没配 token"混进"未确认送达"里（会让人以为推送坏了）
  // ⚠️ 措辞别带「失败」两个字：日志级别是按关键词判的（`失败：`/`Error:`/`...失败`），
  //    2026-10-30 就因为这句里含「不算推送失败」被记成一条 [ERROR]，界面上多出一个假错误。
  if (!isTelegramConfigured()) {
    console.log('  ℹ️ TG 未配置（缺 TG_BOT_TOKEN）：日报只留在本地日志，不算推送异常');
    return { sent: false, skipped: true, text };
  }

  try {
    const res = await sendMessage(text);
    // sendMessage 失败时不抛异常（旧版甚至吞掉错误），所以要看返回值再决定是不是"已送达"
    if (res) console.log('✅ 日报已推送到 TG');
    else console.log('⚠️ 日报未确认送达：TG 已配置但没拿到响应（见上方错误日志）');
    return { sent: !!res, text };
  } catch (err) {
    console.error('❌ 日报推送失败:', err.message);
    return { sent: false, text };
  }
}

function formatNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  if (v >= 10000) {
    return (v / 10000).toFixed(1) + '万';
  }
  if (v >= 1000) {
    return (v / 1000).toFixed(1) + 'K';
  }
  return String(v);
}
