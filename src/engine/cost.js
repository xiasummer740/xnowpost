// 成本追踪模块
import fs from 'fs-extra';
import path from 'path';
import { writeJsonAtomic } from '../fs-atomic.js';

const COST_FILE = 'cost.json';

// 成本单价（人民币）
const PRICES = {
  'deepseek-chat': { input: 0.001 / 1000, output: 0.002 / 1000 }, // ¥0.001/K input, ¥0.002/K output
  'Kwai-Kolors/Kolors': { perImage: 0.02 }, // ¥0.02/张（估算）
};

/** 单张生图单价（¥）。给"跳过生图省了多少钱"的日志用，避免在别处硬编码 0.02 */
export function imageUnitPrice() {
  return PRICES['Kwai-Kolors/Kolors'].perImage;
}

let sessionCost = { deepseek: 0, kolors: 0, total: 0 };
// 生图张数：只在日志里展示，便于对账（费用本身按张数单价累计）
let kolorsCount = 0;

export function trackDeepSeek(usage) {
  const price = PRICES['deepseek-chat'];
  const cost = (usage.prompt_tokens || 0) * price.input + (usage.completion_tokens || 0) * price.output;
  sessionCost.deepseek += cost;
  sessionCost.total += cost;
  console.log(`  💰 DeepSeek: ${usage.prompt_tokens}+${usage.completion_tokens} tokens ≈ ¥${cost.toFixed(4)}`);
  return cost;
}

export function trackKolors(count = 1) {
  const cost = PRICES['Kwai-Kolors/Kolors'].perImage * count;
  sessionCost.kolors += cost;
  sessionCost.total += cost;
  kolorsCount += count;
  console.log(`  💰 Kolors: ${count}张 ≈ ¥${cost.toFixed(2)}`);
  return cost;
}

export function getSessionCost() {
  return { ...sessionCost, kolorsCount };
}

/**
 * 写出本次会话的费用快照
 *
 * ⚠️ 旧实现是 `total = 已有 total + sessionCost.total`，而 sessionCost 本身就是
 *    进程内的累计值 —— 一次运行里 saveCostLog 会被调用 2~3 次（开头、结束、报错），
 *    于是同一笔费用被反复相加，费用越跑越虚高。
 *    现在只写"当前进程的累计快照"，重复调用是幂等的。
 * ⚠️ 同时改用原子写（P2-24）：调度器 900s 超时/关窗期间被杀，
 *    截断重写的 cost.json 会变成半截 JSON，费用记录直接丢失。
 */
export async function saveCostLog(sessionDir) {
  await fs.ensureDir(sessionDir);
  const file = path.join(sessionDir, COST_FILE);
  const data = {
    deepseek: Number(sessionCost.deepseek.toFixed(6)),
    kolors: Number(sessionCost.kolors.toFixed(6)),
    total: Number(sessionCost.total.toFixed(6)),
    kolorsCount,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(file, data, 2);
  return file;
}
