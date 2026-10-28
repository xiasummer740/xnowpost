// 对照实验：同一个「下一页」点击，窗口可见时 vs 最小化时，各点一次，看视频换不换。
// 先可见时点（应该换），再最小化后点（看还换不换）—— 这样能排除"按钮本身点不动"的干扰。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { foxLaunch, foxRunning, foxStop } from '../src/collector/foxprofile.js';
import { attachFoxPage } from '../src/collector/foxpw.js';

const BASE = 'http://127.0.0.1:8000/api/v1';
const env = process.argv[2] || 'TK01';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const READ = () => {
  const v = document.querySelector('video');
  const btn = (() => {
    const el = document.querySelector('[data-e2e="feed-navigation-next"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  })();
  const card = (() => {
    for (const el of document.querySelectorAll('[data-e2e="feed-video"]')) {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx > 0 && cx < innerWidth && cy > 40 && cy < innerHeight - 40 && r.width > 150) return { cx: Math.round(cx), cy: Math.round(cy) };
    }
    return null;
  })();
  return {
    t: v ? Math.round(v.currentTime * 100) / 100 : null,
    paused: v ? v.paused : null,
    srcTail: v && v.currentSrc ? v.currentSrc.slice(-20) : '',
    btn,
    card,
  };
};

async function snap(page) {
  return page.evaluate(READ);
}
const changed = (a, b) => !!a && !!b && (a.srcTail !== b.srcTail || (a.t !== null && b.t !== null && b.t + 1 < a.t));

async function main() {
  const running = await foxRunning(BASE).catch(() => []);
  if ((Array.isArray(running) ? running : running?.running || []).length) { console.log('已有环境在跑，退出'); return; }
  await foxLaunch(env, BASE, { focus: false });
  const { page } = await attachFoxPage(env, BASE);
  await page.goto('https://www.tiktok.com/foryou?lang=en', { waitUntil: 'load', timeout: 60000 });
  await sleep(7000);

  let s = await snap(page);
  if (s.paused !== false && s.card) {
    await page.mouse.move(s.card.cx, s.card.cy); await sleep(200);
    await page.mouse.click(s.card.cx, s.card.cy); await sleep(4000);
  }
  s = await snap(page);
  console.log('开始(可见):', JSON.stringify(s));

  // ① 可见状态下点下一页
  if (!s.btn) { console.log('没有下一页按钮'); }
  else {
    await page.mouse.move(s.btn.cx, s.btn.cy); await sleep(250);
    await page.mouse.click(s.btn.cx, s.btn.cy); await sleep(2800);
    const a = await snap(page);
    console.log('可见时点下一页:', JSON.stringify(a), changed(s, a) ? '→ ✅ 换片了' : '→ ❌ 没换');

    // ② 最小化后再点一次
    const ps = path.join(process.cwd(), 'scripts', 'minimize-env.ps1');
    console.log('  最小化:', execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-Env', env], { encoding: 'utf8', windowsHide: true }).trim());
    await sleep(1500);
    const b = await snap(page);
    console.log('最小化后:', JSON.stringify(b));
    if (!b.btn) { console.log('最小化后找不到按钮'); }
    else {
      await page.mouse.move(b.btn.cx, b.btn.cy); await sleep(250);
      await page.mouse.click(b.btn.cx, b.btn.cy); await sleep(2800);
      const c = await snap(page);
      console.log('最小化时点下一页:', JSON.stringify(c), changed(b, c) ? '→ ✅ 换片了（点击有效）' : '→ ❌ 没换（点击被废）');
    }
  }

  await foxStop(env, BASE).catch(() => {});
  console.log(`${env} 已关闭`);
}

main().catch(async (e) => {
  console.error('失败:', e.message);
  await foxStop(env, BASE).catch(() => {});
});
