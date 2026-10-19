/**
 * 打开一个环境，跳到指定页面，拍一张图，关掉。用来"用眼睛确认"页面状态。
 *
 *   node scripts/_eye-page.mjs TK02                                  # 内容管理页
 *   node scripts/_eye-page.mjs TK02 https://www.tiktok.com/tiktokstudio/upload
 */
import path from 'path';
import fs from 'fs-extra';
import { closeFoxProfile } from '../src/collector/foxprofile.js';
import { openFoxPage } from '../src/collector/foxpw.js';

const env = process.argv[2];
const url = process.argv[3] || 'https://www.tiktok.com/tiktokstudio/content';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!env) {
  console.error('用法: node scripts/_eye-page.mjs TK02 [url]');
  process.exit(1);
}

const outDir = path.join(process.cwd(), 'output', 'eyes');
await fs.ensureDir(outDir);
const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
const file = path.join(outDir, `page-${env}-${stamp}.png`);

let envId = null;
try {
  const opened = await openFoxPage(env, undefined);
  envId = opened.name;
  const page = opened.page;
  console.log(`  🌐 打开 ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(5000);
  const info = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
  }));
  console.log(`  📄 ${info.url}`);
  console.log(`  📝 ${info.text.slice(0, 260)}`);
  await page.screenshot({ path: file });
  console.log(`  📷 ${file}`);
} catch (err) {
  console.error(`  ❌ ${(err.message || '').split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  if (envId) await closeFoxProfile(envId, undefined).catch(() => {});
  console.log(`  🧹 已关闭 ${envId}`);
}
