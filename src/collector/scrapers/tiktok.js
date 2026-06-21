export async function scrapeTikTok(page) {
  try {
    await page.goto('https://www.tiktok.com/creator-center/analytics', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    })
  } catch (e) {
    console.log('  ⚠️ TK 创作者后台加载超时，跳过')
    return null
  }

  // 等待页面渲染完成（React 应用）
  await page.waitForTimeout(5000)

  const stats = {}

  try {
    // 方法1：通过页面文本提取数据（兼容新版 TikTok Studio）
    const data = await page.evaluate(() => {
      const text = document.body.innerText

      // 按行分割
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)

      const found = {}
      // 常见指标关键词（中英）
      const metrics = {
        followers: ['Followers', '粉丝数', '关注者'],
        'video views': ['Video views', '视频播放', '播放量'],
        'profile views': ['Profile views', '主页访问', '主页浏览'],
        likes: ['Likes', '点赞数', '获赞'],
        comments: ['Comments', '评论数'],
        shares: ['Shares', '分享数', '转发'],
      }

      // 判断页面中指标关键词是否匹配某行
      function getMatchedKeyword(line) {
        const lc = line.toLowerCase()
        for (const [key, keywords] of Object.entries(metrics)) {
          if (keywords.some(kw => {
            const klc = kw.toLowerCase()
            return lc === klc || lc.startsWith(klc + ' ') || lc.startsWith(klc)
          })) return key
        }
        return null
      }

      // 检测页面布局：数字在上 → 标签在下（num-first）or 标签在上 → 数字在下（label-first）
      let numFirstCount = 0, labelFirstCount = 0
      for (let i = 1; i < lines.length; i++) {
        if (extractNum(lines[i - 1]) !== null && getMatchedKeyword(lines[i]) !== null) numFirstCount++
        if (getMatchedKeyword(lines[i - 1]) !== null && extractNum(lines[i]) !== null) labelFirstCount++
      }
      const useNumFirst = numFirstCount >= labelFirstCount

      // 扫描：从有数值的行出发，按布局方向找关联关键词
      for (let i = 0; i < lines.length; i++) {
        const numVal = extractNum(lines[i])
        if (numVal === null) continue

        // 同行关键词优先（如 "Followers 12.5K"）
        const sameLineKw = getMatchedKeyword(lines[i])
        if (sameLineKw) {
          found[sameLineKw] = found[sameLineKw] !== undefined ? Math.max(found[sameLineKw], numVal) : numVal
          continue
        }

        // 按布局方向查相邻行
        const adjIdx = useNumFirst ? i + 1 : i - 1
        if (adjIdx >= 0 && adjIdx < lines.length) {
          const adjKw = getMatchedKeyword(lines[adjIdx])
          if (adjKw) {
            found[adjKw] = found[adjKw] !== undefined ? Math.max(found[adjKw], numVal) : numVal
          }
        }
      }

      return found

      function extractNum(str) {
        // 匹配数字，可能带 K/M/万 后缀
        const m = str.match(/(-?[\d,]+\.?\d*)\s*([KkMm万]?)/)
        if (!m) return null
        let num = parseFloat(m[1].replace(/,/g, ''))
        const suffix = m[2]
        if (suffix === 'K' || suffix === 'k') num *= 1000
        else if (suffix === 'M' || suffix === 'm') num *= 1000000
        else if (suffix === '万') num *= 10000
        return Math.round(num)
      }

      function extractPureNum(str) {
        // 整行必须是纯数值（可能带 K/M/万 后缀），排除 "Followers 1" 等混合行
        const m = str.match(/^([\d,]+\.?\d*)\s*([KkMm万]?)$/)
        if (!m) return null
        let num = parseFloat(m[1].replace(/,/g, ''))
        const suffix = m[2]
        if (suffix === 'K' || suffix === 'k') num *= 1000
        else if (suffix === 'M' || suffix === 'm') num *= 1000000
        else if (suffix === '万') num *= 10000
        return Math.round(num)
      }
    })

    // 映射到标准字段
    if (data.followers !== undefined) stats.followers = data.followers
    if (data['video views'] !== undefined) stats.views = data['video views']
    if (data['profile views'] !== undefined) stats.profile_views = data['profile views']
    if (data.likes !== undefined) stats.likes = data.likes
    if (data.comments !== undefined) stats.comments = data.comments
    if (data.shares !== undefined) stats.shares = data.shares

    console.log(`  📊 TikTok 数据: ${JSON.stringify(stats)}`)
  } catch (e) {
    console.log('  ⚠️ TK 数据提取失败:', e.message)
  }

  return Object.keys(stats).length > 0 ? stats : null
}
