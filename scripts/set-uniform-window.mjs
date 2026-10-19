/**
 * 把所有指纹浏览器环境的**初始窗口位置和大小**统一成一个值。
 *
 * 依据：Firefox 启动时按 profile 里的 `xulstore.json` → `main-window` 恢复窗口几何，
 * 这是"打开就是那个大小"的唯一可靠开关。Camoufox 的 `window.json` 只是在启动后补一次，
 * 会被初始化过程盖掉（实测 TK05 设 1292x994 → 实际 1600x856）。
 *
 *   node scripts/set-uniform-window.mjs                 # 用 TK01 当前的窗口几何作为标准
 *   node scripts/set-uniform-window.mjs --rect 25,23,1292,994
 *   node scripts/set-uniform-window.mjs --only TK05 --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA_ROOTS = [
  process.env.FOXPROFILE_DATA || 'E:/software/FoxProfile/camoufox_data',
  path.join(process.env.LOCALAPPDATA || '', 'FoxProfile', 'camoufox_data'),
];
const root = DATA_ROOTS.find((p) => fs.existsSync(p));
if (!root) {
  console.error('找不到 camoufox_data 目录');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const only = getArg('--only');

const envDirs = fs.readdirSync(root).filter((n) => /^TK\d\d$/.test(n)).sort();
if (!envDirs.length) {
  console.error('没有找到 TK01… 环境目录');
  process.exit(1);
}

/** 从某个环境读出它的窗口几何（优先 xulstore，其次 window.json） */
function readRect(env) {
  const xul = path.join(root, env, 'xulstore.json');
  try {
    const j = JSON.parse(fs.readFileSync(xul, 'utf8'));
    const w = j['chrome://browser/content/browser.xhtml']?.['main-window'];
    if (w && w.width && w.screenX !== undefined) {
      return { x: +w.screenX, y: +w.screenY, width: +w.width, height: +w.height, src: 'xulstore' };
    }
  } catch { /* 没有就用 window.json */ }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, env, 'window.json'), 'utf8'));
    if (j && j.width) return { x: +j.x, y: +j.y, width: +j.width, height: +j.height, src: 'window.json' };
  } catch { /* ignore */ }
  return null;
}

let target;
const rectArg = getArg('--rect');
if (rectArg) {
  const [x, y, width, height] = rectArg.split(',').map(Number);
  target = { x, y, width, height, src: '--rect' };
} else {
  target = readRect('TK01');
  if (!target) {
    console.error('TK01 没有可用的窗口几何，请用 --rect 指定');
    process.exit(1);
  }
}
console.log(`  标准几何（来自 ${target.src}）: ${target.x},${target.y}  ${target.width}x${target.height}`);

/** 改写 xulstore.json 里的 main-window，保留其它键（比如 sidebar-title） */
function patchXulstore(env) {
  const file = path.join(root, env, 'xulstore.json');
  let doc = {};
  if (fs.existsSync(file)) {
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { doc = {}; }
  }
  const KEY = 'chrome://browser/content/browser.xhtml';
  doc[KEY] = doc[KEY] || {};
  const before = doc[KEY]['main-window'] ? { ...doc[KEY]['main-window'] } : null;
  doc[KEY]['main-window'] = {
    ...(before || {}),
    screenX: String(target.x),
    screenY: String(target.y),
    width: String(target.width),
    height: String(target.height),
    sizemode: 'normal',
  };
  if (!dryRun) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8');
    fs.renameSync(tmp, file);
  }
  return before;
}

function patchWindowJson(env) {
  const file = path.join(root, env, 'window.json');
  const geo = { x: target.x, y: target.y, width: target.width, height: target.height, maximized: false };
  if (!dryRun) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(geo), 'utf8');
    fs.renameSync(tmp, file);
  }
}

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
const backupDir = path.join(root, `_window-backup-${stamp}`);
if (!dryRun) fs.mkdirSync(backupDir, { recursive: true });

for (const env of envDirs) {
  if (only && !only.split(',').includes(env)) continue;
  const before = readRect(env);
  const prevXul = patchXulstore(env);
  patchWindowJson(env);
  if (!dryRun) {
    for (const f of ['xulstore.json', 'window.json']) {
      const src = path.join(root, env, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, `${env}-${f}`));
    }
  }
  const arrow = before ? `${before.width}x${before.height} @${before.x},${before.y}` : '（无记录）';
  console.log(`  ${dryRun ? '预览' : '✅'} ${env}: ${arrow}  →  ${target.width}x${target.height} @${target.x},${target.y}`);
}

if (!dryRun) console.log(`\n  旧文件备份: ${backupDir}`);
console.log(`  提示：正在运行的环境会在关闭时把当前几何写回 xulstore，需先关掉它再改。`);

