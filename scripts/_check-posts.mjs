/**
 * 只读检查某个账号的内容管理页，确认最近有没有发出去
 *   node scripts/_check-posts.mjs TK05
 * 不开新标签、不点任何按钮，读完就关环境。
 */
import { openFoxProfile, closeFoxProfile } from '../src/collector/foxprofile.js';

const env = process.argv[2] || 'TK05';
let ok = false;
try {
  const { page } = await openFoxProfile(env);
  await page.goto('https://www.tiktok.com/tiktokstudio/content');
  await page.waitForTimeout(7000);
  const info = await page.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ');
    const items = Array.from(document.querySelectorAll('[class*="CellContainer"], [class*="video-item"], [data-e2e*="post"]'))
      .slice(0, 6)
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').slice(0, 120))
      .filter(Boolean);
    return {
      url: location.href,
      pending: /In review|审核|Posting|上传中/i.test(t),
      snippet: t.slice(0, 700),
      items,
    };
  });
  console.log('  URL:', info.url);
  console.log('  审核中:', info.pending);
  console.log('  列表项:', JSON.stringify(info.items, null, 1));
  console.log('  正文:', info.snippet);
  ok = true;
} catch (e) {
  console.error('  ❌ 检查失败:', e.message);
} finally {
  await closeFoxProfile(env).catch(() => {});
}
process.exitCode = ok ? 0 : 1;
