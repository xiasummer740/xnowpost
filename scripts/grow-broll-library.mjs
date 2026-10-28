/**
 * 素材库自动生长 CLI。
 *
 *   node scripts/grow-broll-library.mjs                 # 每类补到 3 段，本次最多补 6 段
 *   node scripts/grow-broll-library.mjs --max 20        # 一次补 20 段（首次建库用）
 *   node scripts/grow-broll-library.mjs --per-tag 4     # 每类目标 4 段
 *   node scripts/grow-broll-library.mjs --dry-run       # 只下载+检测，不入库（看闸门表现）
 *
 * 需要 PEXELS_API_KEY（安装版会从 user.json 读；命令行跑时这里自动注入）。
 */
import fs from 'fs-extra';
import path from 'path';
import { growLibrary, adoptOrphans, libraryPath, GATES } from '../src/broll-auto.js';

const args = process.argv.slice(2);
const has = (k) => args.includes(`--${k}`);
const val = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i > -1 && args[i + 1] ? Number(args[i + 1]) : d;
};

// 命令行运行时把 user.json 里的 Key 注入环境（引擎在安装版里由主进程注入）
const userCfg = path.join(process.env.APPDATA || '', 'xnowpost', 'config', 'user.json');
if (!process.env.PEXELS_API_KEY && fs.existsSync(userCfg)) {
  try {
    const j = fs.readJsonSync(userCfg);
    if (j.pexelsApiKey) process.env.PEXELS_API_KEY = j.pexelsApiKey;
  } catch (_) { /* 忽略 */ }
}
if (!process.env.PEXELS_API_KEY) {
  console.error('❌ 没有 Pexels Key（配置 → 素材 API Key，或设环境变量 PEXELS_API_KEY）');
  process.exit(1);
}

const perTag = val('per-tag', 3);
const maxPerRun = val('max', 6);
const dryRun = has('dry-run');
const { dir } = libraryPath();

console.log(`📚 素材库：${dir}`);
console.log(`   本次目标：每类 ${perTag} 段，最多补 ${maxPerRun} 段${dryRun ? '（演练：不入库）' : ''}`);
console.log(`   闸门：时长≥${GATES.minDurationSec}s / 亮度 ${GATES.lumaMin}~${GATES.lumaMax} / 清晰度≥${GATES.minSharpness} / 去重距离<${GATES.dedupeDistance} 视为重复\n`);

const t0 = Date.now();
// 先把上次中断留下的孤儿文件收养/清理掉（照样过全部闸门）
const orph = await adoptOrphans();
if (orph.adopted.length || orph.dropped) {
  console.log(`♻️ 孤儿文件：收养 ${orph.adopted.length} 段，删除 ${orph.dropped} 段\n`);
}

const res = await growLibrary({ perTag, maxPerRun, dryRun });
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log('');
console.log(`✅ 入库 ${res.added.length} 段（候选 ${res.stats.candidates} 个，淘汰 ${res.skipped} 个），耗时 ${secs}s`);
if (Object.keys(res.stats.rejected).length) {
  console.log(`   淘汰原因：${Object.entries(res.stats.rejected).map(([k, n]) => `${k}×${n}`).join('，')}`);
}
console.log(`   库内合计 ${res.total} 段${dryRun ? '（演练未写入）' : ''}`);
