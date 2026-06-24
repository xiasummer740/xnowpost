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

  const stats = {};

  try {
    const data = await page.evaluate(() => {
      const text = document.body.innerText;
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      const found = {};
      const metrics = {
        followers: ['粉丝', '粉丝数', '关注者', 'Followers', 'Page followers', 'Likes', '赞'],
        reach: ['触达', '覆盖', '覆盖人数', 'Reach', 'People reached'],
        engagement: ['互动', 'Engagement', '互动次数'],
        views: ['播放', '观看', '视频播放', 'Views', 'Video views'],
        likes: ['点赞', 'Likes', 'Reactions'],
        comments: ['评论', 'Comments'],
        shares: ['分享', 'Shares', '转发'],
      };

      function getMatchedKeyword(line) {
        const lc = line.toLowerCase();
        for (const [key, keywords] of Object.entries(metrics)) {
          if (keywords.some(kw => lc.includes(kw.toLowerCase()))) return key;
        }
        return null;
      }

      let numFirstCount = 0, labelFirstCount = 0;
      for (let i = 1; i < lines.length; i++) {
        if (extractNum(lines[i - 1]) !== null && getMatchedKeyword(lines[i]) !== null) numFirstCount++;
        if (getMatchedKeyword(lines[i - 1]) !== null && extractNum(lines[i]) !== null) labelFirstCount++;
      }
      const useNumFirst = numFirstCount >= labelFirstCount;

      for (let i = 0; i < lines.length; i++) {
        const numVal = extractNum(lines[i]);
        if (numVal === null) continue;

        const sameLineKw = getMatchedKeyword(lines[i]);
        if (sameLineKw) {
          found[sameLineKw] = found[sameLineKw] !== undefined ? Math.max(found[sameLineKw], numVal) : numVal;
          continue;
        }

        const adjIdx = useNumFirst ? i + 1 : i - 1;
        if (adjIdx >= 0 && adjIdx < lines.length) {
          const adjKw = getMatchedKeyword(lines[adjIdx]);
          if (adjKw) {
            found[adjKw] = found[adjKw] !== undefined ? Math.max(found[adjKw], numVal) : numVal;
          }
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
    if (data.reach !== undefined) stats.reach = data.reach;
    if (data.engagement !== undefined) stats.engagement = data.engagement;
    if (data.views !== undefined) stats.views = data.views;
    if (data.likes !== undefined) stats.likes = data.likes;
    if (data.comments !== undefined) stats.comments = data.comments;
    if (data.shares !== undefined) stats.shares = data.shares;

    console.log(`  📊 Facebook 数据: ${JSON.stringify(stats)}`);
  } catch (e) {
    console.log('  ⚠️ Facebook 数据提取失败:', e.message);
  }

  return Object.keys(stats).length > 0 ? stats : null;
}
