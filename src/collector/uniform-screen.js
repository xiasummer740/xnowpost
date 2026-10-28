/**
 * 统一指纹里的「屏幕尺寸」——**窗口原生大小的唯一来源**（2026-10-18 实测）。
 *
 * Camoufox 开窗大小 = 指纹里的 `screen.availWidth/availHeight`，位置恒 0,0。
 * 所以新环境（TK11…）如果不动指纹，FoxProfile 会随手给一个 1920x1080 之类的默认值，
 * 窗口就比老环境大一圈（用户 2026-10-24 反馈「扫码加号那个窗口怎么这么大」）。
 *
 * 规则只有一份：`scripts/set-uniform-screen-size.mjs`（批量）和
 * `scripts/tk-login-batch.mjs`（新建环境后自动）都调这里的 `applyUniformScreen()`。
 *
 * 反面教材（都试过，别再走）：
 *   · 只写 window.json / xulstore → 被 Camoufox 启动参数盖掉；
 *   · 启动后用 SetWindowPos 反复纠正 → Firefox 反制，出现 482x211 / 高度 65535。
 */
import fs from 'node:fs';
import path from 'node:path';

export const DATA_ROOTS = [
  process.env.FOXPROFILE_DATA || 'E:/software/FoxProfile/camoufox_data',
  path.join(process.env.LOCALAPPDATA || '', 'FoxProfile', 'camoufox_data'),
];

/** 默认口径：窗口 1292x994，模拟屏 1292x1024 —— 和 10 个老环境的指纹一字不差
 *  （老环境是 10-18 那次批量写的，screen=1292x1024；不要改成 1366x1024，
 *   那会让新号的指纹跟老号差一档）。 */
export const DEFAULT_SCREEN = { avail: '1292x994', screen: '1292x1024' };

export function resolveDataRoot() {
  return DATA_ROOTS.find((p) => p && fs.existsSync(p)) || '';
}

function blocks(aw, ah, sw, sh) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(sw, sh) || 1;
  return {
    screenBlock: {
      availWidth: aw, availHeight: ah, availLeft: 0, availTop: 0,
      width: sw, height: sh, colorDepth: 24, pixelDepth: 24,
    },
    mediaCss: {
      'device-aspect-ratio': `${sw / g}/${sh / g}`,
      'device-screen': `${sw} x ${sh}`,
      orientation: sw >= sh ? 'landscape' : 'portrait',
    },
    winBlock: {
      innerWidth: aw - 16, innerHeight: ah - 93,
      outerWidth: aw, outerHeight: ah,
      devicePixelRatio: 1, screenX: 0, screenY: 0, pageYOffset: 0,
    },
    geo: { x: 0, y: 0, width: aw, height: ah, maximized: false },
  };
}

/**
 * 把某一个环境的指纹屏幕改统一。**必须在环境启动之前调用**（指纹是启动时读的）。
 * @returns {{env:string, before:string, after:string, ok:boolean, note?:string}}
 */
export function applyUniformScreen(env, opts = {}) {
  const root = opts.root || resolveDataRoot();
  const [aw, ah] = String(opts.avail || DEFAULT_SCREEN.avail).split('x').map(Number);
  const [sw, sh] = String(opts.screen || DEFAULT_SCREEN.screen).split('x').map(Number);
  const after = `avail ${aw}x${ah} / screen ${sw}x${sh}`;
  const out = { env, before: '无', after, ok: false };
  if (!root) return { ...out, note: '找不到 camoufox_data' };

  const file = path.join(root, env, 'fingerprint.json');
  if (!fs.existsSync(file)) return { ...out, note: '没有 fingerprint.json' };

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ...out, note: `解析失败: ${e.message}` };
  }
  const fp = doc.fingerprint || doc;
  if (fp.screen) out.before = `avail ${fp.screen.availWidth}x${fp.screen.availHeight} / screen ${fp.screen.width}x${fp.screen.height}`;
  if (opts.dryRun) return { ...out, ok: true };

  const b = blocks(aw, ah, sw, sh);
  if (opts.backupDir) {
    fs.mkdirSync(opts.backupDir, { recursive: true });
    fs.copyFileSync(file, path.join(opts.backupDir, `${env}-fingerprint.json`));
  }
  fp.screen = { ...b.screenBlock };
  if (!fp.matchMedia || typeof fp.matchMedia !== 'object') fp.matchMedia = {};
  fp.matchMedia.screenQuery = { width: sw, height: sh };
  fp.matchMedia.mediaCss = { ...(fp.matchMedia.mediaCss || {}), ...b.mediaCss };
  fp.window = { ...(fp.window || {}), ...b.winBlock };
  if (!fp.windowComponents || typeof fp.windowComponents !== 'object') fp.windowComponents = {};
  fp.windowComponents.toolbar = 77;
  fp.windowComponents.scrollbar = 16;

  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8');
  fs.renameSync(tmp, file);

  // window.json 写一致（FoxProfile 的还原逻辑看到一样的值就什么都不做）
  const wf = path.join(root, env, 'window.json');
  fs.writeFileSync(`${wf}.tmp`, JSON.stringify(b.geo), 'utf8');
  fs.renameSync(`${wf}.tmp`, wf);

  return { ...out, ok: true };
}

/** 批量：把 camoufox_data 下所有 TKxx 环境统一（脚本用）。 */
export function applyUniformScreenToAll(opts = {}) {
  const root = opts.root || resolveDataRoot();
  if (!root) return { root: '', results: [] };
  const envs = fs
    .readdirSync(root)
    .filter((n) => /^TK\d\d$/.test(n))
    .sort()
    .filter((n) => !opts.only || opts.only === n);
  return { root, results: envs.map((env) => applyUniformScreen(env, { ...opts, root })) };
}
