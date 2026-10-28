// 只读探查：For You 页面上「收藏 / 关注」按钮到底叫什么、在不在视口里。
// 不点任何按钮，看完立刻关环境。
import { foxLaunch, foxRunning, foxStop } from '../src/collector/foxprofile.js';
import { attachFoxPage } from '../src/collector/foxpw.js';

const BASE = 'http://127.0.0.1:8000/api/v1';
const env = process.argv[2] || 'TK01';

const PROBE = () => {
  const q = (sel) => {
    const els = [...document.querySelectorAll(sel)];
    return els.slice(0, 3).map((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const inView = cx > 0 && cx < innerWidth - 20 && cy > 0 && cy < innerHeight && r.width > 8;
      return {
        tag: el.tagName,
        label: String(el.getAttribute('aria-label') || '').split('\n')[0].slice(0, 24),
        pressed: el.getAttribute('aria-pressed'),
        box: [Math.round(cx), Math.round(cy), Math.round(r.width), Math.round(r.height)],
        inView,
      };
    });
  };
  return {
    url: location.href,
    like: q('[data-e2e="like-icon"]'),
    favorite: q('[data-e2e="favorite-icon"]'),
    feedFollow: q('[data-e2e="feed-follow"]'),
    candFav: q('[data-e2e*="favorite"]'),
    candCollect: q('[data-e2e*="collect"]'),
    candFollow: q('[data-e2e*="follow"]'),
    // 右侧竖排按钮的 aria-label（这是最稳的线索）
    sidebarLabels: [...document.querySelectorAll('button[aria-label]')]
      .map((b) => ({ label: String(b.getAttribute('aria-label')).split('\n')[0].slice(0, 28), e2e: b.getAttribute('data-e2e') || '' }))
      .slice(0, 14),
  };
};

async function main() {
  const running = await foxRunning(BASE).catch(() => []);
  const list = Array.isArray(running) ? running : running?.running || [];
  if (list.length) {
    console.log('已有环境在跑，先不动它:', list.join(','));
    return;
  }
  console.log(`打开 ${env}（focus=false）…`);
  await foxLaunch(env, BASE, { focus: false });
  const { page } = await attachFoxPage(env, BASE);
  await page.goto('https://www.tiktok.com/foryou?lang=en', { waitUntil: 'load', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 6000));
  const d = await page.evaluate(PROBE);
  console.log(JSON.stringify(d, null, 2));
  await foxStop(env, BASE).catch(() => {});
  console.log(`${env} 已关闭`);
}

main().catch(async (e) => {
  console.error('探查失败:', e.message);
  await foxStop(env, BASE).catch(() => {});
});
