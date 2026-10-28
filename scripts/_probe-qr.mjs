/**
 * 只读探针：TikTok 网页版登录页的「扫码登录」入口长什么样、二维码怎么取。
 *   node scripts/_probe-qr.mjs [环境名]
 * 用一个临时环境（默认 TK99，不存在就照 TK01 的参数建一个），不开真实账号的环境。
 */
import { listFoxProfiles, foxCreateProfile } from '../src/collector/foxprofile.js';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const SCRATCH = (process.argv[2] || 'TK99').toUpperCase();

const profiles = await listFoxProfiles(API);
const names = profiles.map((p) => String(p.name));
const template = profiles.find((p) => p.name === 'TK01') || profiles[0] || {};
if (!names.includes(SCRATCH)) {
  await foxCreateProfile(
    {
      name: SCRATCH,
      proxy: template.proxy,
      osType: template.os_type || template.osType || 'windows',
      timezone: template.timezone,
      locale: template.locale,
      engine: template.engine || 'camoufox',
    },
    API,
  );
  console.log(`  ➕ 已建临时环境 ${SCRATCH}（照 ${template.name} 的参数）`);
}

try {
  const { page } = await openFoxPage(SCRATCH, API, { minimize: false });
  await page.goto('https://www.tiktok.com/login');
  await page.waitForTimeout(9000);

  const stage1 = await page.evaluate(() => {
    const txt = (document.body.innerText || '').replace(/\s+/g, ' ');
    const clickables = Array.from(document.querySelectorAll('a,button,div[role="button"],span,div'))
      .map((el) => ({
        t: (el.innerText || '').replace(/\s+/g, ' ').trim(),
        tag: el.tagName.toLowerCase(),
        w: Math.round(el.getBoundingClientRect().width),
        h: Math.round(el.getBoundingClientRect().height),
      }))
      .filter((c) => c.t && c.t.length < 60 && c.w > 20 && c.h > 12);
    const seen = new Set();
    const uniq = [];
    for (const c of clickables) {
      if (seen.has(c.t)) continue;
      seen.add(c.t);
      uniq.push(c);
    }
    return { url: location.href, text: txt.slice(0, 600), clickables: uniq.slice(0, 40) };
  });
  console.log('  URL:', stage1.url);
  console.log('  ── 登录页正文（前 400）──');
  console.log('  ' + stage1.text.slice(0, 400));
  console.log('  ── 可点元素 ──');
  stage1.clickables.forEach((c) => console.log(`    [${c.tag} ${c.w}x${c.h}] ${c.t}`));

  // 找「QR / 二维码」入口并点它
  const clicked = await page.evaluate(() => {
    const want = /qr|二维码|扫码|scan/i;
    const els = Array.from(document.querySelectorAll('a,button,div[role="button"],span,div'));
    const hits = els.filter((el) => {
      const t = (el.innerText || '').trim();
      const r = el.getBoundingClientRect();
      return t && t.length < 40 && want.test(t) && r.width > 20 && r.height > 12 && r.width < 400;
    });
    if (!hits.length) return { ok: false };
    // 取最内层（最小面积）
    hits.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
    const el = hits[0];
    const r = el.getBoundingClientRect();
    el.click();
    return { ok: true, text: (el.innerText || '').trim(), x: Math.round(r.x), y: Math.round(r.y) };
  });
  console.log('  点二维码入口:', JSON.stringify(clicked));
  await page.waitForTimeout(5000);

  const stage2 = await page.evaluate(() => {
    const txt = (document.body.innerText || '').replace(/\s+/g, ' ');
    const imgs = Array.from(document.querySelectorAll('img,canvas'))
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        src: (el.getAttribute('src') || '').slice(0, 120),
        w: Math.round(el.getBoundingClientRect().width),
        h: Math.round(el.getBoundingClientRect().height),
        cls: (el.getAttribute('class') || '').slice(0, 60),
      }))
      .filter((i) => i.w > 60 && i.h > 60);
    return { url: location.href, text: txt.slice(0, 600), big: imgs };
  });
  console.log('  点了之后 URL:', stage2.url);
  console.log('  ── 正文 ──');
  console.log('  ' + stage2.text.slice(0, 400));
  console.log('  ── 大图（可能是二维码）──');
  stage2.big.forEach((i) => console.log('   ', JSON.stringify(i)));
} catch (e) {
  console.error('  ❌', e.message);
} finally {
  await closeFoxPage(SCRATCH, API).catch(() => {});
}
