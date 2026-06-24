export async function scrapeInstagram(page) {
  try {
    await page.goto('https://www.instagram.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
  } catch (e) {
    console.log('  ⚠️ Instagram 加载超时，跳过');
    return null;
  }

  await page.waitForTimeout(5000);

  const stats = {};

  try {
    // Instagram 个人主页的数据通常在页面文本中
    const data = await page.evaluate(() => {
      const text = document.body.innerText;
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      const found = {};
      const metrics = {
        followers: ['粉丝', '关注者', 'Followers', 'followers', 'follower'],
        following: ['正在关注', 'Following', 'following'],
        posts: ['帖子', 'Posts', 'posts', '篇'],
        likes: ['点赞', 'Likes', 'likes', '赞'],
        comments: ['评论', 'Comments', 'comments'],
        views: ['播放', '观看', 'Views', 'views', '次播放'],
      };

      function getMatchedKeyword(line) {
        const lc = line.toLowerCase();
        for (const [key, keywords] of Object.entries(metrics)) {
          if (keywords.some(kw => lc.includes(kw.toLowerCase()))) return key;
        }
        return null;
      }

      for (const line of lines) {
        // Instagram 个人主页常见格式: "1234 followers" 或 "1,234 followers"
        const numVal = extractNum(line);
        if (numVal === null) continue;

        const kw = getMatchedKeyword(line);
        if (kw) {
          // 同行可能有多个（如 "1,234 posts  5.6M followers  0 following"）
          // 取最大匹配值
          found[kw] = found[kw] !== undefined ? Math.max(found[kw], numVal) : numVal;
        }
      }

      return found;

      function extractNum(str) {
        const m = str.match(/(-?[\d,]+\.?\d*)\s*([KkMmB万]?)/);
        if (!m) return null;
        let num = parseFloat(m[1].replace(/,/g, ''));
        const suffix = m[2];
        if (suffix === 'K' || suffix === 'k') num *= 1000;
        else if (suffix === 'M' || suffix === 'm') num *= 1000000;
        else if (suffix === 'B' || suffix === 'b') num *= 1000000000;
        else if (suffix === '万') num *= 10000;
        return Math.round(num);
      }
    });

    if (data.followers !== undefined) stats.followers = data.followers;
    if (data.views !== undefined) stats.views = data.views;
    if (data.likes !== undefined) stats.likes = data.likes;
    if (data.comments !== undefined) stats.comments = data.comments;

    console.log(`  📊 Instagram 数据: ${JSON.stringify(stats)}`);
  } catch (e) {
    console.log('  ⚠️ Instagram 数据提取失败:', e.message);
  }

  return Object.keys(stats).length > 0 ? stats : null;
}
