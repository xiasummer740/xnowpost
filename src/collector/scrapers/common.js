/**
 * 采集器共用逻辑：指标解析
 *
 * 背景（P2-14）：原实现把整页 innerText 拆成 token，然后"只要是数字就对任意关键词取 Math.max"，
 * 于是 ①未登录页面也能凑出几个数字（编造指标），②视频列表里单条作品的播放量会被当成账号总播放量。
 * 这里收敛为两条硬规则：
 *   1. 先判登录态（见 login.js）：未登录/被重定向到登录页 → **直接抛错**，不返回任何猜测出来的数字；
 *   2. 解析只在"指标区"内做，且数值必须**绑定到具体字段标签**（同行配对或紧邻的纯数字行）。
 */

// 页面读取 / 登录检测 / 用户名提取都从 login.js 转出，采集器统一从 common.js 引入即可
export { detectLoginState, readPageText, readDashboard, pickAtUsername } from './login.js';

// 指标区行数上限：仪表盘汇总卡片都在顶部，列表/明细数据在后
export const METRIC_ZONE_LINES = 120;
// 汇总卡片优先区：同一指标出现多个候选时，优先取这个区域内的
const HEADER_ZONE_LINES = 45;
// 同行取值时，标签与数字之间允许的字符距离（含冒号、空格、箭头等噪声）
const TIGHT_DISTANCE = 4;
const MAX_DISTANCE = 14;
// 超过这个长度的一行基本是正文/说明文字，不参与解析
const MAX_LINE_LENGTH = 80;

// CJK 也算"词字符"，这样"关注"就不会在"关注者"里被误判为一次标签命中
const WORD_CHAR = /[A-Za-z0-9_\u4e00-\u9fff\u3040-\u30ff]/;

function applySuffix(num, suffix) {
  const s = String(suffix || '');
  if (s === 'K' || s === 'k') return num * 1000;
  if (s === 'M' || s === 'm') return num * 1000000;
  if (s === 'B' || s === 'b') return num * 1000000000;
  if (s === '万' || s === 'w' || s === 'W') return num * 10000;
  if (s === '亿') return num * 100000000;
  return num;
}

