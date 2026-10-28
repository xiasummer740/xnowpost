/**
 * 候选素材挑选：每个镜头抓多条候选 → 抽帧拼成一张对照图 → 人来挑。
 *
 * 为什么需要这一步：Pexels 的排序是"关键词相关度"，不是"画面像不像那句话"。
 * 实测「laptop night」会给到"手在写字"，「data center」会给到"办公室接线员" ——
 * 只靠关键词 + 亮度过滤，素材跟文案对不上是必然的。
 * 所以先把候选摊开看，挑中的编号写进 picks.json，再用它渲染。
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { findFFmpeg } from '../src/engine/tools.js';
import { searchVideos, downloadMaterial, resolvePexelsKey } from '../src/engine/material.js';

const FFMPEG = findFFmpeg();
const OUT = path.join(process.cwd(), 'output', 'exp-2026-10-20');
const CAND = path.join(OUT, 'candidates');
const SHEET = path.join(OUT, 'sheets');

try {
  const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'xnowpost', 'config', 'user.json'), 'utf-8'));
  if (!process.env.PEXELS_API_KEY && cfg.pexelsApiKey) process.env.PEXELS_API_KEY = String(cfg.pexelsApiKey);
} catch (_) {}

// 每条镜头给 2~3 组"具体名词"查询（比整句更容易命中正确画面）
const SCENES = [
  { id: 's1', zh: '昨晚剪完，上传卡了 3 次', queries: ['video editing laptop', 'editing timeline screen'] },
  { id: 's2', zh: '不是内容差，是节点在掉', queries: ['network switch', 'internet router'] },
  { id: 's3', zh: '10 条专线，哪条都不掉', queries: ['server room', 'data center'] },
  { id: 's4', zh: '一条片子，省回 2 小时', queries: ['clock desk', 'checklist notebook'] },
  { id: 's5', zh: '评论区扣「专线」，给你试', queries: ['typing phone', 'smartphone hands'] },
];

const PER_QUERY = 3;

function run(exe, args, opts = {}) {
  return spawnSync(exe, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
function meanLuma(file) {
  const r = run(FFMPEG, ['-v', 'error', '-t', '3.2', '-i', file, '-vf', 'fps=2,scale=32:32', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  const buf = r.stdout;
  if (!buf || !buf.length) return -1;
  let s = 0;
  for (const b of buf) s += b;
  return s / buf.length;
}
function frame(file, out) {
  run(FFMPEG, ['-y', '-v', 'error', '-ss', '1.2', '-i', file, '-frames:v', '1', '-vf', 'scale=270:480', out]);
  return fs.existsSync(out);
}

async function main() {
  fs.mkdirSync(CAND, { recursive: true });
  fs.mkdirSync(SHEET, { recursive: true });
  if (!resolvePexelsKey()) throw new Error('Pexels Key 缺失');

  const manifest = [];
  for (const sc of SCENES) {
    const got = [];
    const seen = new Set();
    for (const q of sc.queries) {
      let hits = await searchVideos(q, { perPage: 8, orientation: 'portrait' });
      if (!hits.length) {
        const short = q.split(' ')[0];
        hits = await searchVideos(short, { perPage: 8, orientation: 'portrait' });
      }
      for (const h of hits) {
        if (got.length >= PER_QUERY * sc.queries.length) break;
        if (seen.has(h.url) || (h.duration || 0) < 3) continue;
        seen.add(h.url);
        const f = path.join(CAND, `${sc.id}-${got.length + 1}.mp4`);
        if (!fs.existsSync(f)) {
          try {
            await downloadMaterial(h.url, f);
          } catch (_) {
            continue;
          }
        }
        const lum = meanLuma(f);
        const png = path.join(CAND, `${sc.id}-${got.length + 1}.png`);
        if (!frame(f, png)) continue;
        got.push({ n: got.length + 1, q, file: f, png, lum: Number(lum.toFixed(0)), dur: h.duration, size: `${h.width}x${h.height}` });
        if (got.length % PER_QUERY === 0) break;
      }
    }
    console.log(`  ${sc.id} 「${sc.zh}」→ ${got.length} 条候选`);
    manifest.push({ ...sc, cands: got });
  }

  // 每个镜头拼一张 1xN 的对照图（带编号），方便逐张看
  for (const sc of manifest) {
    const inputs = sc.cands.flatMap((c) => ['-i', c.png]);
    const n = sc.cands.length;
    if (!n) continue;
    const filt = sc.cands.map((_, i) => `[${i}:v]`).join('') + `hstack=inputs=${n}`;
    const sheet = path.join(SHEET, `${sc.id}.png`);
    run(FFMPEG, ['-y', '-v', 'error', ...inputs, '-filter_complex', filt, sheet]);
    console.log(`  🖼️  ${path.basename(sheet)}（${n} 条：从左到右 1…${n}）`);
  }

  fs.writeFileSync(
    path.join(OUT, 'candidates.json'),
    JSON.stringify(manifest.map((s) => ({ id: s.id, zh: s.zh, cands: s.cands.map((c) => ({ n: c.n, q: c.q, lum: c.lum, dur: c.dur, size: c.size, file: c.file })) })), null, 2),
    'utf-8',
  );
  console.log('\n对照图在 output\\exp-2026-10-20\\sheets\\，挑完把编号写进 picks.json');
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
});
