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

/** 未知模型的兜底单价：宁可给个估算值，也不要算成 0（0 = "免费"是假话） */
const FALLBACK_TEXT_PRICE = PRICES['deepseek-chat'];

/** 本次会话实际用过的模型（写进 cost.json，对账时知道这钱是哪个模型花的） */
const modelsUsed = new Set();
let priceEstimated = false;

/**
 * 按模型取单价。
 * ⚠️ 只有 `deepseek-chat` 有确认过的单价。2026-10-19 实测：DeepSeek 把
 *    `deepseek-chat` 静默路由到 `deepseek-flash`，另外提供推理型 `deepseek-v4-pro`
 *    —— 这两者的官方单价没有权威来源，所以**按 deepseek-chat 估算并明确标记**，
 *    不要假装精确。
 */
export function priceForModel(model) {
  // 空 = 用默认模型（此时 deepseek-chat 的单价就是精确值，不要误标成"估算"）
  const key = String(model || '').trim() || 'deepseek-chat';
  if (PRICES[key]) return { price: PRICES[key], exact: true, model: key };
  return { price: FALLBACK_TEXT_PRICE, exact: false, model: key };
}

/** 单张生图单价（¥）。给"跳过生图省了多少钱"的日志用，避免在别处硬编码 0.02 */
export function imageUnitPrice() {
  return PRICES['Kwai-Kolors/Kolors'].perImage;
}

let sessionCost = { deepseek: 0, kolors: 0, total: 0 };
// 生图张数：只在日志里展示，便于对账（费用本身按张数单价累计）
let kolorsCount = 0;

export function trackDeepSeek(usage, model = 'deepseek-chat') {
  const { price, exact, model: used } = priceForModel(model);
  modelsUsed.add(used);
  if (!exact) priceEstimated = true;
  const cost = (usage.prompt_tokens || 0) * price.input + (usage.completion_tokens || 0) * price.output;
  sessionCost.deepseek += cost;
  sessionCost.total += cost;
  const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens) || 0;
  const reasonPart = reasoning ? `，其中思考 ${reasoning}` : '';
  const estimatePart = exact ? '' : '（无该模型单价，按 deepseek-chat 估算）';
  console.log(
    `  💰 DeepSeek(${used}): ${usage.prompt_tokens}+${usage.completion_tokens} tokens${reasonPart} ≈ ¥${cost.toFixed(4)}${estimatePart}`,
  );
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
  return { ...sessionCost, kolorsCount, models: [...modelsUsed], estimated: priceEstimated };
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
    // 哪个模型花的钱 + 单价是否为估算（换模型后自动出现，便于对账）
    models: [...modelsUsed],
    estimated: priceEstimated,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(file, data, 2);
  return file;
}
