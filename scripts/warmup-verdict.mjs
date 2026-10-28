// 养号「看着跑完」之后的判决书：把落盘证据整理成人话，不猜。
// 用法： node scripts/warmup-verdict.mjs [YYYY-MM-DD] [日期-HHMM]
import fs from 'node:fs';
import path from 'node:path';

const DATA = process.env.XNOWPOST_DATA_DIR || path.join(process.env.APPDATA, 'xnowpost');
const today = process.argv[2] || new Date().toLocaleDateString('sv-SE');
const wantTag = process.argv[3] || '';

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// ① 证据文件（data/warmup/<日期>-<HHMM>.json）
const warmDir = path.join(DATA, 'data', 'warmup');
const files = fs.existsSync(warmDir)
  ? fs.readdirSync(warmDir).filter((f) => f.startsWith(today) && f.endsWith('.json')).sort()
  : [];
const ev = files
  .filter((f) => !wantTag || f.includes(wantTag))
  .map((f) => ({ file: f, data: readJson(path.join(warmDir, f)) }))
  .filter((x) => x.data)
  .pop();

console.log(`\n═══ 养号判决书 ${today} ═══`);
if (!ev) {
  console.log('❌ 没有找到证据文件（data/warmup/）');
  process.exit(0);
}

const d = ev.data;
const sessions = d.sessions || [];
const okCount = sessions.filter((s) => !s.problems || s.problems.length === 0).length;
const totalVideos = sessions.reduce((a, s) => a + (s.videos || 0), 0);
const totalSec = sessions.reduce((a, s) => a + (s.watchedSec || 0), 0);
const totalActs = sessions.reduce((a, s) => a + (s.actions || []).length, 0);

console.log(`证据文件   : ${ev.file}`);
console.log(`开始时间   : ${d.at || '?'}${d.minutesRange ? `（每号随机 ${d.minutesRange[0]}~${d.minutesRange[1]} 分钟）` : ''}`);
console.log(`账号结果   : ${okCount}/${sessions.length} 个号正常`);
console.log(`合计       : 看 ${totalVideos} 条 / ${totalSec} 秒 · 动作 ${d.totalActions ?? totalActs} 次`);
console.log(`每条不重样 : ${sessions.every((s) => (s.distinctVideos ?? s.videos) >= s.videos) ? '✅ 全部是不同视频（翻页真的生效）' : '❌ 有条目重复（可能没翻动）'}`);
console.log('\n每号明细（时长 / 条数 / 观看秒数 / 动作 / 问题）');
for (const s of sessions) {
  const c = s.counts || {};
  const acts = (c.like || 0) + (c.favorite || 0) + (c.follow || 0) + (c.comment || 0);
  const probs = (s.problems || []).join('; ');
  const bad = (s.problems || []).length > 0;
  const c2 = s.counts || {};
  console.log(
    `  ${bad ? '❌' : '✅'} ${s.env}  ${String(s.minutes).padStart(2)} 分 · ${String(s.videos).padStart(2)} 条（不重样 ${s.distinctVideos ?? '?'}）· ${String(
      s.watchedSec,
    ).padStart(4)} 秒 · 赞${c2.like || 0} 藏${c2.favorite || 0} 关注${c2.follow || 0}${probs ? `  ← ${probs}` : ''}`,
  );
}

// ② 轮次记录（data/runs/<日期>-<HHMM>-<id>.json）
const runsDir = path.join(DATA, 'data', 'runs');
const recs = fs.existsSync(runsDir)
  ? fs.readdirSync(runsDir).filter((f) => f.startsWith(today) && f.endsWith('.json')).sort()
  : [];
const rec = recs
  .map((f) => readJson(path.join(runsDir, f)))
  .filter((r) => r && r.mode === 'warmup')
  .pop();
if (rec) {
  console.log('\n轮次记录');
  console.log(`  #${rec.jobId} ${rec.mode} ${rec.time || ''} → result=${rec.result}  耗时 ${Math.round((rec.durationMs || 0) / 1000)} 秒`);
  if (rec.reason) console.log(`  原因: ${rec.reason}`);
}

// ③ 眼睛记录（watch.log 的环境时间线 + probe.log 的播放判定）
const outDir = path.join(process.cwd(), 'output', 'warmup-watch');
const watch = path.join(outDir, 'watch.log');
if (fs.existsSync(watch)) {
  const rows = fs
    .readFileSync(watch, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(/^\[(\d\d:\d\d:\d\d)\] envs=\[([^\]]*)\]/))
    .filter(Boolean)
    .map((m) => ({ t: m[1], envs: m[2] ? m[2].split(',') : [] }));
  const byEnv = new Map();
  for (const r of rows) {
    for (const e of r.envs) {
      if (!byEnv.has(e)) byEnv.set(e, { first: r.t, last: r.t, n: 0 });
      const o = byEnv.get(e);
      o.last = r.t;
      o.n++;
    }
  }
  const maxConcurrent = rows.reduce((a, r) => Math.max(a, r.envs.length), 0);
  console.log('\n眼睛看到的（watch.log 采样）');
  console.log(`  同时最多开了 ${maxConcurrent} 个环境 ${maxConcurrent <= 1 ? '✅（符合「一次只跑一个」）' : '❌ 有并发！'}`);
  for (const [e, o] of [...byEnv.entries()].sort()) console.log(`  ${e}: ${o.first} → ${o.last}（${o.n} 次采样）`);
  const seen = byEnv.size;
  console.log(`  实际看到 ${seen} 个环境在跑${seen === sessions.length ? ' ✅' : ` ⚠️（证据里有 ${sessions.length} 个）`}`);
}

const pl = path.join(outDir, 'probe.log');
if (fs.existsSync(pl)) {
  const lines = fs.readFileSync(pl, 'utf8').split(/\r?\n/).filter((l) => /在播|没动/.test(l));
  const good = lines.filter((l) => l.includes('在播')).length;
  const bad = lines.length - good;
  console.log('\n播放探测（probe.log 页面级证据）');
  console.log(`  ${good + bad} 次采样：在播 ${good} 次 / 没动 ${bad} 次`);
  for (const l of lines.filter((x) => x.includes('没动'))) console.log(`  ⚠️ ${l.slice(0, 130)}`);
}
