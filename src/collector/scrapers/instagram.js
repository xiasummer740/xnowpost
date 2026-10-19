import { readDashboard, extractMetrics, pickAtUsername } from './common.js';

/**
 * Instagram 账号指标
 *
 * 修正（P2-14）：原实现直接抓 https://www.instagram.com/ 首页信息流，
 * 把推荐帖子的点赞/播放数当成"账号指标"。这里改为：
 *   1. 优先用配置里的 username 打开自己的主页；
 *   2. 没有 username 时从侧边栏找"个人主页"入口；
 *   3. 找不到主页就**明确报错**，绝不拿首页信息流的数字充数；
 *   4. 解析范围只限主页头部（粉丝/关注/帖子），且用 header 文本而不是整页。
 */
const METRICS = {
  followers: ['粉丝', '关注者', 'Followers'],
  following: ['正在关注', '关注中', 'Following'],
  posts: ['帖子', 'Posts', '篇'],
};

export async function scrapeInstagram(page, opts = {}) {
  const user = String(opts.username || '').replace(/^@/, '').trim();

  try {
    await page.goto(user ? `https://www.instagram.com/${encodeURIComponent(user)}/` : 'https://www.instagram.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
  } catch (e) {
    console.log('  ⚠️ Instagram 加载超时，跳过');
    return null;
  }

  await page.waitForTimeout(5000);

  // 未登录会被重定向到 /accounts/login/ → readDashboard 直接抛错
  await readDashboard(page, 'Instagram');

  if (!user) {
    // 首页信息流 ≠ 账号数据，必须定位到自己的主页
    const href = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      const hit = links.find(el => {
        const label = el.getAttribute('aria-label') || '';
        const text = el.textContent || '';
        return /个人主页|profile/i.test(label) || /个人主页|profile/i.test(text);
      });
      if (!hit) return '';
      try {
        return new URL(hit.getAttribute('href'), location.origin).pathname;
      } catch (e) {
        return '';
      }
    });

    if (!href) {
      throw new Error('Instagram 未能在配置里找到该账号的 username，也无法自动定位"个人主页"入口：为避免把首页信息流的数字当成账号指标，本次不返回数据（请在配置页填写 username）');
    }

    await page.goto(`https://www.instagram.com${href}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(4000);
  }

  const state = await page.evaluate(() => {
    const header = document.querySelector('main header') || document.querySelector('header');
    return { url: location.href, text: header ? header.innerText : '' };
  });

  if (!/instagram\.com\/[^/?#]+\/?/.test(state.url) || /\/(explore|reels|direct|accounts)\//.test(state.url)) {
    console.log(`  ⚠️ Instagram 当前页面不是账号主页: ${state.url}`);
  }

  const lines = String(state.text || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 40);

  if (lines.length === 0) {
    throw new Error('Instagram 未能读取账号主页头部（页面结构可能已变化）：为避免编造指标，本次不返回数据');
  }

  const stats = extractMetrics({ lines, metrics: METRICS, platform: 'Instagram', zoneLines: 40 });
  const username = user ? `@${user}` : pickAtUsername('', state.url);

  console.log(`  📊 Instagram 数据: ${JSON.stringify(stats)}`);
  if (Object.keys(stats).length === 0) {
    console.log('  ⚠️ 未提取到有效数据（页面结构可能已变化），不返回任何猜测值');
  }

  return { stats: Object.keys(stats).length > 0 ? stats : null, username };
}
