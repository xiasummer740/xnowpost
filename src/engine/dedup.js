// 文案去重模块：防止生成重复内容
import fs from 'fs-extra';
import path from 'path';

const HISTORY_FILE = path.resolve('output/history.json');
const MAX_RETRIES = 5; // 最多重试5次换策略

// 简单的相似度计算（中文标题）
function similarity(a, b) {
  if (!a || !b) return 0;
  // 提取关键词（2-4字片段）
  const grams = (s) => {
    const g = new Set();
    for (let i = 0; i < s.length - 1; i++) {
      g.add(s.substring(i, Math.min(i + 3, s.length)));
    }
    return g;
  };
  const ga = grams(a), gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let overlap = 0;
  for (const g of ga) { if (gb.has(g)) overlap++; }
  return overlap / Math.max(ga.size, gb.size);
}

// 加载历史标题
export function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return fs.readJsonSync(HISTORY_FILE);
    }
  } catch (e) { /* ignore */ }
  return { titles: [], count: 0, lastStrategy: null };
}

// 保存标题
export function saveTitle(title, strategy) {
  const h = loadHistory();
  h.titles.push({ title, strategy, time: new Date().toISOString() });
  // 只保留最近200条
  if (h.titles.length > 200) h.titles = h.titles.slice(-200);
  h.count++;
  h.lastStrategy = strategy;
  fs.ensureDirSync(path.dirname(HISTORY_FILE));
  fs.writeJsonSync(HISTORY_FILE, h, { spaces: 2 });
}

// 检查标题是否与历史重复
export function isDuplicate(title, threshold = 0.5) {
  const h = loadHistory();
  const recent = h.titles.slice(-30); // 只检查最近30条
  for (const item of recent) {
    if (similarity(title, item.title) > threshold) {
      console.log(`  🔄 标题与历史相似(${(similarity(title, item.title)*100).toFixed(0)}%): "${item.title}"`);
      return true;
    }
  }
  return false;
}

// 带重试的生成器
export async function generateUnique(generatorFn, titleKey = 'title_zh') {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const result = await generatorFn();
    const title = result[titleKey] || result.content?.[titleKey];
    if (title && isDuplicate(title)) {
      if (attempt < MAX_RETRIES - 1) {
        console.log(`  🔄 换个角度重新生成...（第${attempt+1}次重试）`);
        continue;
      }
      console.log(`  ⚠️ 已重试${MAX_RETRIES}次，使用当前结果`);
    }
    return result;
  }
}

// 获取最后一次使用的策略（避免连续用同一策略）
export function getLastStrategy() {
  const h = loadHistory();
  return h.lastStrategy;
}
