/**
 * page-sense —— 发布器的「眼睛」
 *
 * 为什么要有这个文件：
 *   原来的发布流程是「盲操作 + 固定等待」：点一下 → sleep 2 秒 → 再看一眼。
 *   结果是弹窗挂 30 秒没人管、按钮禁用了还在点、页面在滚来滚去（用户原话「屏幕一直在晃」）。
 *   真人是怎么做的？眼睛一直盯着页面，只要出现变化立刻反应：
 *     弹窗出现 → 0.3 秒内点掉；按钮从灰变亮 → 立刻点；上传卡在 99% → 继续等。
 *
 * 用法（Node 侧）：
 *   const sense = await startSensing(page, { logFile });   // 后台记录全部变化
 *   const st = await snapshot(page);                        // 决策用的结构化状态
 *   ...
 *   sense.stop();                                           // 发布结束停掉
 *
 * 设计要点：
 *   1. 变化收集在**页面内**做（MutationObserver + 捕获阶段 click 监听），
 *      Node 侧每 300ms 只取一小段增量 —— 不刷 DOM、不打扰页面。
 *   2. 只记"看得见的"变化：浮层出现/消失、按钮可用性、上传进度、文案计数、
 *      滚动、点击坐标。原始 mutation 有几千条，全记等于没记。
 *   3. snapshot 用**已验证的选择器**（发布流程实测过的），字段名固定，
 *      以后任何决策都基于它，别再各写一套 evaluate。
 */

/** 页面内：安装观察器（幂等） */
const SENSE_INIT = () => {
  if (window.__sense) return 'already';
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const log = [];
  const MAX = 3000;
  const push = (e) => { if (log.length < MAX) log.push(e); };
  const now = () => Math.round(performance.now());

  const buttonsOf = (el) => Array.from(el.querySelectorAll('button,[role="button"],div[class*="Button"] span'))
    .filter((b) => b.offsetWidth > 10 && b.offsetHeight > 8)
    .map((b) => norm(b.innerText).slice(0, 24))
    .filter(Boolean)
    .slice(0, 8);

  const describe = (el) => {
    const tag = (el.tagName || '').toLowerCase();
    const cls = norm(el.className).split(' ')[0] || '';
    return `${tag}${cls ? '.' + cls : ''}`;
  };

  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity || 1) > 0.05;
  };

  const floating = (el) => {
    let n = el;
    for (let i = 0; i < 6 && n; i++) {
      if (getComputedStyle(n).position === 'fixed') return true;
      n = n.parentElement;
    }
    return false;
  };

  // ---- 1) 浮层出现/消失：这是发布流程里最关键的一类变化 ----
  const isOverlayLike = (el) => {
    const cls = String(el.className || '') + ' ' + (el.getAttribute?.('role') || '');
    if (/dialog|modal|overlay|toast|banner|popup/i.test(cls)) return true;
    return floating(el);
  };

  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1 || !visible(n)) continue;
          const txt = norm(n.innerText).slice(0, 140);
          if (!txt || txt.length < 4) continue;
          if (!isOverlayLike(n)) continue;
          push({ t: now(), k: 'overlay+', d: `${describe(n)}「${txt}」btn=[${buttonsOf(n).join('|')}]` });
        }
        for (const n of m.removedNodes) {
          if (n.nodeType !== 1) continue;
          const txt = norm(n.innerText).slice(0, 140);
          if (!txt || txt.length < 4) continue;
          if (!isOverlayLike(n)) continue;
          push({ t: now(), k: 'overlay-', d: `${describe(n)}「${txt}」` });
        }
      } else if (m.type === 'attributes') {
        const el = m.target;
        const name = m.attributeName || '';
        if (!/^(aria-checked|aria-disabled|disabled|data-disabled|class|aria-valuenow|placeholder)$/.test(name)) continue;
        if (!visible(el)) continue;
        const val = el.getAttribute?.(name);
        // 只关心按钮/开关/上传进度这几个元素
        const tag = (el.tagName || '').toLowerCase();
        const interesting = /button|switch|input|progress/.test(tag + ' ' + String(el.className || ''));
        if (!interesting) continue;
        push({ t: now(), k: `attr:${name}`, d: `${describe(tag === 'input' ? el : el)}「${norm(el.innerText).slice(0, 40)}」=${val}` });
      } else if (m.type === 'characterData') {
        // 上传进度 / 文案计数这类文本是原地改的
        const p = m.target.parentElement;
        if (!p || !visible(p)) continue;
        const txt = norm(p.innerText).slice(0, 60);
        if (!txt) continue;
        if (!/(上|%|characters|\/4000|Checking|check)/i.test(txt)) continue;
        push({ t: now(), k: 'text', d: txt });
      }
    }
  });
  mo.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, characterData: true,
    attributeFilter: ['aria-checked', 'aria-disabled', 'disabled', 'data-disabled', 'class', 'aria-valuenow', 'placeholder'],
  });

  // ---- 2) 点击：记录"人点的哪一下、点到什么"，对照时间轴就能看出动作是否命中 ----
  window.addEventListener('click', (e) => {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    const r = el.getBoundingClientRect?.() || { x: 0, y: 0, width: 0, height: 0 };
    push({
      t: now(), k: 'click',
      d: `${describe(el)}「${norm(el.innerText || el.value || el.getAttribute?.('aria-label') || '').slice(0, 40)}」x=${Math.round(r.x + r.width / 2)},y=${Math.round(r.y + r.height / 2)}`,
    });
  }, true);

  // ---- 3) 滚动：用户抱怨"屏幕一直在晃"，把谁在滚、滚了多少记下来 ----
  let lastY = window.scrollY;
  window.addEventListener('scroll', () => {
    const y = Math.round(window.scrollY);
    if (Math.abs(y - lastY) < 8) return;
    push({ t: now(), k: 'scroll', d: `${lastY} → ${y}` });
    lastY = y;
  }, true);

  window.__sense = { log, installedAt: Date.now() };
  return 'installed';
};

