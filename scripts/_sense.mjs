/**
 * 验证「眼睛 + 手」：开一个环境，打开上传页，跑 N 秒，打印页面事件流 + 状态快照。
 *
 *   node scripts/_sense.mjs TK10 --seconds 40
 *   node scripts/_sense.mjs TK10 --seconds 40 --click "Turn on"   # 顺便用真实鼠标点一下并验证
 *
 * 只做观察（可选一次点击），不发作品。用来确认"页面每个细节变化都能看到"。
 */
import fs from 'fs-extra';
import path from 'path';
import { closeFoxProfile } from '../src/collector/foxprofile.js';
import { openFoxPage } from '../src/collector/foxpw.js';
import { startSensing, snapshot } from '../src/publisher/page-sense.js';
import { clickLabel } from '../src/publisher/page-act.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const env = args[0];
const getArg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const seconds = Number(getArg('--seconds', '40'));
const clickWhat = getArg('--click', '');

if (!env || !/^TK\d+$/.test(env)) {
  console.error('用法: node scripts/_sense.mjs TK10 [--seconds 40] [--click "Turn on"]');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logFile = path.join(process.cwd(), 'output', `sense-${env}-${stamp}.log`);
await fs.ensureDir(path.dirname(logFile));

console.log(`  👁️  观察 ${env} 共 ${seconds}s，事件流写入 ${logFile}`);

let envId = null;
try {
  const opened = await openFoxPage(env, undefined);
  const page = opened.page;
  envId = opened.name || env;

  await page.goto('https://www.tiktok.com/tiktokstudio/upload?from=upload', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(3000);

  const sense = await startSensing(page, {
    logFile,
    log: (m) => console.log(m),
  });

  const st0 = await snapshot(page);
  console.log(`  📊 初始状态: url=${st0.url}`);
  console.log(`     浮层=${st0.overlays.length} 个  Post=${st0.post.exists ? (st0.post.disabled ? '禁用' : '可点') : '无'}  AI=${st0.ai.aria}  文案=${st0.caption.length}字`);

  if (clickWhat) {
    const r = await clickLabel(page, [clickWhat], {
      verified: async () => {
        const s = await snapshot(page);
        return s.overlays.length === 0;
      },
      log: (m) => console.log(m),
    });
    console.log(`  ${r.clicked ? '✅' : '❌'} 点击结果: ${JSON.stringify(r)}`);
  }

  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await sleep(5000);
    const s = await snapshot(page);
    console.log(`  📊 ${new Date().toISOString().slice(11, 19)} 浮层=${s.overlays.length} Post=${s.post.exists ? (s.post.disabled ? '禁用' : '可点') : '无'} 上传=${s.upload.pct ?? '-'}% AI=${s.ai.aria} 文案=${s.caption.length}字 滚动=${s.viewport.scrollY}`);
    for (const ov of s.overlays) {
      console.log(`      ⚠️ 浮层「${ov.text.slice(0, 70)}」按钮=[${ov.buttons.map((b) => b.label).join('|')}]`);
    }
  }

  const total = await sense.stop();
  console.log(`  ✅ 观察结束，共 ${total} 条事件 → ${logFile}`);
} catch (err) {
  console.error(`  ❌ 出错: ${(err.message || '').split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  if (envId) {
    await closeFoxProfile(envId, undefined).catch(() => {});
    console.log(`  🧹 已关闭 ${envId}`);
  }
}


