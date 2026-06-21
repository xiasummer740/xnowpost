export async function scrapeTikTok(page) {
  try {
    await page.goto('https://www.tiktok.com/creator-center/analytics', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
  } catch (e) {
    console.log('  ⚠️ TK 创作者后台加载超时，跳过');
    return null;
  }

  // 等待页面渲染完成（React 应用）
  await page.waitForTimeout(5000);

  const stats = {};

  try {
    // 方法1：通过页面文本提取数据（兼容新版 TikTok Studio）
    const data = await page.evaluate(() => {
      const text = document.body.innerText;

      // 按行分割
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      const found = {};
      // 常见指标关键词（中英）
      const metrics = {
        followers: ['Followers', '粉丝数', '关注者'],
        'video views': ['Video views', '视频播放', '播放量'],
        'profile views': ['Profile views', '主页访问', '主页浏览'],
        likes: ['Likes', '点赞数', '获赞'],
        comments: ['Comments', '评论数'],
        shares: ['Shares', '分享数', '转发'],
      };

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const [key, keywords] of Object.entries(metrics)) {
          if (found[key]) continue;
          const matched = keywords.some(kw => {
            // 精确匹配：行首关键词或以大写开头的关键词（排除搜索词等干扰）
            return line === kw || line.startsWith(kw + ' ') || line.startsWith(kw);
          });
          if (matched) {
            // 当前行或下一行找数字
            const val = extractNum(line);
            if (val !== null) {
              found[key] = val;
            } else if (i + 1 < lines.length) {
              const val2 = extractNum(lines[i + 1]);
              if (val2 !== null) found[key] = val2;
            }
          }
        }
      }

      return found;

      function extractNum(str) {
        // 匹配数字，可能带 K/M/万 后缀
        const m = str.match(/(-?[\d,]+\.?\d*)\s*([KkMm万]?)/);
        if (!m) return null;
        let num = parseFloat(m[1].replace(/,/g, ''));
        const suffix = m[2];
        if (suffix === 'K' || suffix === 'k') num *= 1000;
        else if (suffix === 'M' || suffix === 'm') num *= 1000000;
        else if (suffix === '万') num *= 10000;
        return Math.round(num);
      }
    });

    // 映射到标准字段
    if (data.followers !== undefined) stats.followers = data.followers;
    if (data['video views'] !== undefined) stats.views = data['video views'];
    if (data['profile views'] !== undefined) stats.profile_views = data['profile views'];
    if (data.likes !== undefined) stats.likes = data.likes;
    if (data.comments !== undefined) stats.comments = data.comments;
    if (data.shares !== undefined) stats.shares = data.shares;

    console.log(`  📊 TikTok 数据: ${JSON.stringify(stats)}`);
  } catch (e) {
    console.log('  ⚠️ TK 数据提取失败:', e.message);
  }

  return Object.keys(stats).length > 0 ? stats : null;
}
