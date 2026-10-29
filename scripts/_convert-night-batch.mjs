/**
 * 一次性迁移：把「凌晨 11 个每 5 分钟一个」的闹钟换成 1 个批量闹钟（00:30 按顺序跑 11 个号）。
 * 用户口径（2026-10-29）：「我设置闹钟开始，然后选择几个账号，你就按顺序生成、发布完就完事了」。
 *
 * 用法：node scripts/_convert-night-batch.mjs [--dry-run]
 */
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const DRY = process.argv.includes('--dry-run');
const dataDir = process.env.XNOWPOST_DATA_DIR || path.join(os.homedir(), 'AppData', 'Roaming', 'xnowpost');
const file = path.join(dataDir, 'config', 'schedule.json');
const jobs = await fs.readJson(file);
if (!Array.isArray(jobs)) throw new Error('schedule.json 不是数组，先人工看一眼');

// 凌晨那一批：00:30 / 00:35 … 01:20，mode=video 且带 account
const NIGHT = /^0[01]:(2[05]|3[05]|4[05]|5[05]|1[05])$/;
const isNightVideo = (j) => j && j.mode === 'video' && String(j.account || '').trim()
  && (String(j.time) >= '00:30' && String(j.time) <= '01:20');

const nightJobs = jobs.filter(isNightVideo);
if (!nightJobs.length) {
  console.log('没找到凌晨那批闹钟（可能已经改过了），什么都没做。');
  process.exit(0);
}
const accounts = [...new Set(nightJobs.map((j) => String(j.account).trim()))].sort();
console.log(`找到 ${nightJobs.length} 个凌晨闹钟，覆盖账号：${accounts.join(', ')}`);

// 新闹钟 id：拿现有最大 id + 1（job-ids 的规则是 1~999 纯序号）
const maxId = jobs.reduce((m, j) => Math.max(m, Number(j.id) || 0), 0);
const newId = maxId + 1;
if (newId > 999) throw new Error(`id 超过 999（${newId}），先跑 scripts/normalize-schedule-ids.mjs`);

const batchJob = {
  id: newId,
  time: '00:30',
  mode: 'batch',
  label: '批量生成+发布',
  enabled: true,
  account: '',
  warmupAccounts: accounts.join(','),
};

const disabled = [];
const next = [];
for (const j of jobs) {
  if (isNightVideo(j)) {
    if (j.enabled === false) continue;          // 已经停用的直接删掉，别留着占位
    disabled.push(`${j.time}/${j.account}`);
    if (!DRY) j.enabled = false;                // 保留但停用（想回退时一键启用）
    next.push(j);
  } else {
    next.push(j);
  }
}
if (!DRY) next.push(batchJob);

console.log(`停用：${disabled.join('、')}`);
console.log(`新增：#${batchJob.id} ${batchJob.time} mode=batch 账号 ${batchJob.warmupAccounts}`);
if (DRY) {
  console.log('（--dry-run，没有写盘）');
  process.exit(0);
}
await fs.writeJson(file, next, { spaces: 2 });
console.log(`✅ 已写入 ${file}（${next.filter((j) => j.enabled !== false).length} 个启用中的闹钟）`);
