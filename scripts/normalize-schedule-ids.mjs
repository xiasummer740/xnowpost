#!/usr/bin/env node
/**
 * 把 `config/schedule.json` 里的任务 id 统一成 1..N 的纯序号（一次性迁移）。
 *
 * 背景（用户 2026-10-19 提的「编码能统一一下吗」）：
 * 老版本新建任务用过 `Date.now()` 当 id，于是同一份配置里既有 `1 / 2 / 102`，
 * 又有 `1783852240727` 这种 13 位数字 —— 看日志、看审计账本、跟人沟通时很容易
 * 把「任务编号」误看成「账号号」。id 本身没有任何业务含义（时间和账号都可改），
 * 所以统一成短序号、再也不用时间戳。
 *
 * 排序规则（`renumberJobs`）：先「跑内容的」（video/auto）按时间，再「采集」（collect）按时间。
 * 这样 08:30–09:15 那 10 个视频任务正好拿到 1–10，和账号 01–10 一一对应。
 *
 * 用法：
 *   node scripts/normalize-schedule-ids.mjs --dry-run   # 只看对照表，不写盘
 *   node scripts/normalize-schedule-ids.mjs             # 执行（自动备份到 <数据目录>/data/backups/）
 */
import fs from 'fs-extra';
import path from 'path';
import { renumberJobs } from '../src/job-ids.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const fileArgIdx = args.indexOf('--file');
const explicitFile = fileArgIdx >= 0 ? args[fileArgIdx + 1] : '';

function dataDir() {
  if (process.env.XNOWPOST_DATA_DIR) return process.env.XNOWPOST_DATA_DIR;
  const appData = process.env.APPDATA
    || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'AppData', 'Roaming');
  return path.join(appData, 'xnowpost');
}

const FILE = explicitFile || path.join(dataDir(), 'config', 'schedule.json');

function fmtMode(mode) {
  if (mode === 'collect') return '采集';
  if (mode === 'auto') return '视频+图文';
  return '仅视频';
}

function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`❌ 找不到 ${FILE}`);
    process.exit(1);
  }
  const jobs = fs.readJsonSync(FILE);
  if (!Array.isArray(jobs)) {
    console.error('❌ schedule.json 不是数组，放弃');
    process.exit(1);
  }

  const before = JSON.stringify(jobs);
  const { jobs: next, after } = renumberJobs(jobs);

  // ── 安全校验：只允许 id 变化，别的一个字段都不许动 ──────────────────────
  // 数组顺序是保序的（renumberJobs 不排序输出），所以可以逐项比对
  const stripId = (j) => {
    const c = { ...j };
    delete c.id;
    return JSON.stringify(c);
  };
  if (next.length !== jobs.length) {
    console.error(`❌ 校验失败：任务数 ${jobs.length} → ${next.length}，已放弃写盘`);
    process.exit(1);
  }
  for (let i = 0; i < jobs.length; i += 1) {
    if (stripId(jobs[i]) !== stripId(next[i])) {
      console.error(`❌ 校验失败：第 ${i + 1} 项的 id 以外字段被改了，已放弃写盘`);
      process.exit(1);
    }
  }
  const enabledBefore = jobs.filter((j) => j && j.enabled).length;
  const enabledAfter = next.filter((j) => j && j.enabled).length;
  if (enabledBefore !== enabledAfter) {
    console.error(`❌ 校验失败：启用数 ${enabledBefore} → ${enabledAfter}，已放弃写盘`);
    process.exit(1);
  }

  console.log(`文件：${FILE}`);
  console.log(`任务数：${next.length} 个（启用 ${enabledAfter} 个）\n`);
  console.log('   新 id  旧 id                时间   类型        账号');
  console.log('   -----  -------------------  -----  ----------  ----');
  for (const r of after) {
    console.log(
      `   ${String(r.id).padStart(5)}  ${String(r.oldId).padEnd(19)}  ${String(r.time).padEnd(5)}  ${fmtMode(r.mode).padEnd(10)}  ${r.account || '-'}`,
    );
  }
  console.log(`\n内容是否真的变了：${before === JSON.stringify(next) ? '否（已经是统一的序号）' : '是'}`);

  if (DRY) {
    console.log('\n（--dry-run：没有写入任何文件）');
    return;
  }
  if (before === JSON.stringify(next)) {
    console.log('\n✅ 无需改动');
    return;
  }

  const backupDir = path.join(dataDir(), 'data', 'backups');
  fs.ensureDirSync(backupDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = path.join(backupDir, `schedule-before-id-normalize-${stamp}.json`);
  fs.copyFileSync(FILE, backup);
  console.log(`\n📦 已备份原文件 → ${backup}`);

  // 和 main.js 的写法保持一致：2 空格缩进 + 结尾换行
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, FILE);
  console.log(`✅ 已写入 ${FILE}`);
  console.log('   调度器会自动热重载（日志里应出现「🔄 检测到配置变化，重新加载定时任务」）');
}

main();
