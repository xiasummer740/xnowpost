/**
 * 只读：看看网页版「设置」里有没有「转为商家号 / Switch to Business Account」的入口。
 *   node scripts/_probe-business.mjs TK01
 */
import fs from 'node:fs';
import path from 'node:path';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = (process.argv[2] || 'TK01').toUpperCase();
const DATA = process.env.APPDATA ? path.join(process.env.APPDATA, 'xnowpost') : '.';
const STATE = JSON.parse(fs.readFileSync(path.join(DATA, 'data', 'env-accounts.json'), 'utf8'));
const user = (STATE[ENV] && STATE[ENV].username) || '';

try {
  const { page } = await openFoxPage(ENV, API, { minimize: false });
  await page.goto('https://www.tiktok.com/setting');
  await page.waitForTimeout(8000);
  const s1 = await page.evaluate(() => ({
    url: location.href,
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1500),
    menu: Array.from(document.querySelectorAll('a, [role="link"], [role="menuitem"], li'))
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && t.length < 40)
      .slice(0, 40),
  }));
  console.log('  URL:', s1.url);
  console.log('  ── 设置页菜单项 ──');
  console.log('   ', JSON.stringify([...new Set(s1.menu)]));
  console.log('  含 business/商家:', /business|商家|professional/i.test(s1.text));
  console.log('  ── 正文（前 700 字）──');
  console.log('  ' + s1.text.slice(0, 700));

  // TikTok Studio 里也常放「账号类型 / Business info」
  await page.goto('https://www.tiktok.com/tiktokstudio/settings');
  await page.waitForTimeout(7000);
  const s2 = await page.evaluate(() => ({
    url: location.href,
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1200),
  }));
  console.log('\n  ── Studio 设置 ──');
  console.log('  URL:', s2.url);
  console.log('  含 business/商家:', /business|商家|professional/i.test(s2.text));
  console.log('  ' + s2.text.slice(0, 700));
} catch (e) {
  console.error('  ❌', e.message);
} finally {
  await closeFoxPage(ENV, API).catch(() => {});
}
