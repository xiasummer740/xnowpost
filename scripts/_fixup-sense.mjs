import fs from 'node:fs';

const f = 'src/publisher/page-sense.js';
let src = fs.readFileSync(f, 'utf8');
const lines = src.split('\n');

// 找到 startSensing 的签名行
const start = lines.findIndex((l) => l.includes('export async function startSensing('));
if (start < 0) { console.error('没找到 startSensing'); process.exit(1); }
// 找到 "// ⚠️ 别用" 注释行（它是被弄坏的 shot 块的结束标记）
let end = -1;
for (let i = start; i < start + 30; i++) {
  if (lines[i].includes('fs-extra') && lines[i].includes('CommonJS')) { end = i; break; }
}
if (end < 0) { console.error('没找到结束标记'); process.exit(1); }

const block = [
  'export async function startSensing(page, { logFile, shotDir, intervalMs = 300, log = () => {} } = {}) {',
  '  // ⚠️ 别用 `await import(\'fs-extra\')` 再取具名方法：它是 CommonJS，Node 的 ESM 具名导出探测不到',
  '  //    appendFile/writeFile，拿到 undefined 后异常又被 try 吞掉 → 日志永远是空的（2026-10-18 踩过）。',
];

const fixed = [
  ...block,
  '',
  '  /** 拍一张 —— "眼睛"看到关键变化的凭据（弹窗出现 / 发布前后） */',
  '  const shot = async (tag) => {',
  '    if (!shotDir || typeof page.screenshot !== \'function\') return null;',
  '    shots += 1;',
  '    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, \'\');',
  '    const safeTag = String(tag).replace(/[^\\w.-]/g, \'_\');',
  '    const name = `eye-${stamp}-${String(shots).padStart(2, \'0\')}-${safeTag}.png`;',
  '    const file = shotDir + \'/\' + name;',
  '    try {',
  '      await page.screenshot({ path: file });',
  '      log(`  📷 截图(${tag}): ${name}`);',
  '      return file;',
  '    } catch { return null; }',
  '  };',
];

const out = [...lines.slice(0, start), ...fixed, ...lines.slice(end)];
fs.writeFileSync(f, out.join('\n'), 'utf8');
console.log('已修复 startSensing 头部');
