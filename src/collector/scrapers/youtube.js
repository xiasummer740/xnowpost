import { readDashboard, extractMetrics } from './common.js';

/** YouTube Studio 指标（subscribers 在返回时映射为下游统一的 followers） */
const METRICS = {
  subscribers: ['订阅者', '订阅人数', '订阅', 'Subscribers'],
  views: ['观看次数', '总观看', '观看', 'Views'],
  likes: ['点赞', 'Likes'],
  comments: ['评论', 'Comments'],
  watch_time: ['观看时长', 'Watch time'],
  videos: ['视频数', '上传', 'Videos'],
};

export async function scrapeYouTube(page) {
  try {
    await page.goto('https://studio.youtube.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
  } catch (e) {
    console.log('  ⚠️ YouTube Studio 加载超时，跳过');
    return null;
  }

  await page.waitForTimeout(6000);

  // 未登录会跳到 accounts.google.com → 明确抛错
  const raw = await readDashboard(page, 'YouTube');

  const data = extractMetrics({ lines: raw.lines, metrics: METRICS, platform: 'YouTube' });

  const stats = {};
  // YouTube 的 subscribers 映射到 followers（口径一致，便于日报聚合）
  if (data.subscribers !== undefined) stats.followers = data.subscribers;
  if (data.views !== undefined) stats.views = data.views;
  if (data.likes !== undefined) stats.likes = data.likes;
  if (data.comments !== undefined) stats.comments = data.comments;

  console.log(`  📊 YouTube 数据: ${JSON.stringify(stats)}`);
  if (Object.keys(stats).length === 0) {
    console.log('  ⚠️ 未提取到有效数据（页面结构可能已变化），不返回任何猜测值');
  }

  return Object.keys(stats).length > 0 ? stats : null;
}
