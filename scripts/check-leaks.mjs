#!/usr/bin/env node
/**
 * 仓库源码泄露自检 —— `npm run check:leaks`
 *
 * 为什么需要这个：本仓库是 **PUBLIC** 的，已经发生过三类泄露：
 *   1. config/user.json（含真实 API Key）被打进 26 个公开安装包
 *   2. 硬编码的比特浏览器环境 ID 留在 electron/main.js
 *   3. BitBrowser 的 db.sqlite 副本（根目录 tmp.db，含 35 个浏览器/账号 ID）被提交进仓库
 *
 * build 时的 afterPack 钩子只能拦住「打进安装包」的泄露，
 * 拦不住「直接提交进 Git」的泄露 —— 这个脚本补上那一环。
 *
 * 用法：
 *   node scripts/check-leaks.mjs          # 扫描
 *   node scripts/check-leaks.mjs --staged # 只扫 git 暂存区文件（可挂 pre-commit）
 *
 * 误报豁免：在该行任意位置写 `leak-check-allow` 注释即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const STAGED_ONLY = process.argv.includes('--staged');

// 只扫这些目录/文件（源码与配置），避免扫 node_modules / 产物
const SCAN_TARGETS = ['src', 'electron', 'scripts', 'tests', 'electron-builder.yml', 'package.json', '.gitignore'];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', 'output', 'logs', 'backups', 'storage', '.git', 'resource']);

// 只扫文本类文件
const TEXT_EXTS = new Set([
  '', '.js', '.mjs', '.cjs', '.ts', '.vue', '.json', '.txt', '.md', '.yml', '.yaml',
  '.html', '.css', '.ini', '.cfg', '.env', '.xml', '.csv', '.cmd', '.ps1', '.sh',
]);

const RULES = [
  {
    level: 'error',
    name: '真实 API Key',
    // DeepSeek sk-+32 ≈35 字符；硅基流动 sk-+48 ≈51 字符。阈值 28 避开 "sk-Subgroup" 类误报
    re: /\bsk-[A-Za-z0-9]{28,}\b/,
  },
  {
    level: 'error',
    name: 'Telegram Bot Token',
    re: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/,
  },
  {
    level: 'error',
    name: '硬编码的 32 位环境 ID（比特浏览器环境/账号标识）',
    // 必须出现在引号里才算「硬编码」；注释/文档里提到不算
    re: /['"`][0-9a-fA-F]{32}['"`]/,
  },
  {
    level: 'warn',
    name: '个人绝对路径（含用户名或本机目录）',
    re: /[A-Za-z]:[\\/]{1,2}(Users|summer)[\\/]/i,
  },
];

/** 收集待扫描文件 */
function collectFiles() {
  if (STAGED_ONLY) {
    let out = '';
    try {
      out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
        cwd: ROOT, encoding: 'utf-8', windowsHide: true,
      });
    } catch (_) {
      console.error('无法读取 git 暂存区（是否在 git 仓库内？）');
      process.exit(0);
    }
    return out.split('\n').map(s => s.trim()).filter(Boolean)
      .map(f => path.join(ROOT, f))
      .filter(f => fs.existsSync(f) && fs.statSync(f).isFile());
  }

  const files = [];
  const walk = (p) => {
    let stat;
    try { stat = fs.statSync(p); } catch (_) { return; }
    if (stat.isFile()) { files.push(p); return; }
    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(p)) {
      if (SKIP_DIRS.has(name)) continue;
      walk(path.join(p, name));
    }
  };
  for (const t of SCAN_TARGETS) walk(path.join(ROOT, t));
  return files;
}

const findings = [];

for (const file of collectFiles()) {
  if (!TEXT_EXTS.has(path.extname(file).toLowerCase())) continue;

  let content;
  try { content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }
  if (content.includes('\u0000')) continue;   // 二进制

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('leak-check-allow')) continue;      // 显式豁免
    if (/^\s*(\/\/|\*|#)/.test(line) && !/['"`][0-9a-fA-F]{32}['"`]/.test(line)) {
      // 纯注释行：仍检查硬编码 ID，但跳过 key/path 规则以减少噪音
      const m = /['"`][0-9a-fA-F]{32}['"`]/.exec(line);
      if (m) findings.push({ file, line: i + 1, rule: RULES[2], match: m[0] });
      continue;
    }
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (m) findings.push({ file, line: i + 1, rule, match: m[0] });
    }
  }
}

const errors = findings.filter(f => f.rule.level === 'error');
const warns = findings.filter(f => f.rule.level === 'warn');

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

if (findings.length === 0) {
  console.log('✅ [check-leaks] 未发现泄露（Key / Token / 硬编码环境 ID / 个人路径）');
  process.exit(0);
}

if (errors.length) {
  console.error(`\n❌ [check-leaks] 发现 ${errors.length} 处严重泄露：\n`);
  for (const f of errors) {
    console.error(`   ${rel(f.file)}:${f.line}`);
    console.error(`     规则: ${f.rule.name}`);
    console.error(`     命中: ${f.match.slice(0, 60)}`);
  }
}
if (warns.length) {
  console.warn(`\n⚠️  [check-leaks] 发现 ${warns.length} 处需人工确认：\n`);
  for (const f of warns) {
    console.warn(`   ${rel(f.file)}:${f.line}  ${f.rule.name}`);
    console.warn(`     命中: ${f.match.slice(0, 60)}`);
  }
}

if (errors.length) {
  console.error('\n若确为测试夹具/文档示例，请在该行加注释 `leak-check-allow` 豁免。\n');
  process.exit(1);
}
console.log('\n（仅有告警，未阻断）');
process.exit(0);
