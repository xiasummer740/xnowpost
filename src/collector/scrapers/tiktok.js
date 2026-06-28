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

  await page.waitForTimeout(8000)

  const stats = {}

  try {
    const pageInfo = await page.evaluate(() => {
      const text = document.body.innerText
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
      const hasLoginPrompt = /log\s*in|sign\*up|登录|注册/i.test(text)
      // 找 @用户名（多源探测：body、title、URL）
      let atUser = ''
      const bodyMatch = text.match(/@([\w.]+)/)
      const titleMatch = document.title?.match(/@([\w.]+)/)
      const urlMatch = window.location.href.match(/@([\w.]+)/)
      if (bodyMatch) atUser = bodyMatch[0]
      else if (titleMatch) atUser = titleMatch[0]
      else if (urlMatch) atUser = urlMatch[0]
      return { hasLoginPrompt, lineCount: lines.length, atUser, url: window.location.href, title: document.title, preview: lines.slice(0, 40) }
    })

    console.log(`  📋 页面 ${pageInfo.lineCount} 行, URL=${pageInfo.url}, title=${pageInfo.title}`)
    if (pageInfo.atUser) console.log(`  👤 发现用户名: ${pageInfo.atUser}`)
    else console.log(`  ⚠️ 页面未发现 @用户名（检查前40行是否有）`)
    console.log(`  📋 前10行: ${pageInfo.preview.slice(0, 10).join(' | ')}`)
    if (pageInfo.preview.length > 10) console.log(`  📋 后续: ${pageInfo.preview.slice(10, 25).join(' | ')}`)
    if (pageInfo.hasLoginPrompt) {
      console.log('  ⚠️ TikTok 未登录，跳过')
      return null
    }

    const data = await page.evaluate(() => {
      const text = document.body.innerText
      // 同时按换行和 | 分割（TikTok 用管道符布局）
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
      // 展平：每行再按 | 切开
      const tokens = []
      for (const line of lines) {
        const parts = line.split('|').map(s => s.trim()).filter(Boolean)
        tokens.push(...parts)
      }

      const found = {}

      // 指标关键词
      const metrics = {
        followers: ['粉丝', '关注者', 'Followers', 'follower'],
        following: ['关注', 'Following', 'following'],
        likes: ['点赞', '获赞', 'Likes', 'likes', '赞'],
        comments: ['评论', 'Comments', 'comments'],
        shares: ['分享', '转发', 'Shares', 'shares'],
        saves: ['收藏', 'Saves', 'saves', 'Bookmarks'],
        views: ['观看次数', '观看', '播放', '播放量', '视频播放', 'Views', 'views', 'Video views'],
        profile_views: ['主页访问', '主页浏览', 'Profile views', 'Profile visits'],
        reach: ['触达', '覆盖', 'Reach', 'reach'],
        engagement: ['互动', 'Engagement', 'engagement'],
        new_followers: ['新增粉丝', '新关注者', 'New followers'],
      }

      function extractNum(str) {
        const m = str.match(/([\d,]+\.?\d*)\s*([KkMm万亿]?)/)
        if (!m) return null
        let num = parseFloat(m[1].replace(/,/g, ''))
        const suffix = m[2]
        if (suffix === 'K' || suffix === 'k') num *= 1000
        else if (suffix === 'M' || suffix === 'm') num *= 1000000
        else if (suffix === '万' || suffix === 'w') num *= 10000
        else if (suffix === '亿') num *= 100000000
        return Math.round(num)
      }

      // 匹配关键词（token 包含关键词即可）
      function matchKw(token, keyword) {
        const t = token.toLowerCase()
        const kw = keyword.toLowerCase()
        return t === kw || t.startsWith(kw + ' ') || t.startsWith(kw + ':') || t.includes(kw)
      }

      function findKw(token) {
        const t = token.toLowerCase()
        for (const [key, keywords] of Object.entries(metrics)) {
          if (keywords.some(kw => matchKw(t, kw))) return key
        }
        return null
      }

      // 扫描 tokens：同行数字+关键词
      for (const token of tokens) {
        const num = extractNum(token)
        if (num === null) continue
        const kw = findKw(token)
        if (kw) {
          found[kw] = found[kw] !== undefined ? Math.max(found[kw], num) : num
        }
      }

      // 如果没找到几个，尝试相邻行匹配
      if (Object.keys(found).length < 3) {
        for (let i = 0; i < tokens.length; i++) {
          const num = extractNum(tokens[i])
          if (num === null || findKw(tokens[i])) continue
          // 找附近的关键词
          for (let d = 1; d <= 3; d++) {
            if (i - d >= 0) { const kw = findKw(tokens[i - d]); if (kw && found[kw] === undefined) { found[kw] = num; break } }
            if (i + d < tokens.length) { const kw = findKw(tokens[i + d]); if (kw && found[kw] === undefined) { found[kw] = num; break } }
          }
        }
      }

      return found
    })

    if (data.followers !== undefined) stats.followers = data.followers
    if (data.following !== undefined) stats.following = data.following
    if (data.views !== undefined) stats.views = data.views
    if (data.profile_views !== undefined) stats.profile_views = data.profile_views
    if (data.likes !== undefined) stats.likes = data.likes
    if (data.comments !== undefined) stats.comments = data.comments
    if (data.shares !== undefined) stats.shares = data.shares
    if (data.saves !== undefined) stats.saves = data.saves
    if (data.reach !== undefined) stats.reach = data.reach
    if (data.engagement !== undefined) stats.engagement = data.engagement
    if (data.new_followers !== undefined) stats.new_followers = data.new_followers

    // 提取 @用户名（从页面信息中取，不二次 evaluate）
    const username = pageInfo.atUser || ''
    if (username) console.log(`  👤 账号: ${username}`)

    console.log(`  📊 TikTok 数据: ${JSON.stringify(stats)}`)
    if (Object.keys(stats).length === 0) {
      console.log('  ⚠️ 未提取到有效数据')
    }

    // 返回数据 + 用户名
    return { stats: Object.keys(stats).length > 0 ? stats : null, username }
  } catch (e) {
    console.log('  ⚠️ TK 数据提取失败:', e.message)
  }

  return { stats: null, username: '' }
}
