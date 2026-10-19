/**
 * 给一轮发布计时（只读）：闹钟开始 → 生成 → 上传 → 发布 → 关浏览器
 *   node scripts/_timeline.mjs TK07 --minutes 20
 *
 * 起点取调度器日志里最后一次「任务开始」的**行首时间戳**（调度器自己的日志是实时写的，
 * 只有子进程 stdout 会攒到退出才回放，所以不要用子进程日志算时间）。
 * 终点取 /browser 里该环境消失的时刻（= 浏览器真的关掉了）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const env = process.argv[2] || 'TK06';
const miArg = process.argv.indexOf('--minutes');
const minutes = miArg > 0 ? Number(process.argv[miArg + 1]) : 20;

const dataDir = path.join(os.homedir(), 'AppData', 'Roaming', 'xnowpost');
const today = new Date();
const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const logFile = path.join(dataDir, 'logs', `scheduler-${dateStr}.log`);
const outDir = path.join(dataDir, 'output', dateStr);

const marks = [];
const mark = (k, t) => {
  if (marks.some((m) => m.k === k)) return;
  marks.push({ k, t });
  const hh = t.toTimeString().slice(0, 8);
  console.log(`  ${hh}  ▸ ${k}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return await r.json();
  } catch { return null; }
};

let alarmStart = null;
let seenDir = null;
let envSeen = false;
const scriptStart = Date.now();
const deadline = Date.now() + minutes * 60000;

console.log(`  计时 ${env}（最多 ${minutes} 分钟）…`);
while (Date.now() < deadline) {
  // 1) 闹钟真正开始的时间：只认**脚本启动之后**的那条，否则会拿到上一轮的开始时间
  if (!alarmStart) {
    try {
      const txt = fs.readFileSync(logFile, 'utf8');
      const hits = [...txt.matchAll(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\][^\n]*任务开始/gm)];
      // 优先取脚本启动之后的；没有（脚本比闹钟起晚了）就退回最近 25 分钟内最后一条
      let picked = null;
      for (const h of hits.reverse()) {
        const t = new Date(h[1].replace(' ', 'T'));
        if (t.getTime() >= scriptStart - 3000) { picked = t; break; }
      }
      if (!picked && hits.length) {
        const t = new Date(hits[hits.length - 1][1].replace(' ', 'T'));
        if (Date.now() - t.getTime() < 25 * 60000) picked = t;
      }
      alarmStart = picked;
      if (alarmStart) mark('alarm_start', alarmStart);
    } catch { /* 日志还没建 */ }
  }

  const ref = alarmStart ? alarmStart.getTime() : scriptStart;
  // 2) 本轮会话目录（只看闹钟开始之后建/改过的，别把上一轮的产物算进来）
  try {
    const dirs = fs.readdirSync(outDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^(am|pm)_\d{4}$/.test(d.name))
      .map((d) => ({ name: d.name, p: path.join(outDir, d.name), mt: fs.statSync(path.join(outDir, d.name)).mtimeMs }))
      .filter((d) => d.mt >= ref - 2000)
      .sort((a, b) => a.mt - b.mt);
    if (dirs.length) {
      const use = dirs[dirs.length - 1];
      if (!seenDir || seenDir.p !== use.p) {
        seenDir = { name: use.name, p: use.p };
        console.log(`        （本轮会话: ${use.name}）`);
      }
    }
    if (seenDir) {
      for (const [k, f] of [['caption', '文案.txt'], ['cover', '封面.png'], ['video', 'video.mp4'], ['published', '.published'], ['FAILED', 'FAILED']]) {
        const fp = path.join(seenDir.p, f);
        try {
          const st = fs.statSync(fp);
          if (st.mtime.getTime() < ref - 3000) continue;
          mark(k, st.mtime);
        } catch { /* 还没有 */ }
      }
    }
  } catch { /* output 目录还没建 */ }

  // 3) 浏览器开关（2 秒内的状态变化就算）
  const b = await readJson('http://127.0.0.1:8000/api/v1/browser');
  const running = Array.isArray(b?.running) ? b.running : [];
  if (running.includes(env) && !envSeen) { envSeen = true; mark('env_open', new Date()); }
  if (envSeen && !running.includes(env)) { mark('env_closed', new Date()); break; }

  await sleep(1000);
}

// ---- 汇总 ----
const get = (k) => marks.find((m) => m.k === k)?.t || null;
const t0 = get('alarm_start');
console.log('\n  ==== 时间线 ====');
let last = null;
for (const m of marks.sort((a, b) => a.t - b.t)) {
  const rel = t0 ? `+${Math.round((m.t - t0) / 1000)}s` : '';
  const step = last ? ` (本步 +${Math.round((m.t - last) / 1000)}s)` : '';
  console.log(`  ${m.t.toTimeString().slice(0, 8)}  ${m.k.padEnd(14)} ${rel}${step}`);
  last = m.t;
}
if (t0) {
  const tPub = get('published');
  const tClose = get('env_closed');
  if (tPub) console.log(`\n  ⏱️ 闹钟 → 发布完成: ${Math.round((tPub - t0) / 1000)} 秒`);
  if (tPub && tClose) console.log(`  ⏱️ 发布完成 → 浏览器关闭: ${Math.round((tClose - tPub) / 1000)} 秒`);
  if (tClose) console.log(`  ⏱️ 总时长（闹钟 → 发布完成并关浏览器）: ${Math.round((tClose - t0) / 1000)} 秒`);
  else console.log('\n  ⚠️ 计时结束但没看到浏览器关闭');
}

