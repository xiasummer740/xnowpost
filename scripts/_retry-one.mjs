/**
 * 重发某一个指定会话（队列默认只取最老的未发布项，够不到刚失败的那条）
 *
 *   node scripts/_retry-one.mjs 2026-10-18/pm_2103 TK05
 *
 * 和调度器走的是同一份实现（publishToTikTok），成功后会清掉 FAILED 标记。
 */
import path from 'path';
import fs from 'fs-extra';
import { publishToTikTok } from '../src/publisher/tiktok.js';
import { closeFoxProfile } from '../src/collector/foxprofile.js';
import { resolveDataDir } from '../src/paths.js';

const rel = process.argv[2];
const envId = process.argv[3] || 'TK05';
if (!rel) {
  console.error('用法: node scripts/_retry-one.mjs <日期>/<会话> [环境名]');
  process.exit(2);
}

const dataDir = resolveDataDir();
// 允许直接给绝对路径（命令行手动跑时 resolveDataDir 会落到仓库目录，不是数据目录）
const sessionPath = path.isAbsolute(rel) ? rel : path.join(dataDir, 'output', rel);
if (!fs.existsSync(sessionPath)) {
  console.error(`会话目录不存在: ${sessionPath}`);
  process.exit(2);
}

const videoFile = fs.existsSync(path.join(sessionPath, 'video.mp4')) ? path.join(sessionPath, 'video.mp4') : null;
const titleFile = fs.existsSync(path.join(sessionPath, '文案.txt')) ? path.join(sessionPath, '文案.txt') : null;
console.log(`  🔁 重发 ${rel}  环境=${envId}  视频=${videoFile ? '有' : '无'}  文案=${titleFile ? '有' : '无'}`);

let url = '';
try {
  url = await publishToTikTok({
    sessionPath,
    videoFile,
    imageFiles: [],
    titleFile,
    envId,
    budgetMs: 12 * 60 * 1000,
  });
  console.log(`\n  ✅ 发布成功: ${url || '(链接未知)'}`);
  const failed = path.join(sessionPath, 'FAILED');
  if (fs.existsSync(failed)) {
    fs.removeSync(failed);
    console.log('  🧹 已清掉上次的 FAILED 标记');
  }
} catch (err) {
  console.error(`\n  ❌ 重发失败: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (process.env.XNOWPOST_KEEP_BROWSER !== '1') {
    await closeFoxProfile(envId).catch(() => {});
  }
}
