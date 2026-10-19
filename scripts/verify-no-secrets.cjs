/**
 * electron-builder afterPack 钩子 —— 安装包密钥校验
 *
 * 背景：历史上 extraResources 把整个 config/ 目录打进了安装包，
 * 导致 config/user.json 里的真实 API Key 随每个安装包对外发布。
 *
 * 这个钩子在打包完成后扫描产物，只要发现个人配置文件或疑似 API Key，
 * 就直接让构建失败（而不是打出一个带密钥的包）。
 *
 * 注意：只扫描「文本类」文件，二进制(dll/exe/pak/...)一律跳过，
 * 否则像 vk_swiftshader.dll 里的 "sk-Subgroup" 这类字符串会误报。
 */
const fs = require('fs');
const path = require('path');

// 绝不允许出现在安装包里的个人/敏感文件
const FORBIDDEN_FILES = ['user.json', 'schedule.json', 'window-state.json'];

// 绝不允许出现在安装包里的文件类型。
// 曾经误把 BitBrowser 的 db.sqlite 副本（含浏览器/账号 ID）提交进公开仓库，
// 这类文件同样不该被打进安装包。
const FORBIDDEN_EXTS = new Set(['.db', '.sqlite', '.sqlite3', '.db-journal', '.db-wal']);

// 只扫这些扩展名（含无扩展名），其余视为二进制跳过
const TEXT_EXTS = new Set([
  '', '.json', '.js', '.mjs', '.cjs', '.ts', '.txt', '.yml', '.yaml',
  '.html', '.css', '.md', '.ini', '.cfg', '.env', '.xml', '.csv',
]);

// 额外单独扫描 app.asar（它是「自有代码归档」，含 NUL 字节但值得检查）
const ASAR_EXTS = new Set(['.asar']);

// 只匹配「像真 key」的字符串：
//   · DeepSeek  sk- + 32 位 = 35 字符
//   · 硅基流动  sk- + 48 位 ≈ 51 字符
// 长度阈值 28 可排除二进制里 "sk-Subgroup" 这类偶然子串（≤26 字符）
const SECRET_PATTERNS = [
  { name: 'API Key (sk-…)', re: /\bsk-[A-Za-z0-9]{28,}\b/g },
  { name: 'Telegram bot token', re: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g },
];

const MAX_SCAN_BYTES = 64 * 1024 * 1024;

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'locales') continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function readHead(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size === 0) return null;
    const len = Math.min(stat.size, MAX_SCAN_BYTES);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    return buf;
  } catch (_) {
    return null;
  }
}

function scanFile(file) {
  const hits = [];
  const ext = path.extname(file).toLowerCase();
  const isAsar = ASAR_EXTS.has(ext);
  if (!isAsar && !TEXT_EXTS.has(ext)) return hits;

  const buf = readHead(file);
  if (!buf) return hits;

  // 非 asar 且含 NUL 字节 → 二进制，跳过（防 dll/exe 误报）
  if (!isAsar && buf.includes(0)) return hits;

  const text = buf.toString('latin1');
  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    const match = re.exec(text);
    if (match) {
      hits.push({ name, sample: `${match[0].slice(0, 8)}…(${match[0].length} 字符)` });
    }
  }
  return hits;
}

async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const problems = [];

  if (!appOutDir || !fs.existsSync(appOutDir)) {
    throw new Error(`[verify-no-secrets] 无法定位打包产物目录: ${appOutDir}`);
  }

  const files = walk(appOutDir);

  // 1) 禁止出现的个人配置文件（主要防线）
  for (const f of files) {
    if (FORBIDDEN_FILES.includes(path.basename(f))) {
      problems.push(`个人配置文件被打进安装包: ${path.relative(appOutDir, f)}`);
    }
  }

  // 1b) 禁止打包数据库文件
  for (const f of files) {
    if (FORBIDDEN_EXTS.has(path.extname(f).toLowerCase())) {
      problems.push(`数据库文件被打进安装包: ${path.relative(appOutDir, f)}`);
    }
  }

  // 2) 文本文件 + asar 内扫描疑似密钥（兜底防线）
  for (const f of files) {
    for (const hit of scanFile(f)) {
      problems.push(`发现 ${hit.name}（${hit.sample}）于 ${path.relative(appOutDir, f)}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      '\n\n❌ [verify-no-secrets] 打包中止：安装包中检测到敏感信息\n' +
      problems.map(p => `   · ${p}`).join('\n') +
      '\n\n请检查 electron-builder.yml 的 extraResources.filter，' +
      '确保 user.json / schedule.json / window-state.json 未被包含。\n'
    );
  }

  console.log('[verify-no-secrets] ✅ 校验通过：安装包内无 API Key / 无个人配置文件');
}

module.exports = afterPack;
module.exports.default = afterPack;
