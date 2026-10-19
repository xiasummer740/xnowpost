/**
 * page-act —— 发布器的「手」
 *
 * 一条铁律（这个项目已经踩过三次）：
 *   TikTok 一个按钮有 5~7 层嵌套副本（外层容器 → <button> → 若干 text div），
 *   桌面/移动/隐藏副本同时存在。所以：
 *     ❌ 按面积最大挑 → 点到外层容器空白处，什么都没发生
 *     ❌ 按 DOM 顺序取最后一个 → 可能是移出视口的隐藏副本，点空
 *     ✅ 要求「中心点在视口内」+「elementFromPoint 命中它自己/子/父」→ 取最内层
 *   然后**用真实鼠标坐标点**（page.mouse.click）——元素级 click() 对 TUXModal 的
 *   DIV 按钮经常"不报错也不生效"。
 *
 * 并且每次点击都带一个「预期变化」，点完自己确认：
 *   await clickLabel(page, ['Turn on'], { verified: async () => !(await snapshot(page)).overlays.length })
 * 这样日志里是「点了 + 生效了」，而不是「点了（不知道有没有用）」。
 */

/** 页面内：找一个可点的目标（返回最内层、可命中的那个） */
const FIND_TARGET = ({ labels, avoid }) => {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const wants = labels.map((l) => norm(l).toLowerCase()).filter(Boolean);
  const danger = (avoid || []).map((d) => norm(d).toLowerCase()).filter(Boolean);
  if (!wants.length) return null;

  const inViewport = (r) => r.width > 6 && r.height > 6
    && r.x >= -2 && r.y >= -2
    && r.x + r.width <= window.innerWidth + 2
    && r.y + r.height <= window.innerHeight + 2;

  const hitSelf = (el, r) => {
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (!hit) return false;
    return hit === el || el.contains(hit) || hit.contains(el);
  };

  const cands = Array.from(document.querySelectorAll('button,[role="button"],a,div[class*="Button"],span[class*="Button"],label,div[class*="btn"]'));
  let best = null;
  for (const el of cands) {
    const txt = norm(el.innerText).toLowerCase();
    if (!txt || txt.length > 40) continue;
    if (!wants.some((w) => txt === w || txt.includes(w))) continue;
    // 危险词一票否决：绝不能把「Cancel post」当成「Cancel」点掉（2026-10-18 21:22 翻车过）
    if (danger.some((d) => txt.includes(d))) continue;
    const r = el.getBoundingClientRect();
    if (!inViewport(r)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;
    if (!hitSelf(el, r)) continue;
    // 取最内层（面积最小）—— 最贴近文字本身的才是真正的可点区域
    const area = r.width * r.height;
    if (!best || area < best.area) best = { area, r, text: norm(el.innerText).slice(0, 30), tag: (el.tagName || '').toLowerCase() };
  }
  if (!best) return null;
  return {
    label: best.text,
    tag: best.tag,
    rect: { x: Math.round(best.r.x), y: Math.round(best.r.y), w: Math.round(best.r.width), h: Math.round(best.r.height) },
    cx: Math.round(best.r.x + best.r.width / 2),
    cy: Math.round(best.r.y + best.r.height / 2),
  };
};

/**
 * 用真实鼠标点一个按钮，并（可选）确认预期变化真的发生了。
 * @param {string[]} labels 允许的按钮文字（大小写不敏感，包含即可）
 * @param {object} opts
 * @param {Function} [opts.verified] 返回 true 表示"变化已发生"；给了就会轮询 150ms × 8 次
 * @param {Function} [opts.log]
 * @returns {Promise<{clicked:boolean, label?:string, verified?:boolean, why?:string}>}
 */
export async function clickLabel(page, labels, { verified = null, timeoutMs = 1500, log = () => {}, avoid = [] } = {}) {
  const target = await page.evaluate(FIND_TARGET, { labels, avoid }).catch(() => null);
  if (!target) return { clicked: false, why: `页面上找不到可点的「${labels.join('/')}」` };

  await page.mouse.click(target.cx, target.cy);

  if (!verified) {
    log(`  🖱️ 点了「${target.label}」(${target.cx},${target.cy})`);
    return { clicked: true, label: target.label };
  }

  const deadline = Date.now() + timeoutMs;
  let ok = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      if (await verified()) { ok = true; break; }
    } catch { /* 页面正在变，继续等 */ }
  }
  log(ok
    ? `  🖱️ 点了「${target.label}」(${target.cx},${target.cy}) → 已生效`
    : `  🖱️ 点了「${target.label}」(${target.cx},${target.cy}) → 未见变化`);
  return { clicked: true, label: target.label, verified: ok, cx: target.cx, cy: target.cy };
}

export { FIND_TARGET };
