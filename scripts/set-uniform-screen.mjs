/**
 * 把所有环境指纹里"跟屏幕/窗口耦合"的那几个字段统一成同一个模板。
 *
 * 为什么必须改指纹：Camoufox 用指纹里的模拟屏幕尺寸开窗（`--width/--height` = avail 尺寸），
 * 而且窗口不能大于模拟屏幕 —— 所以屏幕不一样，窗口就永远不可能一样。
 * 实测：TK05 屏 1600x900 → 窗口 1600x856；TK02 屏 1536x864 → 1536x816；
 *       TK09 屏 1920x1080 → 窗口能稳住 1292x994。
 *
 * 只改这 5 个键（其它指纹特征——GPU/字体/语言/时区/WebGL 全部原样保留）：
 *   screen / matchMedia / window / windowComponents
 * 再配合 scripts/set-uniform-window.mjs 写 xulstore，窗口就固定在 25,23 1292x994。
 *
 *   node scripts/set-uniform-screen.mjs                # 用 TK09 当模板
 *   node scripts/set-uniform-screen.mjs --from TK03    # 指定模板环境
 *   node scripts/set-uniform-screen.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = [
  process.env.FOXPROFILE_DATA || 'E:/software/FoxProfile/camoufox_data',
  path.join(process.env.LOCALAPPDATA || '', 'FoxProfile', 'camoufox_data'),
];
const root = ROOTS.find((p) => fs.existsSync(p));
if (!root) { console.error('找不到 camoufox_data'); process.exit(1); }

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : 'TK09';
// 模板里这几个键会被整块复制过去
const KEYS = ['screen', 'matchMedia', 'window', 'windowComponents'];

const tplFile = path.join(root, from, 'fingerprint.json');
if (!fs.existsSync(tplFile)) { console.error(`模板环境 ${from} 没有 fingerprint.json`); process.exit(1); }
const tplRoot = JSON.parse(fs.readFileSync(tplFile, 'utf8'));
const tpl = tplRoot.fingerprint || tplRoot;
const patch = {};
for (const k of KEYS) {
  if (tpl[k] === undefined) { console.error(`模板缺少 ${k}`); process.exit(1); }
  patch[k] = tpl[k];
}
console.log(`  模板: ${from}  screen ${patch.screen.width}x${patch.screen.height} (avail ${patch.screen.availWidth}x${patch.screen.availHeight})  dpr ${patch.window.devicePixelRatio}`);

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
const backupDir = path.join(root, `_fingerprint-backup-${stamp}`);
if (!dryRun) fs.mkdirSync(backupDir, { recursive: true });

const envs = fs.readdirSync(root).filter((n) => /^TK\d\d$/.test(n)).sort();
for (const env of envs) {
  const file = path.join(root, env, 'fingerprint.json');
  if (!fs.existsSync(file)) { console.log(`  ⚠️ ${env}: 没有 fingerprint.json，跳过`); continue; }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { console.log(`  ⚠️ ${env}: 解析失败，跳过`); continue; }
  const fp = doc.fingerprint || doc;
  const before = fp.screen ? `${fp.screen.width}x${fp.screen.height}` : '无';
  if (!dryRun) {
    fs.copyFileSync(file, path.join(backupDir, `${env}-fingerprint.json`));
    for (const k of KEYS) fp[k] = JSON.parse(JSON.stringify(patch[k]));
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8');
    fs.renameSync(tmp, file);
  }
  console.log(`  ${dryRun ? '预览' : '✅'} ${env}: screen ${before} → ${patch.screen.width}x${patch.screen.height}`);
}

if (!dryRun) console.log(`\n  旧指纹备份: ${backupDir}`);
console.log('  下一步（可选）：node scripts/set-uniform-window.mjs  # 写 xulstore 里的窗口几何');

