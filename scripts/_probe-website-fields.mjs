/**
 * 只读：把「编辑资料」弹窗**局部**的完整内容打出来，确认有没有 Website/链接 字段。
 *   node scripts/_probe-website-fields.mjs TK01
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
  await page.goto(user ? `https://www.tiktok.com/@${user}` : 'https://www.tiktok.com/');
  await page.waitForTimeout(7000);
  await page.evaluate(() => {
    const el = document.querySelector('[data-e2e="edit-profile-entrance"]');
    if (el) el.click();
  });
  await page.waitForTimeout(4500);

  const out = await page.evaluate(() => {
    // 找弹窗容器：包含 Bio 输入框且 position:fixed 的祖先
    let box = document.querySelector('textarea[placeholder="Bio"]');
    while (box && box !== document.body) {
      const cs = getComputedStyle(box);
      if (cs.position === 'fixed' || box.getAttribute('role') === 'dialog') break;
      box = box.parentElement;
    }
    const scope = box || document.body;
    const inputs = Array.from(scope.querySelectorAll('input, textarea, select')).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      placeholder: el.getAttribute('placeholder') || '',
      maxlength: el.getAttribute('maxlength') || '',
      visible: !!(el.offsetWidth && el.offsetHeight),
    }));
    const labels = Array.from(scope.querySelectorAll('*'))
      .filter((el) => el.children.length === 0)
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && t.length < 30);
    return { found: !!box, text: (scope.innerText || '').replace(/\n{2,}/g, '\n'), inputs, labels: [...new Set(labels)] };
  });

  console.log('  找到弹窗容器:', out.found);
  console.log('  ── 弹窗内所有输入框 ──');
  out.inputs.forEach((i) => console.log('   ', JSON.stringify(i)));
  console.log('  ── 弹窗内所有短文本 ──');
  console.log('   ', JSON.stringify(out.labels));
  console.log('  ── 弹窗正文 ──');
  console.log(out.text.split('\n').map((l) => '   ' + l).join('\n'));
} catch (e) {
  console.error('  ❌', e.message);
} finally {
  await closeFoxPage(ENV, API).catch(() => {});
}
