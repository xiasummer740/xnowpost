/**
 * 探针：验证 page-sense 的 INIT / DRAIN / SNAPSHOT 在 FoxProfile 的 evaluate 下能不能持久化。
 *   node scripts/_probe-sense.mjs TK10
 */
import { openFoxPage } from '../src/collector/foxpw.js';
import { closeFoxProfile } from '../src/collector/foxprofile.js';
import { SENSE_INIT, SENSE_DRAIN, SENSE_SNAPSHOT } from '../src/publisher/page-sense.js';

const env = process.argv[2] || 'TK10';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let envId = null;
try {
  const opened = await openFoxPage(env, undefined);
  const page = opened.page;
  envId = opened.name;

  // 1) evaluate 到底返回什么
  const r1 = await page.evaluate(() => ({ ping: 1, hasSense: !!window.__sense, url: location.href }));
  console.log('  ① 基本 evaluate:', JSON.stringify(r1));

  // 2) 带参数
  const r2 = await page.evaluate((n) => ({ got: n, hasSense: !!window.__sense }), 42);
  console.log('  ② 带参数 evaluate:', JSON.stringify(r2));

  // 3) 装观察器
  const init = await page.evaluate(SENSE_INIT);
  console.log('  ③ INIT 返回:', JSON.stringify(init));

  // 4) 立刻检查
  const r4 = await page.evaluate(() => ({ hasSense: !!window.__sense, len: window.__sense ? window.__sense.log.length : -1 }));
  console.log('  ④ INIT 之后:', JSON.stringify(r4));

  // 5) 制造一个 DOM 变化（浮层）再 drain
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.className = 'TUXModal test-overlay';
    d.style.cssText = 'position:fixed;left:20px;top:20px;width:400px;height:200px;background:#fff;z-index:99999';
    d.innerHTML = '<div>Turn on automatic content checks?</div><div><button>Cancel</button><button>Turn on</button></div>';
    document.body.appendChild(d);
    window.__testOverlay = d;
  });
  await sleep(600);
  const drained = await page.evaluate(SENSE_DRAIN);
  console.log('  ⑤ DRAIN 返回:', JSON.stringify(drained));

  // 6) snapshot
  const snap = await page.evaluate(SENSE_SNAPSHOT);
  console.log('  ⑥ SNAPSHOT:', JSON.stringify({ url: snap.url, overlays: snap.overlays.map((o) => ({ text: o.text.slice(0, 40), buttons: o.buttons.map((b) => b.label) })), post: snap.post.exists }));

  // 7) 再 drain 一次，确认增量清了
  const drained2 = await page.evaluate(SENSE_DRAIN);
  console.log('  ⑦ 第二次 DRAIN（应为 0）:', JSON.stringify(drained2.events.length));

  // 8) 清理测试浮层
  await page.evaluate(() => { window.__testOverlay?.remove(); });
} catch (err) {
  console.error('  ❌', (err.message || '').split('\n').slice(0, 3).join(' | '));
  process.exitCode = 1;
} finally {
  if (envId) await closeFoxProfile(envId, undefined).catch(() => {});
  console.log(`  🧹 已关闭 ${envId}`);
}
