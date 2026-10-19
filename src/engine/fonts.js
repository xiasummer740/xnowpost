/**
 * 中文字体解析 —— 回退链 + 明确状态
 *
 * 旧实现（image.js 里一行）只注册 C:\Windows\Fonts\msyh.ttc，失败仅 console.warn：
 * 精简版 Windows / 非中文系统 / 字体被改名时，所有中文都会画成豆腐块，
 * 而调用方毫不知情。这里做三件事：
 *   1. 按回退链找字体（雅黑 → 雅黑 Light/Bold → 黑体 → 宋体 → 等线 → Noto）
 *   2. 都找不到就扫描系统字体目录，挑第一个像 CJK 的
 *   3. 全都没有 → 明确报错，并通过 getFontStatus() 让调用方知道"中文渲染不可用"
 */
import fs from 'fs-extra';

const FONT_DIR = 'C:/Windows/Fonts';

const FONT_CANDIDATES = [
  `${FONT_DIR}/msyh.ttc`,      // 微软雅黑
  `${FONT_DIR}/msyhl.ttc`,     // 微软雅黑 Light
  `${FONT_DIR}/msyhbd.ttc`,    // 微软雅黑 Bold
  `${FONT_DIR}/simhei.ttf`,    // 黑体
  `${FONT_DIR}/simsun.ttc`,    // 宋体
  `${FONT_DIR}/Deng.ttf`,      // 等线
  `${FONT_DIR}/NotoSansCJK-Regular.ttc`,
];

const CJK_FONT_RE = /^(msyh|simhei|simsun|deng|notosanscjk|sourcehansans|msjh)/i;

function pickCjkFont() {
  for (const p of FONT_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  // 兜底：扫描系统字体目录，取第一个看起来像 CJK 的字体
  try {
    const hit = fs.readdirSync(FONT_DIR)
      .filter(f => CJK_FONT_RE.test(f) && /\.(ttc|ttf|otf)$/i.test(f))
      .sort()[0];
    if (hit) return `${FONT_DIR}/${hit}`;
  } catch (_) { /* ignore */ }
  return null;
}

const fontStatus = { ok: false, font: null, error: null };

/**
 * 注册中文字体（模块加载时执行一次）
 * @param {(path: string, alias: string) => void} registerFromPath
 *        @napi-rs/canvas 的 GlobalFonts.registerFromPath —— 由调用方注入，
 *        这样本模块可以脱离 canvas 原生依赖被单测引用
 */
export function registerCjkFont(registerFromPath) {
  if (fontStatus.ok) return fontStatus;
  const fontPath = pickCjkFont();
  if (!fontPath) {
    fontStatus.error = `在系统字体目录 (${FONT_DIR}) 找不到任何中文字体`;
  } else {
    try {
      registerFromPath(fontPath, 'Microsoft YaHei');
      fontStatus.ok = true;
      fontStatus.font = fontPath;
    } catch (e) {
      fontStatus.error = `注册失败: ${e.message}`;
    }
  }
  if (!fontStatus.ok) {
    console.error(`  ❌ 中文字体不可用（${fontStatus.error}）→ 图片中的中文会显示为方块`);
  }
  return fontStatus;
}

/** 供调用方（引擎入口 / GUI）检查中文渲染能力 */
export function getFontStatus() {
  return { ...fontStatus };
}

/** canvas 的 font 简写串（中文优先，找不到时由系统兜底，但会画成方块） */
export const FONT = '"Microsoft YaHei", "SimHei", "Arial", sans-serif';
export const FONT_EN = '"Arial", "Helvetica Neue", sans-serif';
