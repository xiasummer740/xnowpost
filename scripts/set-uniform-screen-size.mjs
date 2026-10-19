/**
 * 让所有环境的浏览器**原生**开成同一个窗口尺寸。
 *
 * 结论（2026-10-18 23:5x 实测，别再试别的路）：
 *   Camoufox 开窗大小 = 指纹里的 `screen.availWidth/availHeight`，位置恒为 0,0。
 *   所以"统一窗口大小"的唯一稳定做法是统一指纹的**可用屏幕**：
 *   把 avail 设成目标窗口尺寸（这里 1292x994），原生就开成 1292x994。
 *   之后不用 Win32 抢、不用 xulstore 赌、不会再被初始化盖回去。
 *
 * 反面教材（都试过）：
 *   · 只写 window.json / xulstore → 被 Camoufox 启动参数盖掉（TK05 变回 1600x856）；
 *   · 启动后用 SetWindowPos 反复纠正 → Firefox 反制，出现 482x211 / 高度 65535；
 *   · 全屏 1920x1080 指纹 → 窗口统一成 1920x1032（统一但太大）。
 *
 *   node scripts/set-uniform-screen-size.mjs                 # 默认 1292x994
 *   node scripts/set-uniform-screen-size.mjs --avail 1292x994 --screen 1292x1024
 *   node scripts/set-uniform-screen-size.mjs --dry-run
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
const getArg = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const parse = (s) => s.split('x').map(Number);

const [aw, ah] = parse(getArg('--avail') || '1292x994');
const [sw, sh] = parse(getArg('--screen') || `${aw}x${ah + 30}`);  // 屏幕比可用区高 30（任务栏）
if (aw > sw || ah > sh) { console.error('avail 不能大于 screen'); process.exit(1); }

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const g = gcd(sw, sh);
const aspect = `${sw / g}/${sh / g}`;

// 一条 Win10 桌面常见的取值关系：窗口可用区 = 屏幕减去任务栏
const screenBlock = {
  availWidth: aw, availHeight: ah, availLeft: 0, availTop: 0,
  width: sw, height: sh, colorDepth: 24, pixelDepth: 24,
};
const mediaCss = {
  'device-aspect-ratio': aspect,
  'device-screen': `${sw} x ${sh}`,
  orientation: sw >= sh ? 'landscape' : 'portrait',
};
// 页面侧 window.*：外框 = 目标窗口尺寸，视口扣掉工具栏和滚动条
const winBlock = {
  innerWidth: aw - 16, innerHeight: ah - 93,
  outerWidth: aw, outerHeight: ah,
  devicePixelRatio: 1, screenX: 0, screenY: 0, pageYOffset: 0,
};

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
const backupDir = path.join(root, `_screen-backup-${stamp}`);
if (!dryRun) fs.mkdirSync(backupDir, { recursive: true });

console.log(`  目标：窗口 ${aw}x${ah} @0,0   模拟屏 ${sw}x${sh}（可用 ${aw}x${ah}）`);

const envs = fs.readdirSync(root).filter((n) => /^TK\d\d$/.test(n)).sort();
for (const env of envs) {
  const file = path.join(root, env, 'fingerprint.json');
  if (!fs.existsSync(file)) { console.log(`  ⚠️ ${env}: 无 fingerprint.json`); continue; }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { console.log(`  ⚠️ ${env}: 解析失败`); continue; }
  const fp = doc.fingerprint || doc;
  const before = fp.screen ? `avail ${fp.screen.availWidth}x${fp.screen.availHeight} / screen ${fp.screen.width}x${fp.screen.height}` : '无';

  if (!dryRun) {
    fs.copyFileSync(file, path.join(backupDir, `${env}-fingerprint.json`));
    fp.screen = { ...screenBlock };
    if (!fp.matchMedia || typeof fp.matchMedia !== 'object') fp.matchMedia = {};
    fp.matchMedia.screenQuery = { width: sw, height: sh };
    fp.matchMedia.mediaCss = { ...(fp.matchMedia.mediaCss || {}), ...mediaCss };
    fp.window = { ...(fp.window || {}), ...winBlock };
    if (!fp.windowComponents || typeof fp.windowComponents !== 'object') fp.windowComponents = {};
    fp.windowComponents.toolbar = 77;
    fp.windowComponents.scrollbar = 16;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8');
    fs.renameSync(tmp, file);

    // window.json 也写一致（FoxProfile 的还原逻辑看到一样的值就什么都不做）
    const wf = path.join(root, env, 'window.json');
    const geo = { x: 0, y: 0, width: aw, height: ah, maximized: false };
    fs.writeFileSync(wf + '.tmp', JSON.stringify(geo), 'utf8');
    fs.renameSync(wf + '.tmp', wf);
  }
  console.log(`  ${dryRun ? '预览' : '✅'} ${env}: ${before} → avail ${aw}x${ah} / screen ${sw}x${sh}`);
}

if (!dryRun) console.log(`\n  备份: ${backupDir}`);

