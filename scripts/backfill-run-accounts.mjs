#!/usr/bin/env node
/**
 * 把「逐号结论」补进已有的轮次记录（`data/runs/*.json` 的 `accounts` 字段）。
 *
 * 为什么要补：`accounts` 是 2026-11-01 才加的，之前的记录里没有 ——
 * 首页那张「已完成任务」表对这些旧记录只能显示「这轮没记逐号结论」，
 * 用户升级完第一眼看到的就是一片空白。日志里其实都有，补一次就完整了。
 *
 * 做法：按记录的时间窗 `[startedAtMs, finishedAtMs]` 去 `logs/scheduler-<日期>.log`
 * 里挑出这一轮的行，再用**同一份**解析器（`src/run-accounts.js`）解析 ——
 * 和调度器运行时走的是同一套规则，不另写一份。
 *
 * 用法：
 *   node scripts/backfill-run-accounts.mjs --dry-run     # 只看会改哪些
 *   node scripts/backfill-run-accounts.mjs
 * 必须带数据目录（在仓库目录跑 CLI 的老坑）：
 *   $env:XNOWPOST_DATA_DIR = "$env:APPDATA\xnowpost"
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from '../src/paths.js';
import { parseAccountResults } from '../src/run-accounts.js';

const dryRun = process.argv.includes('--dry-run');
const runsDir = dataPath('data/runs');
const logsDir = dataPath('logs');

if (!fs.existsSync(runsDir)) {
  console.error(`❌ 找不到轮次记录目录：${runsDir}`);
  process.exit(1);
}

/** `[2026-11-01 02:12:08] ✅ TK01 …` → 毫秒时间戳（本地时间） */
function lineTimeMs(line) {
  const m = String(line).match(/^\[(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\]/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

function readLog(date) {
  const file = path.join(logsDir, `scheduler-${date}.log`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n');
}

const files = fs.readdirSync(runsDir).filter((n) => n.endsWith('.json'));
let filled = 0;
let skipped = 0;
let unchanged = 0;

for (const name of files) {
  const full = path.join(runsDir, name);
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (_) {
    console.log(`  ⚠️ ${name} 读不了，跳过`);
    continue;
  }
  if (Array.isArray(rec.accounts) && rec.accounts.length) {
    unchanged++;
    continue;   // 已经有结论，别覆盖（运行时写的是最准的）
  }
  const started = Number(rec.startedAtMs) || 0;
  const finished = Number(rec.finishedAtMs) || 0;
  if (!started || !finished) {
    skipped++;
    continue;
  }
  const date = String(rec.date || name.slice(0, 10));
  const lines = readLog(date);
  if (!lines.length) {
    skipped++;
    continue;
  }
  // 时间窗放宽 90 秒：子进程输出的时间戳可能比 startedAtMs 早几秒（进程启动到第一行日志）
  const from = started - 90_000;
  const to = finished + 90_000;
  const inWindow = lines.filter((l) => {
    const t = lineTimeMs(l);
    return Number.isFinite(t) && t >= from && t <= to;
  });
  const accounts = parseAccountResults(inWindow);
  if (!accounts.length) {
    skipped++;
    console.log(`  ⏭️ ${name}（${rec.label || rec.mode}）窗口内没有逐号行，跳过`);
    continue;
  }
  console.log(`  ✅ ${name}（${rec.label || rec.mode}）补 ${accounts.length} 个号：`
    + accounts.map((a) => `${a.env}:${a.level}`).join(' '));
  if (!dryRun) {
    rec.accounts = accounts;
    fs.writeFileSync(full, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  }
  filled++;
}

console.log(`\n${dryRun ? '（演练，未写盘）' : ''}补好 ${filled} 条，已有结论 ${unchanged} 条，补不了 ${skipped} 条。`);
