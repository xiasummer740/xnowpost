/** 诊断：TikTok 网页版「编辑资料」弹窗结构（只看不改） */
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const API = 'http://127.0.0.1:8000/api/v1';
const ENV = process.argv[2] || 'TK01';
const USER = process.argv[3] || 'ryloclyjdcf';

const { page } = await openFoxPage(ENV, API);
try {
  await page.goto(`https://www.tiktok.com/@${USER}`, { waitUntil: 'commit' });
  await page.waitForTimeout(8000);

  // 1) 找「Edit profile」按钮并点（用中心坐标点，TikTok 按钮不是 <button>）
  const box = await page.evaluate(() => {
    const want = ['edit profile', '编辑资料', 'editprofile'];
    const els = [...document.querySelectorAll('a,button,div,span')];
    const hit = els.reverse().find((el) => {
      const t = (el.textContent || '').trim().toLowerCase();
      const r = el.getBoundingClientRect();
      return (
        want.some((w) => t === w || t.replace(/\s+/g, '') === w.replace(/\s+/g, '')) &&
        r.width > 40 &&
        r.height > 20 &&
        el.children.length <= 2
      );
    });
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { text: (hit.textContent || '').trim(), x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  });
  console.log('  Edit 按钮:', JSON.stringify(box));
  if (!box) throw new Error('没找到 Edit profile 按钮');

  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(4000);

  const info = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 8;
    };
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const inputs = [...document.querySelectorAll('input, textarea')].filter(vis).map((el) => ({
      tag: el.tagName,
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      ph: el.getAttribute('placeholder') || '',
      e2e: el.getAttribute('data-e2e') || '',
      val: (el.value || '').slice(0, 40),
      maxlength: el.getAttribute('maxlength') || '',
      disabled: el.disabled,
      rect: r(el),
    }));
    const buttons = [...document.querySelectorAll('button, div[role="button"], a')].filter(vis).map((el) => ({
      t: (el.textContent || '').trim().slice(0, 30),
      e2e: el.getAttribute('data-e2e') || '',
      rect: r(el),
    })).filter((b) => b.t);
    const fileInputs = [...document.querySelectorAll('input[type=file]')].map((el) => ({
      accept: el.getAttribute('accept') || '',
      e2e: el.getAttribute('data-e2e') || '',
    }));
    const labels = [...document.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && vis(el) && (el.textContent || '').trim().length < 24)
      .map((el) => (el.textContent || '').trim())
      .slice(0, 60);
    return { url: location.href, inputs, buttons: buttons.slice(0, 25), fileInputs, labels };
  });

  console.log('  URL:', info.url);
  console.log('  --- 输入框 ---');
  for (const i of info.inputs) console.log('   ', JSON.stringify(i));
  console.log('  --- 文件选择器 ---');
  for (const f of info.fileInputs) console.log('   ', JSON.stringify(f));
  console.log('  --- 按钮 ---');
  for (const b of info.buttons) console.log('   ', JSON.stringify(b));
  console.log('  --- 可见短文本 ---');
  console.log('    ' + [...new Set(info.labels)].join(' | ').slice(0, 600));
} catch (e) {
  console.log('  ❌', e.message);
} finally {
  await closeFoxPage(ENV, API);
}
