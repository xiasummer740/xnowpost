/** 临时验证：FoxProfile 的 /page/evaluate「页面指纹」接口能不能用、快不快 */
import { foxLaunch, foxStop } from '../src/collector/foxprofile.js';

const env = process.argv[2] || 'TK01';
const SCRIPT = `(() => {
  const txt = (document.body && document.body.innerText) || '';
  let h = 0;
  for (let i = 0; i < txt.length; i++) { h = (h * 31 + txt.charCodeAt(i)) | 0; }
  const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
  const overlays = Array.from(document.querySelectorAll('[role="dialog"],div[class*="Modal"]'))
    .filter((e) => area(e) > 20000)
    .map((e) => (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80))
    .filter(Boolean);
  const ava = document.querySelector('img[class*="ImgAvatar"]');
  return JSON.stringify({
    url: location.pathname,
    len: txt.length,
    h: h,
    overlays,
    avatar: (ava && ava.src || '').split('?')[0],
  });
})()`;

await foxLaunch(env, undefined, { focus: false });
console.log(`  已开 ${env}，等 8 秒加载...`);
await new Promise((r) => setTimeout(r, 8000));

for (let i = 1; i <= 3; i++) {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:8000/api/v1/browser/${env}/page/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ script: SCRIPT }),
  });
  const j = await res.json();
  const ms = Date.now() - t0;
  const out = typeof j.result === 'string' ? j.result : JSON.stringify(j.result);
  console.log(`  第 ${i} 次 ${ms}ms: ${String(out).slice(0, 220)}`);
  await new Promise((r) => setTimeout(r, 500));
}

await foxStop(env, undefined).catch(() => {});
console.log('  已关闭环境');
