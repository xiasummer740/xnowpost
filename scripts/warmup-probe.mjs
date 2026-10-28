// 用眼睛看养号：连续采样，判断「视频真的在走」。
// 只接管已开的环境（attachFoxPage），绝不启动/关闭别人的浏览器。
// 用法： node scripts/warmup-probe.mjs [TK01] [--samples 5] [--step 1.2]
import { attachFoxPage } from '../src/collector/foxpw.js';
import { foxRunning } from '../src/collector/foxprofile.js';

const BASE = 'http://127.0.0.1:8000/api/v1';

const READ = () => {
  const vs = [...document.querySelectorAll('video')];
  const v = vs.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  const like = document.querySelector('[data-e2e="like-count"]');
  const user = document.querySelector('[data-e2e="browse-username"]');
  const card = document.querySelector('[data-e2e="recommend-list-item-container"]');
  return {
    url: location.href,
    t: v ? Math.round(v.currentTime * 100) / 100 : -1,
    dur: v ? Math.round((v.duration || 0) * 100) / 100 : 0,
    paused: v ? v.paused : null,
    muted: v ? v.muted : null,
    ready: v ? v.readyState : -1,
    w: v ? v.clientWidth : 0,
    h: v ? v.clientHeight : 0,
    like: like ? like.textContent.trim() : '',
    user: user ? user.textContent.trim() : '',
    cardKey: card ? card.id || '' : '',
    wantLogin: /log in/i.test((document.body.innerText || '').slice(0, 400)),
  };
};

async function main() {
  const args = process.argv.slice(2);
  const get = (k, d) => {
    const i = args.indexOf(k);
    return i >= 0 ? Number(args[i + 1]) || d : d;
  };
  const samples = get('--samples', 5);
  const step = get('--step', 1.2);
  let env = args.find((a) => /^TK\d+$/i.test(a));
  if (!env) {
    const r = await foxRunning(BASE).catch(() => null);
    const list = Array.isArray(r) ? r : r?.running || [];
    env = list[0];
  }
  if (!env) {
    console.log(`${new Date().toLocaleTimeString('zh-CN')}  没有正在运行的环境`);
    return;
  }

  const { page } = await attachFoxPage(env, BASE);
  const seen = [];
  for (let i = 0; i < samples; i++) {
    seen.push(await page.evaluate(READ));
    if (i < samples - 1) await new Promise((r) => setTimeout(r, step * 1000));
  }
  const ok = seen.filter((x) => x && x.t >= 0);
  let forward = 0;
  let switched = 0;
  for (let i = 1; i < ok.length; i++) {
    const d = ok[i].t - ok[i - 1].t;
    if (d > 0.3) forward++;
    else if (d < -0.5) switched++;   // 位置跳回开头 = 换下一条/循环播放，也算在走
  }
  const last = ok[ok.length - 1] || seen[seen.length - 1] || {};
  const playing = forward + switched > 0;
  console.log(
    `${new Date().toLocaleTimeString('zh-CN')} ${env} 位置: ${ok.map((x) => x.t).join(' → ')} | ${
      playing ? `✅ 在播（前进 ${forward} 次 / 换片 ${switched} 次）` : '❌ 没动'
    } | paused=${last.paused} muted=${last.muted} ready=${last.ready} ${last.w}×${last.h} 时长${last.dur}s | 作者=${last.user || '?'} 赞=${last.like || '?'} | 要登录=${last.wantLogin}`,
  );
  if (!playing) {
    // FoxPage 代理没有 .text()，只能 evaluate
    const txt = await page.evaluate(() => (document.body.innerText || '').slice(0, 160)).catch(() => '');
    console.log(`   ⚠️ 页面开头: ${String(txt).slice(0, 120).replace(/\s+/g, ' ')}`);
  }
}

main().catch((e) => {
  console.error(`${new Date().toLocaleTimeString('zh-CN')} probe 失败: ${e.message}`);
  process.exitCode = 1;
});
