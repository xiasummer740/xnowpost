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

  const stats = {};

  try {
    const data = await page.evaluate(() => {
      const text = document.body.innerText;
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      const found = {};
      const metrics = {
        subscribers: ['订阅', '订阅者', '订阅人数', 'Subscribers', 'subscribers'],
        views: ['观看', '观看次数', 'Views', 'views', '总观看'],
        likes: ['点赞', 'Likes', 'like'],
        comments: ['评论', 'Comments', 'comment'],
        watch_time: ['观看时长', 'Watch time', 'watch time'],
        videos: ['视频', 'Videos', '视频数', '上传'],
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
        const m = str.match(/(-?[\d,]+\.?\d*)\s*([KkMmB万亿]?)/);
        if (!m) return null;
        let num = parseFloat(m[1].replace(/,/g, ''));
        const suffix = m[2];
        if (suffix === 'K' || suffix === 'k') num *= 1000;
        else if (suffix === 'M' || suffix === 'm') num *= 1000000;
        else if (suffix === 'B' || suffix === 'b') num *= 1000000000;
        else if (suffix === '万') num *= 10000;
        else if (suffix === '亿') num *= 100000000;
        return Math.round(num);
      }
    });

    // YouTube 的 subscribers 映射到 followers
    if (data.subscribers !== undefined) stats.followers = data.subscribers;
    if (data.views !== undefined) stats.views = data.views;
    if (data.likes !== undefined) stats.likes = data.likes;
    if (data.comments !== undefined) stats.comments = data.comments;

    console.log(`  📊 YouTube 数据: ${JSON.stringify(stats)}`);
  } catch (e) {
    console.log('  ⚠️ YouTube 数据提取失败:', e.message);
  }

  return Object.keys(stats).length > 0 ? stats : null;
}
