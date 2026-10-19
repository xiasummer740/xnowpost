import { readDashboard, extractMetrics } from './common.js';

/** 小红书创作者后台指标 */
const METRICS = {
  followers: ['粉丝', '粉丝数', '关注者', 'Followers'],
  views: ['浏览量', '笔记曝光', '曝光量', '浏览'],
  likes: ['点赞', '获赞数', '获赞', 'Likes', '赞'],
  comments: ['评论数', '评论'],
  shares: ['收藏数', '收藏', '分享', '转发'],
  engagement: ['互动数', '互动量', '互动'],
  notes: ['笔记数', '发布数', '笔记'],
};

export async function scrapeXiaohongshu(page) {
  try {
    await page.goto('https://creator.xiaohongshu.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
  } catch (e) {
    console.log('  ⚠️ 小红书创作者后台加载超时，跳过');
    return null;
  }

  await page.waitForTimeout(5000);

  // 未登录会跳到登录页（URL 不含 creator 后台路径）→ 明确抛错
  const raw = await readDashboard(page, '小红书');

  const stats = extractMetrics({ lines: raw.lines, metrics: METRICS, platform: '小红书' });

  console.log(`  📊 小红书数据: ${JSON.stringify(stats)}`);
  if (Object.keys(stats).length === 0) {
    console.log('  ⚠️ 未提取到有效数据（页面结构可能已变化），不返回任何猜测值');
  }

  return Object.keys(stats).length > 0 ? stats : null;
}
