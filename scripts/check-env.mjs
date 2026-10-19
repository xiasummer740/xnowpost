/**
 * 环境自检脚本 —— node scripts/check-env.mjs
 *
 * 检查引擎依赖的外部工具是否「找得到」且「跑得起来」，
 * 以及数据目录 / 配置文件位置是否正确。
 */
import fs from 'fs-extra';
import path from 'path';
import { verifyMediaTools } from '../src/engine/tools.js';

const DATA_DIR = process.env.XNOWPOST_DATA_DIR || process.cwd();

function line(ok, label, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
}

console.log('\n=== XNOWPost 环境自检 ===\n');
console.log(`数据目录: ${DATA_DIR}\n`);

console.log('--- 外部工具 ---');
const t = verifyMediaTools();
line(t.ffmpeg.ok, 'ffmpeg', t.ffmpeg.ok ? `${t.ffmpeg.version}` : t.ffmpeg.error);
if (t.ffmpeg.ok) console.log(`     path: ${t.ffmpeg.path}`);
line(t.ffprobe.ok, 'ffprobe', t.ffprobe.ok ? `${t.ffprobe.version}` : t.ffprobe.error);
if (t.ffprobe.ok) console.log(`     path: ${t.ffprobe.path}`);
line(t.edgeTts.ok, 'edge-tts', t.edgeTts.ok ? `${t.edgeTts.version}` : t.edgeTts.error);
if (t.edgeTts.ok) console.log(`     path: ${t.edgeTts.path}`);

console.log('\n--- Node ---');
const major = parseInt(process.versions.node.split('.')[0], 10);
line(major >= 18, `Node.js ${process.version}`, major >= 18 ? '满足 >=18' : '需要 >=18');

console.log('\n--- 配置文件 ---');
const userCfg = path.join(DATA_DIR, 'config', 'user.json');
const schedCfg = path.join(DATA_DIR, 'config', 'schedule.json');
line(fs.existsSync(userCfg), 'config/user.json');
if (fs.existsSync(userCfg)) {
  try {
    const cfg = fs.readJsonSync(userCfg);
    const keys = ['deepseekApiKey', 'siliconflowApiKey'];
    for (const k of keys) {
      const v = cfg[k] || '';
      line(!!v, `  ${k}`, v ? `已配置(${v.length} 字符)` : '未配置');
    }
    line(Array.isArray(cfg.accounts) && cfg.accounts.length > 0, `  accounts`, `${(cfg.accounts || []).length} 个账号`);
  } catch (e) {
    line(false, '  user.json 解析', e.message);
  }
}
line(fs.existsSync(schedCfg), 'config/schedule.json');

const failed = [t.ffmpeg, t.ffprobe, t.edgeTts].filter(x => !x.ok).length;
console.log(
  failed === 0
    ? '\n✅ 环境检查通过，视频链路可正常使用\n'
    : `\n⚠️ 有 ${failed} 项外部工具不可用，视频生成会被预检拦下（不会产生 API 费用）\n   修复: winget install Gyan.FFmpeg   /   pip install edge-tts\n`
);

process.exit(failed === 0 ? 0 : 1);