/** 页面内：取走增量（取完清空，避免重复） */
const SENSE_DRAIN = () => {
  if (!window.__sense) return { ok: false, events: [] };
  const events = window.__sense.log.splice(0, window.__sense.log.length);
  return { ok: true, events };
};

/** 页面内：结构化快照（决策依据；选择器都是发布流程实测过的） */
const SENSE_SNAPSHOT = () => {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  };

  // 浮层（只看 fixed 或 role=dialog 的大块）
  const SEL = 'div[role="dialog"],[role="dialog"],[role="alertdialog"],div[class*="Modal"],div[class*="modal"],div[class*="Overlay"],div[class*="overlay"]';
  const isFloatingEl = (el) => {
    let n = el;
    for (let i = 0; i < 6 && n; i++) {
      if (getComputedStyle(n).position === 'fixed') return true;
      n = n.parentElement;
    }
    return false;
  };
  let overlays = Array.from(document.querySelectorAll(SEL)).filter((el) => {
    const r = el.getBoundingClientRect();
    if (!visible(el) || r.width * r.height <= 20000) return false;
    // ⚠️ 必须真浮起来：上传表单里的「Labeling AI-generated content」说明区块
    //    class 里也带 Modal/字段名，只看 class 会把它当弹窗 → 反应器每 500ms
    //    报一次"AI 标注引导出现"却找不到按钮（2026-10-18 23:10 演练实测）。
    if (el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') return true;
    return isFloatingEl(el);
  });
  overlays = overlays.filter((el) => !overlays.some((o) => o !== el && el.contains(o)));
  const overlayInfo = overlays.map((ov) => ({
    text: norm(ov.innerText).slice(0, 160),
    rect: rectOf(ov),
    buttons: Array.from(ov.querySelectorAll('button,[role="button"],div[class*="Button"] span'))
      .filter(visible)
      .map((b) => ({ label: norm(b.innerText).slice(0, 24), rect: rectOf(b), disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true' }))
      .filter((b) => b.label),
  }));

  // 主按钮状态
  const post = document.querySelector('[data-e2e="post_video_button"]');
  const postRect = rectOf(post);
  const hit = (() => {
    if (!postRect) return null;
    const el = document.elementFromPoint(postRect.cx, postRect.cy);
    if (!el) return 'none';
    if (el === post || post?.contains(el)) return 'self';
    return `${(el.tagName || '').toLowerCase()}.${norm(el.className).split(' ')[0] || ''}「${norm(el.innerText).slice(0, 30)}」`;
  })();

  // 上传进度
  const bodyText = document.body.innerText || '';
  const pctMatch = bodyText.match(/(\d{1,3})\s*%/);
  const uploading = /uploading|上传中/i.test(bodyText);
  const processing = /processing|处理中|正在处理/i.test(bodyText);

  // AI 开关
  const aiSwitch = document.querySelector('[data-e2e="aigc_container"] .Switch__content');
  const aiAria = aiSwitch ? aiSwitch.getAttribute('aria-checked') : 'no-element';

  // 文案计数
  const countMatch = bodyText.match(/(\d+)\s*\/\s*4000/);
  const captionInput = document.querySelector('[data-e2e="caption-input"]');

  // 检查项
  const checking = /Checking in progress|检查进行中|about 10 minutes/i.test(bodyText);
  const noIssues = /No issues found|未发现问题/i.test(bodyText);

  return {
    url: location.href,
    readyState: document.readyState,
    viewport: { w: window.innerWidth, h: window.innerHeight, scrollY: Math.round(window.scrollY) },
    overlays: overlayInfo,
    post: {
      exists: !!post,
      rect: postRect,
      disabled: !!post?.disabled || post?.getAttribute('aria-disabled') === 'true' || post?.getAttribute('data-disabled') === 'true',
      visible: visible(post),
      hitTest: hit,
    },
    upload: { uploading, processing, pct: pctMatch ? Number(pctMatch[1]) : null },
    ai: { aria: aiAria, value: aiSwitch ? aiSwitch.getAttribute('value') : null },
    caption: {
      exists: !!captionInput,
      length: captionInput ? (captionInput.innerText || captionInput.value || '').length : 0,
      countText: countMatch ? Number(countMatch[1]) : null,
    },
    checks: { checking, noIssues },
    at: Date.now(),
  };
};

const LABEL = {
  'overlay+': '浮层出现',
  'overlay-': '浮层消失',
  click: '点击',
  scroll: '滚动',
  text: '文本变化',
};

/**
 * 启动后台观察：每 intervalMs 把页面内累积的变化写到 logFile。
 * 返回 { stop, stats }，stop() 会再取一次增量后返回总行数。
 */
export async function startSensing(page, { logFile, shotDir, intervalMs = 300, log = () => {} } = {}) {
  // ⚠️ 别用 `await import('fs-extra')` 再取具名方法：它是 CommonJS，Node 的 ESM 具名导出探测不到
  //    appendFile/writeFile，拿到 undefined 后异常又被 try 吞掉 → 日志永远是空的（2026-10-18 踩过）。

  /** 拍一张 —— "眼睛"看到关键变化的凭据（弹窗出现 / 发布前后） */
  const shot = async (tag) => {
    if (!shotDir || typeof page.screenshot !== 'function') return null;
    shots += 1;
    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    const safeTag = String(tag).replace(/[^\w.-]/g, '_');
    const name = `eye-${stamp}-${String(shots).padStart(2, '0')}-${safeTag}.png`;
    const file = shotDir + '/' + name;
    try {
      await page.screenshot({ path: file });
      log(`  📷 截图(${tag}): ${name}`);
      return file;
    } catch { return null; }
  };
  // ⚠️ 别用 wait import('fs-extra') 再取具名方法：它是 CommonJS，Node 的 ESM 具名导出探测不到
  //    appendFile/writeFile，拿到 undefined 后异常又被 try 吞掉 → 日志永远是空的（2026-10-18 踩过）。
  const fsp = await import('node:fs/promises');
  let running = true;
  let timer = null;
  let total = 0;
  let shots = 0;
  let reinstalls = 0;
  const t0 = Date.now();

  try {
    await page.evaluate(SENSE_INIT);
  } catch (err) {
    log(`  ⚠️ 页面观察器安装失败（不影响发布）: ${(err.message || '').split('\n')[0]}`);
    return { stop: () => 0, stats: { total: 0 } };
  }
  if (logFile) {
    try { await fsp.writeFile(logFile, `# 页面事件流（真实时间 | 页面内相对秒 | 类型 | 细节）\n`, 'utf-8'); } catch { /* 目录只读 */ }
  }

  const tick = async () => {
    if (!running) return;
    try {
      let res = await page.evaluate(SENSE_DRAIN);
      // 页面导航（打开上传页、跳内容页）会把 window.__sense 冲掉 —— 必须重装，
      // 否则后面全程 0 条事件（2026-10-18 23:1x 演练实测踩到）
      if (!res || res.ok === false) {
        await page.evaluate(SENSE_INIT);
        reinstalls += 1;
        log(`  👁️ 页面观察器已(重)安装（第 ${reinstalls} 次执行；页面导航后属正常）`);
        res = await page.evaluate(SENSE_DRAIN);
      }
      const events = (res && res.events) || [];
      if (events.length) {
        const lines = events.map((e) => {
          const wall = new Date().toISOString().slice(11, 23);
          const kind = LABEL[e.k] || e.k;
          return `${wall} | +${String((e.t / 1000).toFixed(1)).padStart(6)}s | ${kind} | ${e.d}`;
        });
        total += events.length;
        if (logFile) { try { await fsp.appendFile(logFile, lines.join('\n') + '\n'); } catch { /* 忽略 */ } }
        // 只把"浮层/点击/滚动"这几类提示到控制台，attr/text 太吵
        for (const e of events) {
          if (e.k === 'overlay+' || e.k === 'overlay-' || e.k === 'scroll') log(`  👁️ ${LABEL[e.k] || e.k}: ${String(e.d).slice(0, 100)}`);
        }
      }
    } catch { /* 页面正在导航时会失败，下一轮继续 */ }
    if (running) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);

  return {
    stop: async () => {
      running = false;
      if (timer) clearTimeout(timer);
      try {
        const res = await page.evaluate(SENSE_DRAIN);
        const events = (res && res.events) || [];
        if (events.length && logFile) {
          const lines = events.map((e) => `${new Date().toISOString().slice(11, 23)} | +${(e.t / 1000).toFixed(1)}s | ${LABEL[e.k] || e.k} | ${e.d}`);
          await fsp.appendFile(logFile, lines.join('\n') + '\n');
          total += events.length;
        }
      } catch { /* 忽略 */ }
      if (logFile) {
        try { await fsp.appendFile(logFile, `# 结束：${total} 条事件，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`); } catch { /* 忽略 */ }
      }
      return total;
    },
    stats: () => ({ total, shots }),
    shot,
  };
}

/** 读一次结构化状态（决策用） */
export async function snapshot(page) {
  try {
    return await page.evaluate(SENSE_SNAPSHOT);
  } catch (err) {
    return { error: (err.message || '').split('\n')[0] };
  }
}

/**
 * 浮层反应策略：**只处理这几种**，其它一律不动（只记录）。
 * 真人操作时也是"认识这个框才点"，不认识就停手看看。
 */
const OVERLAY_POLICY = [
  {
    id: 'checks',
    name: '自动内容检查',
    test: (t) => /turn on automatic content checks|automatic content checks/i.test(t),
    click: ['Turn on', '开启', '打开'],
    danger: ['Cancel post', 'Discard'],
  },
  {
    id: 'aigc',
    name: 'AI 标注引导',
    test: (t) => /label.*ai-generated|ai-generated content/i.test(t),
    click: ['Turn on', '开启'],
    danger: ['Not now', 'Discard'],
  },
  {
    id: 'discard',
    name: '放弃作品确认',
    test: (t) => /discard this post|will be discarded|are you sure you want to exit|changes will not be saved/i.test(t),
    click: ['Not now', 'Cancel', 'Stay', '继续编辑', '留在此页'],
    danger: ['Discard', 'Exit', 'Leave'],
  },
  {
    // 2026-10-19 22:17 实测：检查超时放行后点 Post，TikTok 会问「Continue to post?」。
    // 反应器认得它才不会打成「未知浮层（不点，只记录）」；正确动作是 Post now。
    // 必须排在「通用确认」前面：这框里要是也带了 OK/Got it 之类按钮，
    // 先命中 confirm 就会点错（它点的 Cancel 等于取消发布）。
    id: 'checksPending',
    name: '检查未完成确认框',
    test: (t) => /still checking your video|continue to post\?|want to continue posting/i.test(t),
    click: ['Post now', '仍然发布', '继续发布'],
    danger: ['Cancel', 'Discard'],
  },
  {
    id: 'confirm',
    name: '通用确认',
    test: (t) => /\b(got it|ok)\b/i.test(t),
    click: ['Got it', 'OK', '好的', '知道了'],
    danger: ['Discard', 'Cancel post'],
  },
];

/**
 * 只认按钮也能认出「放弃作品确认」。
 *
 * 2026-10-19 09:05 实测（当天 10 轮里 3 轮）：TUXModal 的**标题块偶尔不进浮层集合**，
 * 只剩「Not now / Discard」按钮块；同时屏上还挂着「Preview your video on your phone → Got it」，
 * 拼起来的整页文本里只有 "got it" → 被判成「通用确认」→ 对着被遮罩挡住的位置
 * **盲点 4 次、白等 28 秒**，最后靠 dialogs 层的"未知弹窗"兜底才关掉。
 *
 * 所以加一层**按钮签名兜底**：同一屏里同时出现「取消类」+「Discard」，就先按
 * 放弃作品确认处理（点 Not now），不看标题文字。
 * 「Turn on automatic content checks?」是 Cancel + Turn on，没有 Discard，不会误入。
 */
const CANCELISH_LABELS = ['not now', '以后再说', 'cancel', '取消', 'stay', '继续编辑', '留在此页'];
const DESTRUCTIVE_LABELS = ['discard', '放弃'];

function labelsOf(buttons) {
  return (buttons || []).map((b) => String((b && b.label) || '').toLowerCase().trim()).filter(Boolean);
}

/** 纯函数，方便单测：从浮层集合的按钮组合推断策略（认不出返回 null） */
export function policyFromButtons(overlays) {
  const hit = (labels, words) => labels.some((l) => words.some((w) => l === w || l.includes(w)));
  for (const ov of overlays || []) {
    const labels = labelsOf(ov && ov.buttons);
    if (hit(labels, CANCELISH_LABELS) && hit(labels, DESTRUCTIVE_LABELS)) {
      return OVERLAY_POLICY.find((p) => p.id === 'discard') || null;
    }
  }
  return null;
}

/**
 * 「同一个框」的签名：策略 + 按钮文字。
 * 计数必须按签名而不是按策略名 —— 否则一次误判（比如「通用确认」点废 4 次）就把
 * 整轮里所有同策略浮层一起封死，后面真正该点的框再也不点了。
 */
export function overlaySignature(policy, buttons) {
  const labels = labelsOf(buttons).sort().join(',');
  return `${(policy && policy.id) || 'unknown'}|${labels}`.slice(0, 140);
}

/**
 * 常驻反应器：每 500ms 看一眼有没有浮层，有就按策略**立刻**点掉并复验。
 * 这是"像真人一样"的核心：不再靠固定 sleep，弹窗出现 0.3~0.8 秒内就消失。
 */
export async function startOverlayReactor(page, { log = () => {}, intervalMs = 500, shot = null } = {}) {
  const { clickLabel } = await import('./page-act.js');
  let running = true;
  let paused = false; // 暂停：主流程要「自己动手」处理某个框时先挂起，避免它抢着按策略点掉
  let timer = null;
  const handled = new Map(); // 浮层签名 → 已尝试次数（防"疯狂点击"）
  const history = [];
  let ticks = 0;

  const known = (text) => OVERLAY_POLICY.find((p) => p.test(text)) || null;

  const tick = async () => {
    if (!running) return;
    if (paused) { timer = setTimeout(tick, intervalMs); return; }
    ticks += 1;
    try {
      const st = await page.evaluate(SENSE_SNAPSHOT);
      let overlays = (st && st.overlays) || [];

      // 同一个弹窗在 DOM 里会被拆成好几块（标题块、按钮块各自命中「Modal」选择器），
      // 逐块判断策略会漏（「Not now / Discard」那一块自己没有标题文字）。
      // 所以：把整页所有浮层文字拼起来做策略判定，按钮也合并，只按策略点**一次**。
      const allText = overlays.map((o) => o.text).join('  ||  ');
      const sumButtons = overlays.flatMap((o) => o.buttons || []);
      // 只关心"有按钮的框"或"能认出是哪种框"的，避免把视频选择器之类的容器当弹窗
      overlays = overlays.filter((o) => (o.buttons && o.buttons.length) || known(o.text));
      if (!overlays.length) { if (running) timer = setTimeout(tick, intervalMs); return; }

      // 先按按钮组合判（标题块没识别到也能认出「放弃作品确认」），再退回整页文本
      const policy = policyFromButtons(overlays) || known(allText);
      if (!policy) {
        const key = 'unknown|' + allText.slice(0, 80);
        if (!handled.has(key)) {
          handled.set(key, 1);
          history.push({ t: Date.now(), kind: 'unknown', text: allText.slice(0, 120), buttons: sumButtons.map((b) => b.label) });
          log(`  👁️ 未知浮层（不点，只记录）: 「${allText.slice(0, 70)}」按钮=[${sumButtons.map((b) => b.label).join('|')}]`);
        }
        if (running) timer = setTimeout(tick, intervalMs);
        return;
      }

      const sig = overlaySignature(policy, sumButtons);
      const n = handled.get(sig) || 0;
      if (n >= 4) { if (running) timer = setTimeout(tick, intervalMs); return; }
      handled.set(sig, n + 1);

      log(`  👁️ 浮层「${policy.name}」出现 → 立刻点「${policy.click[0]}」`);
      if (shot) await shot(`overlay-${policy.id}`);   // 拍下"看见的那一刻"
      // 优先用**快照里带的按钮坐标**直接点：这是页面内算出来的真实 rect，
      // 不受 FIND_TARGET 的"视口内 / elementFromPoint 命中"约束（弹窗带动画时那两个判据会误杀）。
      const want = policy.click.map((c) => c.toLowerCase());
      const dangerWords = (policy.danger || []).map((d) => d.toLowerCase());
      const hit = sumButtons.find((b) => {
        const t = String(b.label || '').toLowerCase();
        if (!t || dangerWords.some((d) => t.includes(d))) return false;
        return want.some((w) => t === w || t.includes(w));
      });
      let r;
      if (hit && hit.rect) {
        await page.mouse.click(hit.rect.cx, hit.rect.cy);
        let ok = false;
        const dl = Date.now() + 1500;
        while (Date.now() < dl) {
          await new Promise((res) => setTimeout(res, 150));
          try {
            const s2 = await page.evaluate(SENSE_SNAPSHOT);
            const t2 = ((s2 && s2.overlays) || []).map((o) => o.text).join('  ||  ');
            if (!policy.test(t2)) { ok = true; break; }
          } catch { /* 继续等 */ }
        }
        log(ok
          ? `  🖱️ 点了「${hit.label}」(${hit.rect.cx},${hit.rect.cy}) → 已生效`
          : `  🖱️ 点了「${hit.label}」(${hit.rect.cx},${hit.rect.cy}) → 未见变化`);
        r = { clicked: true, label: hit.label, verified: ok };
      } else {
        r = await clickLabel(page, policy.click, {
          avoid: policy.danger || [],
          verified: async () => {
            const s2 = await page.evaluate(SENSE_SNAPSHOT);
            const t2 = ((s2 && s2.overlays) || []).map((o) => o.text).join('  ||  ');
            return !policy.test(t2);
          },
          log: (m) => log('  ' + m.trim()),
        });
        if (!r.clicked) log(`  ⚠️ 没点成：${r.why}`);
      }
      history.push({ t: Date.now(), kind: policy.name, clicked: r.label || null, verified: r.verified, why: r.why });
      if (r.verified) handled.delete(sig); // 关掉了就重置计数
    } catch (err) {
      // 页面导航过程中 document.body 会短暂为 null —— 正常现象，不是故障，静默跳过
      const msg = (err && err.message ? err.message : String(err)).split('\n')[0];
      const benign = /document\.body is null|of null|Execution context was destroyed|NS_BINDING_ABORTED|navigating/i.test(msg);
      if (!benign && !handled.has('err|' + msg)) {
        handled.set('err|' + msg, 1);
        log(`  ⚠️ 反应器出错（继续轮询）: ${msg}`);
        history.push({ t: Date.now(), kind: 'error', why: msg });
      }
    }
    if (running) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);

  return {
    stop: () => { running = false; if (timer) clearTimeout(timer); return { ticks, history }; },
    /**
     * 暂停/恢复。
     * 为什么需要：有些框**主流程要自己动手**（比如发布前丢弃旧草稿要真的点 Discard），
     * 而反应器认识同一个框时会按策略先点 Not now → 把丢弃意图取消掉。抢跑顺序不对，
     * 结果就是"每轮都弹一次草稿框"（2026-10-19 实测 10 轮里 6 轮）。
     */
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    isPaused: () => paused,
    stats: () => ({ ticks, history: history.slice() }),
    log: history,
  };
}

export { SENSE_INIT, SENSE_DRAIN, SENSE_SNAPSHOT, OVERLAY_POLICY };






