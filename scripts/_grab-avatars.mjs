/**
 * 抓「线上真实头像」并落盘，用于和原图比对（证明头像到底换没换）。
 * 用法：node scripts/_grab-avatars.mjs TK01 TK03 TK07 TK08
 */
import fs from 'node:fs';
import path from 'node:path';
import { foxLaunch, foxStop } from '../src/collector/foxprofile.js';

const envs = process.argv.slice(2).filter((a) => /^TK\d+$/.test(a));
const outDir = path.join('output', 'avatars-after');
fs.mkdirSync(outDir, { recursive: true });

const SCRIPT = `(() => {
  const imgs = Array.from(document.querySelectorAll('img'))
    .map((i) => { const r = i.getBoundingClientRect(); return { src: i.src || '', nw: i.naturalWidth || 0, top: r.top, w: r.width }; })
    .filter((i) => i.nw >= 100 && i.src.includes('avt'))
    .sort((a, b) => b.w - a.w);
  return JSON.stringify({
    url: location.pathname,
    avatar: imgs.length ? imgs[0].src : '',
  });
})()`;

const rows = [];
for (const env of envs) {
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
    const file = path.join(outDir, `${env}.jpg`);
    let bytes = 0;
    if (d.avatar) {
      const img = await fetch(d.avatar);
      const buf = Buffer.from(await img.arrayBuffer());
      fs.writeFileSync(file, buf);
      bytes = buf.length;
    }
    rows.push({ env, url: d.url, avatar: d.avatar, bytes, file: bytes ? file : '' });
    console.log(`  ${env} ${d.url}  ${bytes ? `${Math.round(bytes / 1024)}KB → ${file}` : '没拿到头像图'}`);
  } catch (e) {
    console.log(`  ${env} 失败: ${e.message}`);
  } finally {
    await foxStop(env, undefined).catch(() => {});
  }
}

fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(rows, null, 2), 'utf8');
console.log(`  索引: ${path.join(outDir, 'index.json')}`);
