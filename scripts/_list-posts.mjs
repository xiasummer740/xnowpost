/**
 * 只读：列出某环境内容管理页前若干条作品（标题 + 时间），用来核对"点过发布但没确认"的那条到底发出去没。
 *   node scripts/_list-posts.mjs TK05
 * 不开新标签、不点任何按钮，读完就关环境。
 */
import { openFoxProfile, closeFoxProfile } from '../src/collector/foxprofile.js';

const env = process.argv[2] || 'TK05';
try {
  const { page } = await openFoxProfile(env, undefined, { minimize: true });
  await page.goto('https://www.tiktok.com/tiktokstudio/content');
  await page.waitForTimeout(8000);
  const rows = await page.evaluate(() => {
    const out = [];
    const els = Array.from(document.querySelectorAll('[class*="CellContainer"], [class*="video-item"]'));
    for (const el of els) {
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && t.length > 4) out.push(t.slice(0, 90));
      if (out.length >= 8) break;
    }
    return { url: location.href, count: els.length, rows: out };
  });
  console.log('  URL:', rows.url, '| 列表项:', rows.count);
  rows.rows.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
} catch (e) {
  console.error('  ❌', e.message);
} finally {
  await closeFoxProfile(env).catch(() => {});
}
