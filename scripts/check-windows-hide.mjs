#!/usr/bin/env node
/**
 * CMD 弹窗零容忍自检 —— `npm run check:windows-hide`
 *
 * CLAUDE.md 最高优先级规则：所有 `spawn()` / `execSync()` / `spawnSync()` /
 * `execFileSync()` / `execFile()` / `exec()` 都必须带 `windowsHide: true`，
 * 不允许出现任何 CMD 窗口。
 *
 * 为什么不用 grep：
 *  1. 真实调用普遍是**多行**的（options 对象跨好几行），逐行 grep 会漏判 → 这里做括号配对。
 *  2. `db.exec(sql)`（sql.js）、`regex.exec(str)` 这类**同名方法**不是子进程 → 用负向后顾排除 `x.exec(`。
 *  3. 注释与字符串里出现的 `spawn(` 不是真调用 → 先把注释/字符串/正则字面量掩码掉。
 *
 * 退出码 1 = 存在不带 windowsHide 的调用。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TARGETS = ['src', 'electron', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', 'output', 'logs', '.git']);

/** 把注释 / 字符串 / 正则字面量替换成等长空白（保留换行），得到「纯代码」视图 */
function maskNonCode(src) {
  const out = src.split('');
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  let i = 0;
  let prevSignificant = '';
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      const start = i;
      while (i < src.length && src[i] !== '\n') i++;
      blank(start, i);
      continue;
    }
    if (c === '/' && n === '*') {
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      blank(start, i);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const start = i;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      blank(start, i);
      prevSignificant = quote;
      continue;
    }
    // 正则字面量：`/` 前面是运算符/括号/等号/行首 时视为正则
    if (c === '/' && /[=(,:[!&|?{};+\-*%~^<>]/.test(prevSignificant || '(')) {
      const start = i;
      i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { i++; break; }
        else if (src[i] === '\n') break;   // 未闭合，当作除号处理
        i++;
      }
      // 吃掉 flags
      while (i < src.length && /[a-z]/i.test(src[i])) i++;
      blank(start, i);
      prevSignificant = '/';
      continue;
    }
    if (!isSpace(c)) prevSignificant = c;
    i++;
  }
  return out.join('');
}

/** 从 openParen 下标开始找配对右括号 */
function findCallEnd(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const files = [];
const walk = (p) => {
  let stat;
  try { stat = fs.statSync(p); } catch (_) { return; }
  if (stat.isFile()) { files.push(p); return; }
  if (!stat.isDirectory()) return;
  for (const n of fs.readdirSync(p)) {
    if (SKIP_DIRS.has(n)) continue;
    walk(path.join(p, n));
  }
};
for (const t of TARGETS) walk(path.join(ROOT, t));

// 只有真正引用了 child_process 的文件才可能存在子进程调用。
// 这样 `db.exec(sql)` / `re.exec(str)` 这类同名方法天然被排除，
// 同时又能抓到 `cp.execSync(...)` —— 后者是最常见的写法，绝不能因为带 `.` 就漏掉。
const USES_CP_RE = /child_process|childProcess|child-process/;

// 名字无歧义，带不带 `.` 前缀都算（child_process.spawn / cp.spawnSync / …）
const BROAD_RE = /(?<![\w$])(spawn|spawnSync|execSync|execFileSync|execFile)\s*\(/g;
// `exec` 有歧义（db.exec / re.exec / stmt.exec）：
//   裸调用 `exec(cmd)` → 算；`child_process.exec(...)` / `cp.exec(...)` → 算
const EXEC_BARE_RE = /(?<![.\w$])exec\s*\(/g;
const EXEC_CP_RE = /(?<![\w$])(?:child_process|childProcess|child_process_promises|cp|cpPromises)\s*\.\s*exec\s*\(/g;
const CP_ALIAS_RE = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:require\(\s*['"](?:node:)?child_process['"]\s*\)|import\s*\(\s*['"](?:node:)?child_process['"]\s*\))/g;

const ok = [];
const bad = [];
let scannedFiles = 0;

for (const file of files) {
  if (!/\.(js|mjs|cjs|ts)$/.test(file)) continue;
  const raw = fs.readFileSync(file, 'utf-8');
  const code = maskNonCode(raw);
  if (code.length !== raw.length) continue;   // 掩码必须等长，否则索引会错
  const lineOf = (idx) => raw.slice(0, idx).split('\n').length;

  // 门禁：没有 child_process 的文件不可能有子进程调用（排除 db.exec / re.exec 误报）。
  // ⚠️ 必须用 raw —— 'child_process' 是字符串字面量，会被 maskNonCode 抹成空白。
  if (!USES_CP_RE.test(raw)) continue;
  scannedFiles++;

  // 收集本文件里 child_process 的别名（const cp = require('child_process')），同样要用 raw
  const aliases = new Set(['child_process', 'childProcess', 'child_process_promises']);
  CP_ALIAS_RE.lastIndex = 0;
  let am;
  while ((am = CP_ALIAS_RE.exec(raw)) !== null) aliases.add(am[1]);

  const matches = [];
  for (const re of [BROAD_RE, EXEC_BARE_RE, EXEC_CP_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) matches.push({ index: m.index, len: m[0].length, fnName: (m[1] || 'exec').trim() });
  }
  // 去重（EXEC_CP_RE 与 BROAD_RE 不会重叠，但保守起见）
  const seenIdx = new Set();
  for (const mt of matches) {
    if (seenIdx.has(mt.index)) continue;
    seenIdx.add(mt.index);

    const openIdx = mt.index + mt.len - 1;
    const endIdx = findCallEnd(code, openIdx);
    if (endIdx === -1) continue;
    const callText = raw.slice(mt.index, endIdx + 1);

    // 排除「对象/类里的方法定义」，例如 `exec(sql) { ... }`（src/db.js 的 sql.js 包装器）。
    // 真正的子进程调用后面绝不会紧跟一个块 `{`。
    let after = endIdx + 1;
    while (after < code.length && /\s/.test(code[after])) after++;
    if (code[after] === '{') continue;

    // `exec` 的额外甄别：只认裸调用或 child_process 别名接收者
    if (mt.fnName === 'exec') {
      const before = code.slice(Math.max(0, mt.index - 60), mt.index);
      const recv = /([\w$]+)\s*\.\s*$/.exec(before);
      if (recv && !aliases.has(recv[1])) continue;   // 形如 db.exec / re.exec → 跳过
    }

    const entry = { file: path.relative(ROOT, file).replace(/\\/g, '/'), line: lineOf(mt.index), fnName: mt.fnName, callText };
    if (/windowsHide\s*:\s*true/.test(callText)) ok.push(entry);
    else bad.push(entry);
  }
}

console.log(`[check:windows-hide] 扫描 ${files.length} 个文件，其中 ${scannedFiles} 个引用了 child_process`);
console.log(`  ✅ 带 windowsHide: true : ${ok.length}`);

if (bad.length === 0) {
  console.log('  ✅ 无违规调用');
  process.exit(0);
}

console.error(`\n❌ [check:windows-hide] ${bad.length} 处子进程调用**缺少** windowsHide: true：\n`);
for (const b of bad) {
  const head = b.callText.split('\n')[0].replace(/\s+/g, ' ');
  console.error(`   ${b.file}:${b.line}  ${b.fnName}()`);
  console.error(`      ${head.slice(0, 100)}`);
}
console.error('\n请补上 `windowsHide: true`（CLAUDE.md 最高优先级规则）。\n');
process.exit(1);
