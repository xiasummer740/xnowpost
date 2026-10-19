#!/usr/bin/env node
/**
 * 把「每天两组、每组 10 个、每个账号一条视频」的定时结构一次设好。
 *
 * 用户口径（2026-10-19）：
 *   · 10 个账号（01–10），**一个账号发一个视频**；
 *   · 两组，分别从 08:30 和 00:30 开始，每个闹钟间隔 **5 分钟**；
 *   · 两组都要启用（= 每个账号一天发 2 条）。
 *
 * 为什么要脚本而不是在界面上点 20 次：这是**幂等的结构声明** ——
 * 重复跑只会把结构修正回目标状态（已有就启用/对齐时间，没有就新建），
 * 不会重复插入。事后想改规则（换起始时间、换账号数）改参数重跑即可。
 *
 * 用法：
 *   node scripts/set-daily-schedule.mjs --dry-run
 *   node scripts/set-daily-schedule.mjs                       # 默认两组建 10 个
 *   node scripts/set-daily-schedule.mjs --accounts 01-08      # 只做前 8 个号
 *   node scripts/set-daily-schedule.mjs --start-morning 09:00 --start-midnight 01:00
 *
 * 安全：写盘前备份到 `<数据目录>/data/backups/`；只增改「视频类」任务，
 * 采集类（10:00 数据采集）和无关的老任务（如 23:16）一律不碰。
 */
import fs from 'fs-extra';
import path from 'path';
import { nextJobId } from '../src/job-ids.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const START_MORNING = opt('--start-morning', '08:30');
const START_MIDNIGHT = opt('--start-midnight', '00:30');
const STEP = Number(opt('--step', '5'));
const COUNT = Number(opt('--count', '10'));
const ACCOUNTS_RAW = opt('--accounts', '01-10');

function dataDir() {
  if (process.env.XNOWPOST_DATA_DIR) return process.env.XNOWPOST_DATA_DIR;
  const appData = process.env.APPDATA
    || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'AppData', 'Roaming');
  return path.join(appData, 'xnowpost');
}

const FILE = path.join(dataDir(), 'config', 'schedule.json');

/** '01-10' / '01,03,05' → ['01','03','05'…] */
function parseAccounts(raw) {
  const out = [];
  for (const part of String(raw).split(',')) {
    const s = part.trim();
    const m = s.match(/^(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      for (let i = a; i <= b; i += 1) out.push(String(i).padStart(2, '0'));
    } else if (/^\d{1,2}$/.test(s)) {
      out.push(String(Number(s)).padStart(2, '0'));
    }
  }
  return [...new Set(out)];
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** '08:30' + 5*3 分钟 → '08:45'（跨零点也对） */
function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (h * 60 + m + mins) % (24 * 60);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

const LABEL = { video: '仅视频', auto: '视频+图文', post: '仅图文' };

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

  const accounts = parseAccounts(ACCOUNTS_RAW);
  if (!accounts.length) {
    console.error('❌ 账号列表解析为空');
    process.exit(1);
  }

  // 目标结构：两组 × 每个账号一条「仅视频」
  const plan = [];
  accounts.forEach((account, i) => {
    plan.push({ group: '上午', time: addMinutes(START_MORNING, i * STEP), mode: 'video', account });
  });
  accounts.forEach((account, i) => {
    plan.push({ group: '凌晨', time: addMinutes(START_MIDNIGHT, i * STEP), mode: 'video', account });
  });

  const enabledBefore = jobs.filter((j) => j && j.enabled !== false).length;
  const created = [];
  const updated = [];
  const unchanged = [];

  for (const p of plan) {
    const hit = jobs.find((j) => j && String(j.time) === p.time
      && String(j.mode || 'video') === p.mode
      && String(j.account || '') === p.account);
    if (hit) {
      if (hit.enabled === false) {
        hit.enabled = true;
        updated.push({ ...p, id: hit.id, what: '启用' });
      } else {
        unchanged.push({ ...p, id: hit.id });
      }
      continue;
    }
    const id = nextJobId(jobs);
    jobs.push({ id, time: p.time, mode: p.mode, label: LABEL[p.mode], enabled: true, account: p.account });
    created.push({ ...p, id });
  }

  const show = (rows) => rows.forEach((r) => {
    console.log(`   #${String(r.id).padStart(3)}  ${r.group}  ${r.time}  ${LABEL[r.mode]}  · 账号 ${r.account}${r.what ? `（${r.what}）` : ''}`);
  });

  console.log(`文件：${FILE}`);
  console.log(`目标：${accounts.length} 个账号 × 2 组 = ${plan.length} 个闹钟（间隔 ${STEP} 分钟）`);
  console.log(`   上午组 ${START_MORNING} → ${addMinutes(START_MORNING, (accounts.length - 1) * STEP)}`);
  console.log(`   凌晨组 ${START_MIDNIGHT} → ${addMinutes(START_MIDNIGHT, (accounts.length - 1) * STEP)}\n`);
  if (created.length) { console.log(`新建 ${created.length} 个：`); show(created); }
  if (updated.length) { console.log(`\n启用 ${updated.length} 个（原来停用）：`); show(updated); }
  if (unchanged.length) { console.log(`\n已经是目标状态 ${unchanged.length} 个（不动）`); }

  const enabledAfter = jobs.filter((j) => j && j.enabled !== false).length;
  console.log(`\n启用数：${enabledBefore} → ${enabledAfter}；任务总数：20 → ${jobs.length}`);

  if (DRY) {
    console.log('\n（--dry-run：没有写入任何文件）');
    return;
  }
  if (!created.length && !updated.length) {
    console.log('\n✅ 已经是目标状态，无需改动');
    return;
  }

  const backupDir = path.join(dataDir(), 'data', 'backups');
  fs.ensureDirSync(backupDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = path.join(backupDir, `schedule-before-daily-layout-${stamp}.json`);
  fs.copyFileSync(FILE, backup);
  console.log(`📦 已备份原文件 → ${backup}`);

  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, FILE);
  console.log(`✅ 已写入 ${FILE}`);
  console.log('   调度器会自动热重载（日志：「🔄 检测到配置变化，重新加载定时任务」）');
}

main();
