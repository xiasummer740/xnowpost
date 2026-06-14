// 成本追踪模块
import fs from 'fs-extra';
import path from 'path';

const COST_FILE = 'cost.json';

// 成本单价（人民币）
const PRICES = {
  'deepseek-chat': { input: 0.001 / 1000, output: 0.002 / 1000 }, // ¥0.001/K input, ¥0.002/K output
  'Kwai-Kolors/Kolors': { perImage: 0.02 }, // ¥0.02/张（估算）
};

let sessionCost = { deepseek: 0, kolors: 0, total: 0 };

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
  console.log(`  💰 Kolors: ${count}张 ≈ ¥${cost.toFixed(2)}`);
  return cost;
}

export function getSessionCost() {
  return { ...sessionCost };
}

export async function saveCostLog(sessionDir) {
  await fs.ensureDir(sessionDir);
  const file = path.join(sessionDir, COST_FILE);
  let data = {};
  if (await fs.pathExists(file)) data = await fs.readJson(file);
  const total = (data.total || 0) + sessionCost.total;
  data = { ...data, ...sessionCost, total };
  await fs.writeJson(file, data, { spaces: 2 });
}
