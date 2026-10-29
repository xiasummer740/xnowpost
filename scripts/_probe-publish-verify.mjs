/**
 * 只读探针：验证「按标题定位到本条作品」在真实内容页上到底能不能命中。
 *
 * 只开一个环境 → 打开 TikTok 内容管理页 → 用 collectBlocksFn 采候选块 →
 * pickOwnBlock 挑出属于这条标题的那一块 → 打印可见性。
 * 不点任何按钮、不发任何请求改状态，结束后关窗口。
 *
 * 用法：node scripts/_probe-publish-verify.mjs TK10 "3个技巧让你的视频不再卡在200播放"
 */
import 'dotenv/config';
import { dataPath } from '../src/paths.js';
import { launchAndWait, closeFoxProfile } from '../src/collector/foxprofile.js';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';
import { titleKey, pickOwnBlock, collectBlocksFn } from '../src/publisher/publish-verify.js';

const env = process.argv[2] || 'TK01';
const title = process.argv[3] || '';
const key = titleKey(title);
console.log(`探针：env=${env}  title=${JSON.stringify(title)}  key=${JSON.stringify(key)}`);
if (!key) { console.log('❌ 这个标题抽不出可定位的片段，改用别的标题再试'); process.exit(1); }

const RUN = {
  async main() {
    await launchAndWait(env, '', { focus: false });
    const { page } = await openFoxPage(env, '');
    await page.goto('https://www.tiktok.com/tiktokstudio/content', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(6000);
    console.log('  页面 URL:', page.url());

    const blocks = await page.evaluate(collectBlocksFn, key).catch((e) => { console.log('  evaluate 失败:', e.message); return []; });
    console.log(`  候选块 ${blocks.length} 个（含 key=${key}）：`);
    blocks.slice(0, 5).forEach((b, i) => {
      console.log(`   [${i}] ${JSON.stringify(String(b).replace(/\s+/g, ' ').slice(0, 160))}`);
    });

    const pick = pickOwnBlock(blocks, key);
    console.log(`  判定：found=${pick.found} index=${pick.index} state=${pick.state}`);
    console.log(pick.state === 'public' ? '  ✅ 本条已公开（判据可用）' : `  ⚠️ 状态=${pick.state}`);
    await closeFoxPage(env).catch(() => {});
    await closeFoxProfile(env, '').catch(() => {});
  },
};
RUN.main().catch((e) => { console.error('探针失败:', e.message); process.exit(1); });
