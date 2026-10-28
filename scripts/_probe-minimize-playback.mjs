// 测一件事：窗口**最小化**之后，TikTok 的视频还播不播？
// 这决定「自动最小化」能不能用在养号上（如果最小化就暂停，养号会变成 0 秒）。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { foxLaunch, foxRunning, foxStop } from '../src/collector/foxprofile.js';
import { attachFoxPage } from '../src/collector/foxpw.js';

const BASE = 'http://127.0.0.1:8000/api/v1';
const env = process.argv[2] || 'TK01';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const READ = () => {
  const v = document.querySelector('video');
  const box = (sel) => {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx > 0 && cx < innerWidth - 20 && cy > 0 && cy < innerHeight && r.width > 8) return { cx: Math.round(cx), cy: Math.round(cy) };
    }
    return null;
  };
  return {
    hidden: document.hidden,
    visibility: document.visibilityState,
    hasVideo: !!v,
    t: v ? Math.round(v.currentTime * 100) / 100 : null,
    paused: v ? v.paused : null,
    card: box('[data-e2e="feed-video"]'),
  };
};

async function main() {
  const running = await foxRunning(BASE).catch(() => []);
  const list = Array.isArray(running) ? running : running?.running || [];
  if (list.length) {
    console.log('已有环境在跑:', list.join(','), '→ 不动它，退出');
    return;
  }
  await foxLaunch(env, BASE, { focus: false });
  const { page } = await attachFoxPage(env, BASE);
  await page.goto('https://www.tiktok.com/foryou?lang=en', { waitUntil: 'load', timeout: 60000 });
  await sleep(7000);

  let st = await page.evaluate(READ);
  if (!st.hasVideo && st.card) {
    await page.mouse.click(st.card.cx, st.card.cy);
    await sleep(4000);
    st = await page.evaluate(READ);
  }
  console.log('最小化前:', JSON.stringify(st));

  const ps = path.join(process.cwd(), 'scripts', 'minimize-env.ps1');
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-Env', env], { encoding: 'utf8', windowsHide: true });
  console.log('  最小化:', out.trim());
  await sleep(1500);

  const samples = [];
  for (let i = 0; i < 4; i++) {
    samples.push(await page.evaluate(READ));
    await sleep(2000);
  }
  console.log('\n最小化后连采 4 次（每 2 秒）:');
  for (const s of samples) console.log(`  hidden=${s.hidden} vis=${s.visibility} t=${s.t} paused=${s.paused}`);
  const ts = samples.map((s) => s.t).filter((x) => typeof x === 'number');
  const advanced = ts.length >= 2 && ts[ts.length - 1] > ts[0];
  console.log(`\n结论: ${advanced ? '✅ 最小化后照样播（可以安全自动最小化）' : '❌ 最小化后不播了（养号不能最小化！）'}`);

  await foxStop(env, BASE).catch(() => {});
  console.log(`${env} 已关闭`);
}

main().catch(async (e) => {
  console.error('失败:', e.message);
  await foxStop(env, BASE).catch(() => {});
});
