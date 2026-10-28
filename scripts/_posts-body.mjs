/**
 * 只读：把某环境「内容管理页」的正文完整打出来（不截断），用于核对某条到底发没发。
 *   node scripts/_posts-body.mjs TK05 [关键字]
 */
import { openFoxProfile, closeFoxProfile } from '../src/collector/foxprofile.js';

const env = process.argv[2] || 'TK05';
const kw = process.argv[3] || '';
try {
  const { page } = await openFoxProfile(env, undefined, { minimize: true });
  await page.goto('https://www.tiktok.com/tiktokstudio/content');
  await page.waitForTimeout(9000);
  const info = await page.evaluate(() => ({
    url: location.href,
    body: (document.body.innerText || '').replace(/\s+/g, ' '),
  }));
  console.log('  URL:', info.url, '| 正文长度:', info.body.length);
  console.log('  ---');
  console.log('  ' + info.body);
  if (kw) console.log('\n  含关键字「' + kw + '」:', info.body.includes(kw));
  console.log('  含 In review / 审核中:', /In review|审核中|Under review/i.test(info.body));
} catch (e) {
  console.error('  ❌', e.message);
} finally {
  await closeFoxProfile(env).catch(() => {});
}
