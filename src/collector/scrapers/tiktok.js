export async function scrapeTikTok(page) {
  // 导航到 TK 创作者后台（祥哥后续提供 URL）
  try {
    await page.goto('https://www.tiktok.com/creator-center/analytics', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
  } catch (e) {
    console.log('  ⚠️ TK 创作者后台加载超时，跳过');
    return null;
  }

  await page.waitForTimeout(3000);

  const stats = {};

  // 粉丝数 — 选择器待祥哥给页面后确认
  try {
    const followerEl = await page.$('[data-testid="followers-count"], .follower-count');
    if (followerEl) {
      const text = await followerEl.textContent();
      stats.followers = parseNumber(text);
    }
  } catch (e) {
    console.log('  ⚠️ TK 粉丝数提取失败');
  }

  return Object.keys(stats).length > 0 ? stats : null;
}

function parseNumber(text) {
  if (!text) return 0;
  text = text.replace(/,/g, '').trim();
  if (text.match(/[Kk]/)) return Math.round(parseFloat(text) * 1000);
  if (text.match(/[Mm]/)) return Math.round(parseFloat(text) * 1000000);
  if (text.includes('万')) return Math.round(parseFloat(text) * 10000);
  return parseInt(text, 10) || 0;
}
