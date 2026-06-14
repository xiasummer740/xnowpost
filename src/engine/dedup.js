// 文案去重模块：防止生成重复内容
import fs from 'fs-extra';
import path from 'path';

const HISTORY_FILE = path.resolve('output/history.json');
const MAX_RETRIES = 5;

// ============ 改进的中文相似度算法 ============

// 提取特征：2-gram + 4-gram 混合（比纯 3-gram 更准）
function extractGrams(s, minLen = 2, maxLen = 4) {
  const set = new Set();
  if (!s) return set;
  for (let len = minLen; len <= maxLen; len++) {
    for (let i = 0; i <= s.length - len; i++) {
      set.add(s.substring(i, i + len));
    }
  }
  return set;
}

// 关键词权重：数字和特殊词加权
function keywordWeight(s) {
  let weight = 0;
  // 数字出现越多 → 越独特
  const digits = (s.match(/\d+/g) || []).join('');
  weight += digits.length * 0.3;
  // 含品牌词/价格词 → 高区分度
  if (/¥|元|粉|赞|播|K|万/.test(s)) weight += 2;
  // 问句 → 有一定区分度
  if (/[？?]/.test(s)) weight += 1;
  return weight;
}

export function similarity(a, b) {
  if (!a || !b) return 0;

  // 1. n-gram 重叠率
  const ga = extractGrams(a), gb = extractGrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;

  let overlap = 0;
  for (const g of ga) { if (gb.has(g)) overlap++; }

  const gramScore = overlap / Math.max(ga.size, gb.size);

  // 2. 关键词权重加分（如果数字/价格模式相似 → 大概率重复）
  const wa = keywordWeight(a), wb = keywordWeight(b);
  const kwScore = wa > 0 && wb > 0 ? 1 - Math.abs(wa - wb) / Math.max(wa, wb) : 0;

  // 加权合并
  return gramScore * 0.7 + kwScore * 0.3;
}

// 内容级别去重：比较文案正文/分镜（比仅标题更准）
export function contentSimilarity(contentA, contentB) {
  // 取前 3 个分镜文本拼接
  const textA = [contentA.title_zh, ...(contentA.scenes || []).slice(0, 3).map(s => s.scene_text_zh)].join('');
  const textB = [contentB.title_zh, ...(contentB.scenes || []).slice(0, 3).map(s => s.scene_text_zh)].join('');
  return similarity(textA, textB);
}

// ============ 历史管理 ============

export function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return fs.readJsonSync(HISTORY_FILE);
    }
  } catch (e) { /* ignore */ }
  return { titles: [], contents: [], count: 0, lastStrategy: null };
}

export function saveTitle(title, strategy) {
  const h = loadHistory();
  h.titles.push({ title, strategy, time: new Date().toISOString() });
  // 只保留最近 200 条
  if (h.titles.length > 200) h.titles = h.titles.slice(-200);
  h.count++;
  h.lastStrategy = strategy;
  fs.ensureDirSync(path.dirname(HISTORY_FILE));
  fs.writeJsonSync(HISTORY_FILE, h, { spaces: 2 });
}

// 保存完整内容用于深度去重
export function saveContent(content, strategy) {
  const h = loadHistory();
  h.contents = h.contents || [];
  h.contents.push({
    title_zh: content.title_zh,
    scenes: (content.scenes || []).slice(0, 5).map(s => ({ scene_text_zh: s.scene_text_zh })),
    strategy,
    time: new Date().toISOString(),
  });
  if (h.contents.length > 50) h.contents = h.contents.slice(-50);
  h.lastStrategy = strategy;
  fs.ensureDirSync(path.dirname(HISTORY_FILE));
  fs.writeJsonSync(HISTORY_FILE, h, { spaces: 2 });
}

// ============ 双重去重检查 ============

export function isDuplicate(title, threshold = 0.45) {
  const h = loadHistory();
  const recent = h.titles.slice(-30);
  for (const item of recent) {
    const sim = similarity(title, item.title);
    if (sim > threshold) {
      console.log(`  🔄 标题相似度 ${(sim*100).toFixed(0)}%: "${item.title}"`);
      return true;
    }
  }
  return false;
}

// 内容级去重（更深层，用于已有完整内容时的校验）
export function isContentDuplicate(content, threshold = 0.5) {
  const h = loadHistory();
  const recent = (h.contents || []).slice(-20);
  for (const item of recent) {
    const sim = contentSimilarity(content, item);
    if (sim > threshold) {
      console.log(`  🔄 内容相似度 ${(sim*100).toFixed(0)}%`);
      return true;
    }
  }
  return false;
}

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

export function getLastStrategy() {
  const h = loadHistory();
  return h.lastStrategy;
}
