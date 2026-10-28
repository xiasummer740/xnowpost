/**
 * 只读探针：TikTok 个人主页上有没有可点链接、编辑资料弹窗里有没有「Website/链接」字段。
 *   node scripts/_probe-website.mjs TK01
 * 不填、不保存，读完关环境。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = (process.argv[2] || 'TK01').toUpperCase();

const DATA = process.env.APPDATA ? path.join(process.env.APPDATA, 'xnowpost') : '.';
const STATE = JSON.parse(fs.readFileSync(path.join(DATA, 'data', 'env-accounts.json'), 'utf8'));
const acct = STATE[ENV] || null;
const user = (acct && (acct.username || acct.handle)) || '';
console.log('  账号用户名:', user || '(没取到)');

try {
  const { page } = await openFoxPage(ENV, API, { minimize: false });
  await page.goto(user ? `https://www.tiktok.com/@${user}` : 'https://www.tiktok.com/');
  await page.waitForTimeout(8000);

  const profileInfo = await page.evaluate(() => {
    const bio = document.querySelector('[data-e2e="user-bio"]');
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => ({ href: a.getAttribute('href') || '', text: (a.innerText || '').trim().slice(0, 60) }))
      .filter((l) => l.text && /https?:/.test(l.href) && !/tiktok\.com/.test(l.href))
      .slice(0, 8);
    const follower = document.querySelector('[data-e2e="followers-count"]');
    return {
      url: location.href,
      bio: bio ? (bio.innerText || '').trim() : '(没有 bio 元素)',
      externalLinks: links,
      followers: follower ? (follower.textContent || '').trim() : '',
      hasEditBtn: !!document.querySelector('[data-e2e="edit-profile-entrance"]'),
    };
  });
  console.log('  ── 个人主页 ──');
  console.log('  URL:', profileInfo.url);
  console.log('  粉丝:', profileInfo.followers, '| 有编辑按钮:', profileInfo.hasEditBtn);
  console.log('  bio:', JSON.stringify(profileInfo.bio));
  console.log('  可点外链:', JSON.stringify(profileInfo.externalLinks));

  const dialog = await page.evaluate(() => {
    const el = document.querySelector('[data-e2e="edit-profile-entrance"]');
    if (!el) return { opened: false };
    el.click();
    return { opened: true };
  });
  console.log('  点「编辑资料」:', JSON.stringify(dialog));
  await page.waitForTimeout(4500);

  const fields = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, textarea'))
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        placeholder: el.getAttribute('placeholder') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        maxlength: el.getAttribute('maxlength') || '',
        visible: !!(el.offsetWidth && el.offsetHeight),
      }))
      .filter((i) => i.visible);
    const txt = (document.body.innerText || '').replace(/\s+/g, ' ');
    return { inputs, txt: txt.slice(0, 1200) };
  });
  console.log('  ── 编辑资料弹窗里的可见输入框 ──');
  fields.inputs.forEach((i) => console.log('   ', JSON.stringify(i)));
  console.log('  ── 弹窗正文（前 700 字）──');
  console.log('  ' + fields.txt.slice(0, 700));
  console.log('  含 Website/网址 字样:', /website|网址|链接/i.test(fields.txt));
} catch (e) {
  console.error('  ❌', e.message);
} finally {
  await closeFoxPage(ENV, API).catch(() => {});
}
