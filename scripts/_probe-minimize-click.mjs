// 最小化后「点击」是否生效（正确版）：先让视频真的播起来，再最小化，再点下一页。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { foxLaunch, foxRunning, foxStop } from '../src/collector/foxprofile.js';
import { attachFoxPage } from '../src/collector/foxpw.js';

const BASE = 'http://127.0.0.1:8000/api/v1';
const env = process.argv[2] || 'TK01';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const READ = () => {
  const v = document.querySelector('video');
  const center = (() => {
    for (const el of document.querySelectorAll('[data-e2e="feed-video"]')) {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx > 0 && cx < innerWidth && cy > 40 && cy < innerHeight - 40 && r.width > 150) return { cx: Math.round(cx), cy: Math.round(cy) };
    }
    return null;
  })();
  const nextBtn = (() => {
    const el = document.querySelector('[data-e2e="feed-navigation-next"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  })();
  const src = v && v.currentSrc ? v.currentSrc : '';
  return {
    hidden: document.hidden,
    t: v ? Math.round(v.currentTime * 100) / 100 : null,
    paused: v ? v.paused : null,
    srcTail: src.slice(-24),
    dur: v ? Math.round(v.duration || 0) : null,
    center,
    nextBtn,
  };
};

async function main() {
  const running = await foxRunning(BASE).catch(() => []);
  if ((Array.isArray(running) ? running : running?.running || []).length) { console.log('已有环境在跑，退出'); return; }
  await foxLaunch(env, BASE, { focus: false });
  const { page } = await attachFoxPage(env, BASE);
  await page.goto('https://www.tiktok.com/foryou?lang=en', { waitUntil: 'load', timeout: 60000 });
  await sleep(7000);

  // ① 先在「没最小化」的情况下让它播起来
  const s1 = await page.evaluate(READ);
  if (s1.paused !== false && s1.center) {
    await page.mouse.move(s1.center.cx, s1.center.cy);
    await sleep(200);
    await page.mouse.click(s1.center.cx, s1.center.cy);
    await sleep(4000);
  }
  const playing = await page.evaluate(READ);
  console.log('让它播起来:', JSON.stringify(playing));
  if (playing.paused !== false) { console.log('⚠️ 没播起来，测试无效'); }

  // ② 最小化
  const ps = path.join(process.cwd(), 'scripts', 'minimize-env.ps1');
  console.log('  最小化:', execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-Env', env], { encoding: 'utf8', windowsHide: true }).trim());
  await sleep(1500);

  const s2 = await page.evaluate(READ);
  console.log('最小化后:', JSON.stringify(s2));

  // ③ 最小化状态下点「下一页」
  if (!s2.nextBtn) { console.log('没有下一页按钮'); } else {
    await page.mouse.move(s2.nextBtn.cx, s2.nextBtn.cy);
    await sleep(250);
    await page.mouse.click(s2.nextBtn.cx, s2.nextBtn.cy);
    await sleep(3000);
    const s3 = await page.evaluate(READ);
    const switched = s3.srcTail !== s2.srcTail || (s3.t !== null && s2.t !== null && s3.t + 0.5 < s2.t);
    console.log('点下一页后:', JSON.stringify(s3));
    console.log(`\n结论: ${switched ? '✅ 最小化后鼠标点击照样生效（可以放心自动最小化）' : '⚠️ 点不动（最小化会废掉点击，不能自动最小化）'}`);

    // 顺手测：最小化状态下的「点赞」能不能点（点完立刻取消）
    if (switched) {
      const likeBox = await page.evaluate(() => {
        for (const el of document.querySelectorAll('[data-e2e="like-icon"]')) {
          const r = el.getBoundingClientRect();
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          if (cx > 0 && cx < innerWidth - 20 && cy > 0 && cy < innerHeight) return { cx: Math.round(cx), cy: Math.round(cy) };
        }
        return null;
      });
      if (likeBox) {
        await page.mouse.move(likeBox.cx, likeBox.cy);
        await sleep(200);
        await page.mouse.click(likeBox.cx, likeBox.cy);
        await sleep(1800);
        const pressed = await page.evaluate(() => {
          const el = document.querySelector('[data-e2e="like-icon"]');
          return el ? el.getAttribute('aria-pressed') : null;
        });
        console.log(`  最小化下点赞 → aria-pressed=${pressed} ${pressed === 'true' ? '✅ 点得动' : '❌ 点不动'}`);
        if (pressed === 'true') { // 撤销，别留痕迹
          await page.mouse.click(likeBox.cx, likeBox.cy);
          await sleep(1200);
        }
      }
    }
  }

  await foxStop(env, BASE).catch(() => {});
  console.log(`${env} 已关闭`);
}

main().catch(async (e) => {
  console.error('失败:', e.message);
  await foxStop(env, BASE).catch(() => {});
});
