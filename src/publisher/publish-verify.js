/**
 * 「确认这条作品真的公开了」—— 按**标题定位到本条**，而不是整页找「所有人」。
 *
 * 为什么（2026-10-29 审查发现）：
 * 旧实现读 `document.body.innerText`，只要页面上出现一次 `所有人|Everyone` 且没有
 * `内容审查中` 就判成功。可这个账号本来就有历史作品，内容页首屏里老作品的行也可能带
 * 「所有人」→ 点击后 ~0 秒就"确认公开"（而且被记成 confirmed:true）。
 * 今天 9 轮实测都是 21~36 秒才确认，说明暂时没误命中，但这属于"运气好"，不是判据对。
 *
 * 新口径：
 * - 用标题里最长的一段「可识别片段」（去掉 emoji/标签/空白）当 key；
 * - 在页面里找**最内层包含这个 key 的元素**，往上爬到能看见可见性文案的那个容器，
 *   读它的 innerText；
 * - 只有**这一条**的容器里出现「所有人 / 已公开 / Everyone / Public」才算公开；
 *   出现「仅自己 / Only me」算私有；出现「审查中 / Under review」算还在审查。
 * - 找不到 key（标题被截断/被平台改写）→ 返回 'not-found'，调用方继续等，
 *   最后仍找不到就如实报「未确认」，绝不用整页信息凑成功。
 *
 * 纯逻辑（不含 DOM），单测在 tests/unit/publish-verify.test.js。
 */

/** 可见性文案 → 状态 */
const PUBLIC_RE = /所有人|公开|Everyone|Public\b/i;
const PRIVATE_RE = /仅自己|Only me|Private\b/i;
const REVIEW_RE = /内容审查中|正在审查|审查中|Under review|Checking|In review/i;

/**
 * 从标题里抽出用来定位的 key：去掉标签、emoji、标点与空白，取最长的一段。
 * 中文 4 个字就够唯一（"安全上网"），英文按整词走；少于 4 字容易撞，直接不用于定位。
 * @returns {string} 空串表示这个标题没法用来定位
 */
export function titleKey(title, { minLen = 4, maxLen = 20 } = {}) {
  const raw = String(title || '')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')        // #标签整段丢掉（标签不是本作品独有）
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')  // emoji
    .replace(/[^\p{L}\p{N}]+/gu, ' ')          // 标点/空白
    .trim();
  if (!raw) return '';

  // 中文按「连续汉字串」切（中文没有空格，按空格切会把一句话切得七零八落）
  const cjk = raw.match(/[\p{Script=Han}]{2,}/gu) || [];
  // 英文/数字按词切
  const latin = raw.match(/[A-Za-z0-9][A-Za-z0-9'-]{2,}/g) || [];
  const longestOf = (arr) => arr.reduce((a, b) => (b.length > a.length ? b : a), '');

  const headCjk = cjk[0] || '';                 // 开头那段最有辨识度
  if (headCjk.length >= minLen) return headCjk.slice(0, maxLen);
  const bestCjk = longestOf(cjk);
  if (bestCjk.length >= minLen) return bestCjk.slice(0, maxLen);
  const bestLatin = longestOf(latin);
  if (bestLatin.length >= minLen) return bestLatin.slice(0, maxLen);
  // 都太短：宁可不定位，也不要用 2~3 个字去撞（撞上了会把老作品判成"本条已公开"）
  return '';
}

/** 一行/一块文本 → 可见性状态；看不出就 null */
export function visibilityOf(text) {
  const t = String(text || '');
  if (!t) return null;
  if (REVIEW_RE.test(t)) return 'reviewing';
  if (PRIVATE_RE.test(t)) return 'private';
  if (PUBLIC_RE.test(t)) return 'public';
  return null;
}

/**
 * 从"候选块"里挑出属于本条作品的那一块文本。
 * @param {string[]} blocks 页面上候选容器的 innerText（已按出现顺序）
 * @param {string} key titleKey() 的结果
 * @returns {{found:boolean, text:string, index:number, state:string|null}}
 */
export function pickOwnBlock(blocks, key) {
  const list = Array.isArray(blocks) ? blocks : [];
  if (!key) return { found: false, text: '', index: -1, state: null };
  let best = { found: false, text: '', index: -1, state: null };
  for (let i = 0; i < list.length; i++) {
    const text = String(list[i] || '');
    if (!text.includes(key)) continue;
    const state = visibilityOf(text);
    // 命中 title key 就算找到了；如果这一块还带可见性文案，直接就是它
    if (!best.found) best = { found: true, text, index: i, state };
    if (state) return { found: true, text, index: i, state };
  }
  return best;
}

/**
 * 一次轮询的判定：调用方把 pickOwnBlock 的结果交进来。
 * @returns {'public'|'private'|'reviewing'|'not-found'|'unknown'}
 */
export function verdictOf(pick, { requireOwn = true } = {}) {
  if (!pick || !pick.found) return requireOwn ? 'not-found' : 'unknown';
  return pick.state || 'unknown';
}

/**
 * 内容页里"候选块"的采集脚本（在页面里跑）。
 * 从包含 key 的最内层元素往上爬，找到第一个 innerText 明显更长、且带可见性文案的祖先。
 * 采集多个 key 的候选块（一页可能有多条），Node 侧再用 pickOwnBlock 挑。
 */
/**
 * 内容页里"候选块"的采集函数（在浏览器里跑，由 page.evaluate(fn, key) 调用）。
 * 从包含 key 的最内层元素往上爬，找到第一个带可见性文案的祖先，把它的 innerText 交回来。
 * ⚠️ 必须写成真函数（不是字符串）：foxpw 的 evaluate 用 `(${fn})(${JSON.stringify(arg)})`
 * 拼源码，字符串形式的参数不会被序列化进去。
 */
export function collectBlocksFn(key) {
  const out = [];
  if (!key) return out;
  const STATE_RE = /所有人|公开|Everyone|Public\b|仅自己|Only me|Private\b|审查中|Under review|Checking|In review/i;
  const hits = [];
  for (const el of document.querySelectorAll('div,li,tr,article,section')) {
    if (el.children && el.children.length > 60) continue;   // 跳过超大容器（整页/整表）
    // 先用 textContent 粗筛：innerText 会触发排版计算，对几千个元素逐个读会明显拖慢轮询
    const tc = el.textContent || '';
    if (!tc || tc.length > 4000) continue;
    if (!tc.includes(key)) continue;
    hits.push(el);
  }
  const seen = new Set();
  for (const el of hits) {
    let node = el;
    let depth = 0;
    while (node && depth < 6) {
      const text = node.innerText || '';   // 到这里只剩少量命中元素，读 innerText 才划算
      if (STATE_RE.test(text) && text.length < 4000) {
        if (!seen.has(text)) { seen.add(text); out.push(text); }
        break;
      }
      node = node.parentElement;
      depth += 1;
    }
  }
  return out.slice(0, 20);
}
