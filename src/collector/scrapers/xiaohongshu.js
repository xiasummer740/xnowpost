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

  const stats = {};

  try {
    const data = await page.evaluate(() => {
      const text = document.body.innerText;
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      const found = {};
      // 小红书创作者后台常用指标词汇
      const metrics = {
        followers: ['粉丝', '粉丝数', '关注者', 'Followers'],
        views: ['浏览', '浏览量', '播放量', '笔记曝光', '曝光量'],
        likes: ['点赞', '获赞', '获赞数', 'Likes', '赞'],
        comments: ['评论', '评论数'],
        shares: ['收藏', '收藏数', '分享', '转发'],
        engagement: ['互动', '互动数', '互动量'],
        notes: ['笔记数', '笔记', '发布数'],
      };

      function getMatchedKeyword(line) {
        const lc = line.toLowerCase();
        for (const [key, keywords] of Object.entries(metrics)) {
          if (keywords.some(kw => {
            const klc = kw.toLowerCase();
            return lc === klc || lc.startsWith(klc + ' ') || lc.includes(klc);
          })) return key;
        }
        return null;
      }

      // 检测布局方向
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
        const m = str.match(/(-?[\d,]+\.?\d*)\s*([KkMm万]?)/);
        if (!m) return null;
        let num = parseFloat(m[1].replace(/,/g, ''));
        const suffix = m[2];
        if (suffix === 'K' || suffix === 'k') num *= 1000;
        else if (suffix === 'M' || suffix === 'm') num *= 1000000;
        else if (suffix === '万' || suffix === 'w') num *= 10000;
        return Math.round(num);
      }
    });

    if (data.followers !== undefined) stats.followers = data.followers;
    if (data.views !== undefined) stats.views = data.views;
    if (data.likes !== undefined) stats.likes = data.likes;
    if (data.comments !== undefined) stats.comments = data.comments;
    if (data.shares !== undefined) stats.shares = data.shares;
    if (data.engagement !== undefined) stats.engagement = data.engagement;

    console.log(`  📊 小红书数据: ${JSON.stringify(stats)}`);
  } catch (e) {
    console.log('  ⚠️ 小红书数据提取失败:', e.message);
  }

  return Object.keys(stats).length > 0 ? stats : null;
}
