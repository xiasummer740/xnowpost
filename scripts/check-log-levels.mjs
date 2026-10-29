/**
 * 日志级别守卫：不许用 `❌` / `⏱️` 写"正常/成功"的提示行。
 *
 * 为什么需要这个脚本（不是洁癖）：
 * `electron/main.js` 的日志分级与「任务异常」系统通知都是**看行内图标**的 ——
 *   isFailure / notifyFailure / classifyEngineLine 都是 /❌|⏱️|⚠️.*未确认/。
 * 于是任何一条"成功"文案里混进 `⏱️`，界面就多一条红色错误、桌面上就多弹一次
 * 「XNOWPost 定时任务异常」。2026-10-29 一天踩了**两次**：
 *   - `⏱️ 发布预算: 12.0 分钟（…超时…未确认…）` —— 9 条假错误 + 12 次误弹窗；
 *   - `⏱️ 时间轴校验通过: 音频 22.12s ≈ 时间轴 22.12s` —— 又是 9 条假错误（"通过"被记成错误）。
 * 修文案能解决当下，但下一个人写 `⏱️` 时没人拦 → 所以上闸门。
 *
 * 规则（只看 console.log / console.info，也就是"正常信息"这一档）：
 *   1. 出现 `⏱️` → 一律不允许（真超时那行走的是 scheduler.js 的 log()，不是 console.log）；
 *   2. 出现 `❌` → 除非同一行还有明确的失败语气词（失败 / 无法 / 错误 / 不完整 / 跳过），
 *      否则不允许（自检、统计、"通过"这类文案要用 ✅ / ⚠️）。
 * console.warn / console.error 不受限制 —— 那两个本来就该带 ❌。
 *
 * 用法：node scripts/check-log-levels.mjs      （npm run verify 会跑）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TARGETS = ['src', 'electron'];
// 只有**输出会进引擎日志分级**的脚本才在这里：调度器 spawn 的养号脚本。
// `tk-login-batch.mjs` / `tk-profile-edit.mjs` 的 ❌ 是逐号失败明细，走账号页的
// `accounts:progress` 流、不经过 classifyEngineLine，所以不纳入本闸门。
const EXTRA_FILES = ['scripts/tk-warmup.mjs'];

/** 失败语气词：出现这些才允许 console.log 里带 ❌ */
const FAILURE_WORDS = /失败|无法|错误|异常|不完整|跳过|中止|放弃/;

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(p, out);
    } else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) {
      out.push(p);
    }
  }
  return out;
}

const files = [
  ...TARGETS.flatMap((d) => walk(path.join(ROOT, d))),
  ...EXTRA_FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
];

const problems = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    // 只看"正常信息"档；注释行天然不含 console.log(，不会被误判
    if (!/console\.(log|info)\s*\(/.test(line)) return;
    if (line.includes('⏱️')) {
      problems.push({
        file: rel, line: i + 1,
        why: 'console.log 里出现 ⏱️ —— 日志分级会把这行记成 [ERROR] 并弹系统通知（真超时请用 ⏳/❌ 且带失败语气词）',
        text: line.trim(),
      });
    }
    if (line.includes('❌') && !FAILURE_WORDS.test(line)) {
      problems.push({
        file: rel, line: i + 1,
        why: 'console.log 里用 ❌ 写非失败信息 —— 会被记成 [ERROR]；自检/统计请用 ✅ 或 ⚠️',
        text: line.trim(),
      });
    }
  });
}

if (!problems.length) {
  console.log(`✅ 日志级别检查通过（${files.length} 个文件，没有用 ❌/⏱️ 写正常信息）`);
  process.exit(0);
}

console.error(`❌ 日志级别检查失败：${problems.length} 处`);
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}  ${p.why}`);
  console.error(`    ${p.text.slice(0, 120)}`);
}
process.exit(1);
