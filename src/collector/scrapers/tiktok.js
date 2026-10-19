import { readDashboard, extractMetrics, pickAtUsername } from './common.js';
import { scrapeProfileCounts } from './tiktok-profile.js';

/**
 * TikTok 创作者后台指标
 *
 * 说明（P2-14）：解析统一交给 common.js 做"标签绑定 + 指标区限制"，
 * 未登录时 readDashboard 直接抛错，不再返回首页/视频列表里的猜测数字。
 * 注意 '关注者'(粉丝) 与 '关注'(关注中) 依赖词边界区分，不能写成 includes。
 */
const METRICS = {
  followers: ['粉丝', '粉丝数', '关注者', 'Followers', 'Follower count'],
  following: ['关注', 'Following', 'following'],
  views: ['观看次数', '视频播放', '播放量', '观看', 'Video views', 'Views'],
  profile_views: ['主页访问', '主页浏览', 'Profile views', 'Profile visits'],
  likes: ['点赞', '获赞', 'Likes', '赞'],
  comments: ['评论', 'Comments'],
  shares: ['分享', '转发', 'Shares'],
  saves: ['收藏', 'Saves', 'Bookmarks'],
  reach: ['触达', '覆盖', 'Reach'],
  engagement: ['互动', 'Engagement'],
  new_followers: ['新增粉丝', '新关注者', 'New followers'],
};

/**
 * 页面上的指标是不是「占位符」状态（TikTok 尚未给出数据）
 *
 * 2026-10-19 实测：账号数据不足时 Studio 分析页照样完整渲染，只是每个指标显示
 * `Video views -- 0 (--)` —— `--` 是"还没有数据"，后面那个 `0` 是"环比 0"。
 * 这时抓 DOM 只会拿到 `--`，必须明确判成「数据不足」，
 * 不能报成「页面结构变了」（两者的处置完全不同：一个要等数据，一个要改选择器）。
 */
export function looksInsufficient(lines = []) {
  const arr = Array.isArray(lines) ? lines.map((s) => String(s || '').trim()) : [];
  const labels = ['Video views', 'Profile views', 'Likes', 'Comments', 'Shares', '观看次数', '主页访问', '点赞', '评论', '分享'];
  let placeholders = 0;
  let hits = 0;
  for (let i = 0; i < arr.length; i++) {
    if (!labels.includes(arr[i])) continue;
    hits++;
    // 标签后面紧跟的那个元素是 `--` 就是占位
    if (arr[i + 1] === '--' || arr[i + 1] === '-' || arr[i + 1] === '—') placeholders++;
  }
  // 一个真数字都没有、且至少命中一个占位 → 数据不足
  return hits > 0 && placeholders === hits;
}

export async function scrapeTikTok(page, { username: wantUser } = {}) {
  try {
    await page.goto('https://www.tiktok.com/creator-center/analytics', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
  } catch (e) {
    console.log('  ⚠️ TK 创作者后台加载超时，跳过');
    return null;
  }

  await page.waitForTimeout(8000);

  // 未登录 / 页面为空 → 这里直接抛错（明确报错，不编造数据）
  const raw = await readDashboard(page, 'TikTok');

  console.log(`  📋 页面 ${raw.lines.length} 行, URL=${raw.url}, title=${raw.title}`);
  console.log(`  📋 前10行: ${raw.lines.slice(0, 10).join(' | ')}`);
  if (raw.lines.length > 10) console.log(`  📋 后续: ${raw.lines.slice(10, 25).join(' | ')}`);

  const stats = extractMetrics({ lines: raw.lines, metrics: METRICS, platform: 'TikTok' });
  const username = pickAtUsername(raw.lines.join('\n'), raw.url) || String(wantUser || '').replace(/^@/, '').trim();
  const insufficient = looksInsufficient(raw.lines);

  if (username) console.log(`  👤 账号: @${username}`);
  console.log(`  📊 TikTok 数据: ${JSON.stringify(stats)}`);
  if (Object.keys(stats).length === 0) {
    if (insufficient) {
      console.log('  ℹ️ 数据不足：TikTok 分析页指标显示为「--」（账号还没有可用数据，不是页面结构变了）');
    } else {
      console.log('  ⚠️ 未提取到有效数据（页面结构可能已变化），不返回任何猜测值');
    }
  }

  // 分析页永远不给粉丝/关注/获赞（Followers 页对 <100 粉的号也只给 0 + "达到 100 粉解锁"），
  // 但账号主页的资料卡一定给 —— 复用同一个环境顺路读一遍，不额外开窗口。
  const profile = username ? await scrapeProfileCounts(page, username) : null;
  const merged = { ...stats };
  let gotProfile = 0;
  if (profile) {
    for (const k of ['followers', 'following', 'total_likes']) {
      if (typeof profile[k] === 'number' && Number.isFinite(profile[k])) {
        merged[k] = profile[k];
        gotProfile++;
      }
    }
    if (gotProfile) {
      console.log(`  👥 主页资料: 粉丝 ${profile.followers ?? '?'} / 关注 ${profile.following ?? '?'} / 获赞 ${profile.total_likes ?? '?'}`);
    }
  } else {
    console.log('  ℹ️ 没读到主页资料（粉丝/关注/获赞），本条只报分析页的数字');
  }

  const out = Object.keys(merged).length > 0 ? merged : null;
  // 分析页是占位符，但主页读数成功 → 照样入库（0 粉是真实数据），
  // 只是要把"播放/点赞/评论仍然缺"这件事传上去，界面上说清楚。
  return {
    stats: out,
    username,
    insufficient: insufficient && gotProfile === 0,
    partial: insufficient && gotProfile > 0,
  };
}
