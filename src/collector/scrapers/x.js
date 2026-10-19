import { readDashboard, extractMetrics } from './common.js';

/**
 * X (Twitter) Analytics 指标
 *
 * '曝光/Impressions' 才是浏览量口径；不要把它和 '主页访问' 混在一起取最大值。
 */
const METRICS = {
  followers: ['粉丝', '关注者', 'Followers', 'Follower count'],
  posts: ['推文', 'Tweets', '帖子'],
  likes: ['点赞', 'Likes', '赞'],
  retweets: ['转发', 'Retweets', '转推'],
  replies: ['回复', 'Replies'],
  views: ['曝光', '展示', 'Impressions', '观看', 'Views'],
  profile_views: ['主页访问', '主页浏览', 'Profile visits'],
};

export async function scrapeX(page) {
  try {
    await page.goto('https://analytics.twitter.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
  } catch (e) {
    console.log('  ⚠️ X (Twitter) Analytics 加载超时，跳过');
    return null;
  }

  await page.waitForTimeout(5000);

  // 未登录会被重定向到 x.com/i/flow/login 或 /login → 明确抛错
  const raw = await readDashboard(page, 'X');

  const data = extractMetrics({ lines: raw.lines, metrics: METRICS, platform: 'X' });

  const stats = {};
  if (data.followers !== undefined) stats.followers = data.followers;
  if (data.views !== undefined) stats.views = data.views;
  if (data.likes !== undefined) stats.likes = data.likes;
  if (data.profile_views !== undefined) stats.profile_views = data.profile_views;
  // 转发口径统一成 shares，避免下游指标名分裂
  if (data.shares !== undefined) stats.shares = data.shares;
  if (data.retweets !== undefined) stats.shares = data.retweets;

  console.log(`  📊 X (Twitter) 数据: ${JSON.stringify(stats)}`);
  if (Object.keys(stats).length === 0) {
    console.log('  ⚠️ 未提取到有效数据（页面结构可能已变化），不返回任何猜测值');
  }

  return Object.keys(stats).length > 0 ? stats : null;
}
