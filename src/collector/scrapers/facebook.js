import { readDashboard, extractMetrics } from './common.js';

/**
 * Facebook Creator Studio 指标
 *
 * 修正（P2-14）：原实现把 '赞 / Likes / Reactions' 也归到 followers，
 * 结果"点赞数"被当成粉丝数上报。这里把点赞类指标全部归到 likes，
 * followers 只保留真正的粉丝口径（Page followers / 粉丝）。
 */
const METRICS = {
  followers: ['粉丝', '粉丝数', '关注者', 'Page followers', 'Followers'],
  likes: ['点赞', '获赞', '主页获赞', 'Page likes', 'Likes', 'Reactions', '赞'],
  reach: ['触达', '覆盖人数', '覆盖', 'People reached', 'Reach'],
  engagement: ['互动次数', '互动', 'Engagement'],
  views: ['视频播放', '播放', '观看', 'Video views', 'Views'],
  comments: ['评论', 'Comments'],
  shares: ['分享', '转发', 'Shares'],
};

export async function scrapeFacebook(page) {
  try {
    await page.goto('https://business.facebook.com/creatorstudio/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
  } catch (e) {
    console.log('  ⚠️ Facebook Creator Studio 加载超时，跳过');
    return null;
  }

  await page.waitForTimeout(5000);

  // 未登录会跳到 facebook.com/login → 明确抛错
  const raw = await readDashboard(page, 'Facebook');

  const data = extractMetrics({ lines: raw.lines, metrics: METRICS, platform: 'Facebook' });

  const stats = {};
  if (data.followers !== undefined) stats.followers = data.followers;
  if (data.reach !== undefined) stats.reach = data.reach;
  if (data.engagement !== undefined) stats.engagement = data.engagement;
  if (data.views !== undefined) stats.views = data.views;
  if (data.likes !== undefined) stats.likes = data.likes;
  if (data.comments !== undefined) stats.comments = data.comments;
  if (data.shares !== undefined) stats.shares = data.shares;

  console.log(`  📊 Facebook 数据: ${JSON.stringify(stats)}`);
  if (Object.keys(stats).length === 0) {
    console.log('  ⚠️ 未提取到有效数据（页面结构可能已变化），不返回任何猜测值');
  }

  return Object.keys(stats).length > 0 ? stats : null;
}
