/**
 * 复核：开环境读「线上真实头像 URL」，和批次开始前记录的 URL 比对。
 * 用法：node scripts/_verify-avatar.mjs TK01 TK03 TK07 TK08
 */
import { foxLaunch, foxStop } from '../src/collector/foxprofile.js';

const envs = process.argv.slice(2).filter((a) => /^TK\d+$/.test(a));
if (!envs.length) {
  console.log('用法: node scripts/_verify-avatar.mjs TK01 TK03 ...');
  process.exit(1);
}

const SCRIPT = `(() => {
  const pick = () => {
    const a = document.querySelector('img[class*="ImgAvatar"]') || document.querySelector('img[class*="Avatar"]');
    return a ? String(a.src || '') : '';
  };
  const big = () => {
    const imgs = Array.from(document.querySelectorAll('img'))
      .map((i) => ({ src: i.src || '', w: i.naturalWidth || 0, h: i.naturalHeight || 0, r: i.getBoundingClientRect() }))
      .filter((i) => i.w > 60 && i.r.top > 0)
      .sort((a, b) => b.w - a.w);
    return imgs.length ? imgs[0].src : '';
  };
  return JSON.stringify({
    url: location.pathname,
    avatar: pick().split('?')[0],
    biggest: big().split('?')[0],
    text: ((document.body && document.body.innerText) || '').slice(0, 60).replace(/\\s+/g, ' '),
  });
})()`;

for (const env of envs) {
  const t0 = Date.now();
  let line = `  ${env}: `;
  try {
    await foxLaunch(env, undefined, { focus: false });
    await new Promise((r) => setTimeout(r, 7000));
    const res = await fetch(`http://127.0.0.1:8000/api/v1/browser/${env}/page/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ script: SCRIPT }),
    });
    const j = await res.json();
    const d = typeof j.result === 'string' ? JSON.parse(j.result) : j.result;
    const tail = (s) => (s ? (String(s).split('/').pop() || '').slice(0, 34) : '(无)');
    line += `${d.url}  头像=${tail(d.avatar)}  最大图=${tail(d.biggest)}  (${Math.round((Date.now() - t0) / 1000)}s)`;
  } catch (e) {
    line += `读失败: ${e.message}`;
  } finally {
    await foxStop(env, undefined).catch(() => {});
  }
  console.log(line);
}
