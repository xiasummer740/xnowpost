/**
 * 让所有环境的浏览器**原生**开成同一个窗口尺寸。
 *
 * 结论（2026-10-18 实测）：Camoufox 开窗大小 = 指纹里的 `screen.availWidth/availHeight`，
 * 位置恒 0,0。具体实现（含反面教材）见 `src/collector/uniform-screen.js`，本脚本只是它的 CLI。
 *
 *   node scripts/set-uniform-screen-size.mjs                 # 所有 TKxx，默认 1292x994
 *   node scripts/set-uniform-screen-size.mjs --only TK11     # 只改一个（新建环境后最常用）
 *   node scripts/set-uniform-screen-size.mjs --avail 1292x994 --screen 1366x1024
 *   node scripts/set-uniform-screen-size.mjs --dry-run
 */
import path from 'node:path';
import { applyUniformScreenToAll, resolveDataRoot, DEFAULT_SCREEN } from '../src/collector/uniform-screen.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const getArg = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);

const avail = getArg('--avail') || DEFAULT_SCREEN.avail;
const screen = getArg('--screen') || DEFAULT_SCREEN.screen;
const only = (getArg('--only') || '').toUpperCase();

const [aw, ah] = avail.split('x').map(Number);
const [sw, sh] = screen.split('x').map(Number);
if (!aw || !ah || !sw || !sh) {
  console.error('  参数写法：--avail 1292x994 --screen 1366x1024');
  process.exit(1);
}
if (aw > sw || ah > sh) {
  console.error('  avail 不能大于 screen');
  process.exit(1);
}
if (!resolveDataRoot()) {
  console.error('  找不到 camoufox_data');
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
const backupDir = dryRun ? '' : path.join(resolveDataRoot(), `_screen-backup-${stamp}`);

console.log(`  目标：窗口 ${aw}x${ah} @0,0   模拟屏 ${sw}x${sh}（可用 ${aw}x${ah}）${only ? `  只改 ${only}` : ''}`);
const { results } = applyUniformScreenToAll({ avail, screen, only, dryRun, backupDir });
for (const r of results) {
  if (!r.ok && r.note) {
    console.log(`  ⚠️ ${r.env}: ${r.note}`);
    continue;
  }
  console.log(`  ${dryRun ? '预览' : '✅'} ${r.env}: ${r.before} → ${r.after}`);
}
if (results.length === 0) console.log('  （没有匹配的环境）');
if (!dryRun && results.some((r) => r.ok)) console.log(`\n  备份: ${backupDir}`);