/** 从任意短文本里取第一个数字（支持 1,234 / 12.5K / 1.2万 / 3亿） */
export function parseStatNumber(str) {
  const m = String(str || '').match(/(-?[\d,]+(?:\.\d+)?)\s*([KkMmBb万wW亿]?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(applySuffix(n, m[2]));
}

/** 严格解析：整段（去掉千分位与空白后）就是一个数字 */
function parsePureNumber(str) {
  const cleaned = String(str || '').replace(/[,，\s]/g, '');
  if (!cleaned) return null;
  const m = cleaned.match(/^(-?\d+(?:\.\d+)?)([KkMmBb万wW亿]?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(applySuffix(n, m[2]));
}

function isBoundary(text, at, len) {
  const before = at > 0 ? text[at - 1] : '';
  const after = at + len < text.length ? text[at + len] : '';
  return (!before || !WORD_CHAR.test(before)) && (!after || !WORD_CHAR.test(after));
}

/** 找出一行里所有命中的标签（带词边界，重叠时保留更长的标签） */
function findLabelOccurrences(line, metrics) {
  const lc = line.toLowerCase();
  const occ = [];
  for (const [metric, labels] of Object.entries(metrics)) {
    for (const label of labels) {
      const l = String(label).toLowerCase();
      let from = 0;
      while (l) {
        const at = lc.indexOf(l, from);
        if (at === -1) break;
        if (isBoundary(lc, at, l.length)) occ.push({ metric, label, at, end: at + l.length });
        from = at + l.length;
      }
    }
  }
  occ.sort((a, b) => a.at - b.at || (b.end - b.at) - (a.end - a.at));
  const kept = [];
  for (const o of occ) {
    if (kept.some(k => o.at < k.end && o.end > k.at)) continue; // 与已保留标签重叠 → 丢弃
    kept.push(o);
  }
  return kept;
}

// 标签与数字之间如果还夹着文字（如 "Followers 增长了 12%"），说明这个数字不是该指标的取值 → 宁缺毋滥
const GAP_JUNK_RE = /[\p{L}\p{N}]/u;

function isCleanGap(gap) {
  return !GAP_JUNK_RE.test(gap);
}

/**
 * 把文本里所有"像指标的数字"找出来（带绝对位置，用于判定谁离标签更近、以及防止一个数字被两个标签抢走）
 */
const NUMBER_RE = /-?[\d,]+(?:\.\d+)?\s*[KkMmBb万wW亿]?/g;

function numberTokens(seg, base, lineKey) {
  const out = [];
  NUMBER_RE.lastIndex = 0;
  let m;
  while ((m = NUMBER_RE.exec(seg)) !== null) {
    const value = parsePureNumber(m[0]);
    if (value === null) continue;
    // 注意：正则允许后缀前有空白（"10 "），计算位置时必须剔除首尾空白，否则距离会算错
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    const start = base + m.index + lead;
    const end = base + m.index + raw.length - trail;
    out.push({ value, start, end, key: `${lineKey}:${start}` });
  }
  return out;
}

/**
 * 从页面行数组中提取指标
 *
 * 规则：
 *   - 只在前 zoneLines 行（指标区）里找，长句/正文行直接跳过；
 *   - 数值必须与标签**配对**：取同行离标签最近的数字（一个数字只归一个标签），
 *     或紧邻的"纯数字行"；距离超过阈值一律不认，宁缺毋滥；
 *   - 同一指标在整页出现多个候选值时，按"匹配置信度 + 是否在头部区"打分，
 *     同分才取较大者，并明确打印"存在多个候选值，可能不准"，不再是静默对整页取 Math.max。
 *
 * @param {{lines: string[], metrics: Record<string, string[]>, platform?: string, zoneLines?: number, log?: Function}} opts
 * @returns {Record<string, number>}
 */
export function extractMetrics({ lines = [], metrics = {}, platform = '', zoneLines = METRIC_ZONE_LINES, log = console.log } = {}) {
  const zone = lines
    .slice(0, zoneLines)
    .map(l => String(l).replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const candidates = new Map(); // metric -> [{value, score, idx}]
  const add = (metric, value, confidence, idx) => {
    if (value === null || !Number.isFinite(value)) return;
    const score = confidence * 10 + (idx < HEADER_ZONE_LINES ? 5 : 0);
    if (!candidates.has(metric)) candidates.set(metric, []);
    candidates.get(metric).push({ value, score, idx });
  };

  const usedNumbers = new Set(); // 已被占用的数字 token
  const labelOnly = [];          // 同行没有可用数字的标签 → 值可能在邻行
  const perLine = [];            // [{idx, occ, cands}] 先收集全页，再统一分配
  let beforeVotes = 0;           // "值在标签前"的票数（如 "1,234 posts"）
  let afterVotes = 0;            // "值在标签后"的票数（如 "Followers 12.5K"）

  for (let i = 0; i < zone.length; i++) {
    const line = zone[i];
    if (line.length > MAX_LINE_LENGTH) continue;
    const occ = findLabelOccurrences(line, metrics);
    if (!occ.length) continue;

    // 收集"标签 ↔ 最近的数字"候选对
    const lineCands = [];
    for (let k = 0; k < occ.length; k++) {
      const beforeStart = k > 0 ? occ[k - 1].end : 0;
      const beforeText = line.slice(beforeStart, occ[k].at);
      const afterText = line.slice(occ[k].end, k + 1 < occ.length ? occ[k + 1].at : line.length);
      const beforeNums = numberTokens(beforeText, beforeStart, i);
      const afterNums = numberTokens(afterText, occ[k].end, i);
      const nearestBefore = beforeNums.length ? beforeNums[beforeNums.length - 1] : null;
      const nearestAfter = afterNums.length ? afterNums[0] : null;
      // 两侧都有数字 → 归属有歧义；只有一侧有数字的一对最可信，优先分配并投票决定布局方向
      const ambiguous = nearestBefore !== null && nearestAfter !== null;
      const push = (t, side) => {
        lineCands.push({ metric: occ[k].metric, value: t.value, key: t.key, dist: (side === 0 ? occ[k].at - t.end : t.start - occ[k].end), ambiguous, idx: i, side });
      };
      if (nearestBefore && isCleanGap(line.slice(nearestBefore.end, occ[k].at))) push(nearestBefore, 0);
      if (nearestAfter && isCleanGap(line.slice(occ[k].end, nearestAfter.start))) push(nearestAfter, 1);
    }

    // 无论有没有同行数值都要留下记录：没有数值的标签要去邻行找
    perLine.push({ idx: i, occ, cands: lineCands });
    for (const c of lineCands) {
      if (c.ambiguous || c.dist > MAX_DISTANCE) continue;
      if (c.side === 0) beforeVotes++;
      else afterVotes++;
    }
  }

  // 全页布局方向：没有票时默认"值在标签后"（仪表盘最常见的写法）
  const preferAfter = afterVotes >= beforeVotes;

  for (const { idx: i, occ, cands } of perLine) {
    cands.sort((a, b) =>
      a.dist - b.dist ||
      Number(a.ambiguous) - Number(b.ambiguous) ||
      (a.side === b.side ? 0 : (a.side === (preferAfter ? 1 : 0) ? -1 : 1))
    );

    const doneMetrics = new Set();
    for (const c of cands) {
      if (doneMetrics.has(c.metric) || c.dist > MAX_DISTANCE) continue;
      if (usedNumbers.has(c.key)) continue;
      doneMetrics.add(c.metric);
      usedNumbers.add(c.key);
      add(c.metric, c.value, c.dist <= TIGHT_DISTANCE ? 3 : 2, i);
    }

    for (const o of occ) {
      if (!doneMetrics.has(o.metric)) labelOnly.push({ idx: i, metric: o.metric });
    }
  }

  // 第二遍：标签行 + 紧邻的"纯数字行"（覆盖 num-first / label-first 两种跨行布局）
  const usedLines = new Set();
  for (const { idx: j, metric } of labelOnly) {
    for (const k of [j - 1, j + 1]) {
      if (k < 0 || k >= zone.length) continue;
      if (usedLines.has(k)) continue;
      const v = parsePureNumber(zone[k]);
      if (v === null) continue;
      usedLines.add(k);
      add(metric, v, 2, Math.min(j, k));
      break;
    }
  }

  const stats = {};
  const ambiguous = [];
  for (const [metric, list] of candidates) {
    list.sort((a, b) => b.score - a.score || b.value - a.value);
    const best = list[0];
    const sameScore = list.filter(c => c.score === best.score);
    const distinct = [...new Set(sameScore.map(c => c.value))].sort((a, b) => b - a);
    if (distinct.length > 1) ambiguous.push(`${metric}=${distinct.slice(0, 4).join('/')}`);
    stats[metric] = best.value;
  }

  if (ambiguous.length) {
    log(`  ⚠️ ${platform} 以下指标在同一页出现多个候选值（已取较大者，可能不准）: ${ambiguous.join(', ')}`);
  }

  return stats;
}
