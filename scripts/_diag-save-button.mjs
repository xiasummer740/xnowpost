/** 诊断：编辑资料弹窗里 Save / Apply / Cancel 各有多少个、哪个真的能点（只看不点保存） */
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const API = 'http://127.0.0.1:8000/api/v1';
const ENV = process.argv[2] || 'TK02';
const USER = process.argv[3] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { page } = await openFoxPage(ENV, API);
try {
  await page.goto(`https://www.tiktok.com/@${USER}`, { waitUntil: 'commit' });
  await sleep(7000);

  const norm = (arr) =>
    page.evaluate((want) => {
      const n = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
      const wants = want.map(n);
      const out = [];
      for (const el of document.querySelectorAll('button,div,span,a,li')) {
        const t = n(el.textContent);
        if (!wants.includes(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 12) continue;
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const inView = cx > 2 && cy > 2 && cx < window.innerWidth - 2 && cy < window.innerHeight - 2;
        const top = inView ? document.elementFromPoint(cx, cy) : null;
        const hit = !!(top && (top === el || el.contains(top) || top.contains(el)));
        out.push({
          text: String(el.textContent || '').trim(),
          tag: el.tagName,
          cls: String(el.className || '').slice(0, 40),
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          inView,
          hit,
          topTag: top ? top.tagName : null,
          topCls: top ? String(top.className || '').slice(0, 40) : null,
          disabled: el.disabled === true || /disabled/i.test(String(el.className || '')) || el.getAttribute('aria-disabled') === 'true',
        });
      }
      return out;
    }, arr);

  const entry = await norm(['Edit profile', '编辑资料']);
  console.log('  Edit profile 候选:', JSON.stringify(entry, null, 1));
  // 挑最内层、且该点最上层确实是它的那个（面积最小）
  const clicked = entry.filter((e) => e.inView && e.hit).sort((a, b) => a.rect[2] * a.rect[3] - b.rect[2] * b.rect[3])[0];
  if (clicked) {
    await page.mouse.click(clicked.rect[0] + clicked.rect[2] / 2, clicked.rect[1] + clicked.rect[3] / 2);
    await sleep(4000);
  } else console.log('  ⚠️ 没有可点的 Edit profile');

  // 先在简介里敲几个字，让 Save 变成可用状态（不保存，随后取消）
  const bioSel = 'textarea[data-e2e="edit-profile-bio-input"]';
  await page.locator(bioSel).click({ timeout: 15000 }).catch(() => {});
  await sleep(400);
  await page.keyboard.type('probe');
  await sleep(1200);

  console.log('\n  === 弹窗打开后（已改动简介） ===');
  for (const label of ['Save', 'Cancel']) {
    const c = await norm([label, label === 'Save' ? '保存' : '取消']);
    console.log(`  ${label} 候选 ${c.length} 个:`);
    for (const e of c) {
      console.log(
        `    ${e.tag}.${e.cls} rect=${e.rect.join(',')} inView=${e.inView} hit=${e.hit} disabled=${e.disabled} top=${e.topTag}.${e.topCls}`,
      );
    }
  }

  // 取消，不动数据
  const cancel = await norm(['Cancel', '取消']);
  const c2 = cancel.filter((e) => e.inView && e.hit).sort((a, b) => a.rect[2] * a.rect[3] - b.rect[2] * b.rect[3])[0];
  if (c2) {
    await page.mouse.click(c2.rect[0] + c2.rect[2] / 2, c2.rect[1] + c2.rect[3] / 2);
    console.log('\n  已点 Cancel（未保存任何改动）');
  }
} catch (e) {
  console.log('  ❌', e.message);
} finally {
  await closeFoxPage(ENV, API);
}
