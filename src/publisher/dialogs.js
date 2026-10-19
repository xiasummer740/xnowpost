/**
 * TikTok Studio「意外弹窗」统一处理
 *
 * 背景（2026-10-18 用户实拍 + 20:14 那轮的现场日志）：
 *   上传完 Studio 会弹两种框，都会把 Post 挡住：
 *     ① 「Labeling AI-generated content」（Not now / Turn on）—— AI 标注引导；
 *     ② 「Turn on automatic content checks?」（Cancel / Turn on）—— 自动内容检查引导。
 *   旧实现是「点弹窗里第一个可见按钮」，正好会把 ① 点成 Not now（= 拒绝合规标注，
 *   未标注的 AI 内容 TikTok 有权下架）；再不行就 JS 把弹窗 DOM remove() 掉，
 *   只是藏起来，React 状态还在，下一屏照样被挡。
 *
 * 更关键的是 **TUXModal 的标题文字和按钮行不在同一个元素里**：
 *   只找「同时含文字和按钮」的容器，拿到的是里面某个文本块 → 判成"未知弹窗、无安全按钮"
 *   → 一个都不点 → 弹窗一直盖着 → 点 Post 被遮罩拦下 →
 *   `Locator.click: Timeout 30000ms exceeded` → 整轮发布失败（20:14 那轮就是这么挂的）。
 *   所以现在的做法是「文本锚点 + 向上爬父节点找按钮」。
 *
 * 规则分级（绝不"随便点一个"）：
 *   ① 命中已知签名 → 只点规则里写死的按钮（两种 Turn on 引导都点 Turn on）；
 *   ② 危险按钮（Discard / Delete / Log out / Post / Exit…）**永不点**；
 *      但「Discard this post?」这种框必须点 Not now 把它收掉 —— 只记录不点的话，
 *      遮罩会一直盖着页面，Post 点不动（2026-10-19 实测白等 28 秒）；
 *   ③ 未知浮层 → 只点安全按钮（Not now / 关闭 / 跳过 / Cancel / × / Got it），
 *      没有安全按钮就整个跳过；只有"fixed 定位的浮层"才算弹窗，
 *      普通表单区块不算（否则每轮都会刷一堆假弹窗 + 截图）。
 */
import path from 'path';
import fs from 'fs-extra';

/** 已知弹窗签名：match 是小写子串集合，命中第一条即生效 */
export const DIALOG_RULES = [
  {
    name: 'AI 生成内容标注',
    // 首屏引导 + 发布页里的同类提示都算（注意 TikTok 用的是弯引号 ’）
    match: [
      'labeling ai-generated content',
      'label content that\u2019s completely ai-generated',
      "label content that's completely ai-generated",
      'creators should label content',
      'ai-generated or significantly edited',
      '标注 ai',
      'ai 生成内容',
      'ai生成内容',
    ],
    click: ['turn on', '开启', '打开', '同意', 'enable'],
    why: 'TikTok 政策要求 AI 生成/深度编辑的内容必须标注 → 点 Turn on（不能点 Not now）',
  },
  {
    name: '自动内容检查开启提示',
    // Cancel / Turn on（TUXModal）
    // 用户要求：**出现就点 Turn on**（他明确看到这个框，希望直接开）。
    // 点 Turn on 之后 TikTok 会跑 "Checking in progress… about 10 minutes"，
    // 但发不发布不看它（Post 一直是可点的）→ 由 CHECKS_MAX_WAIT 兜底，最多等 90 秒就发。
    // 想改回"跳过检查就发"：设 XNOWPOST_CONTENT_CHECK=cancel
    match: ['turn on automatic content checks', 'automatic content checks'],
    click: process.env.XNOWPOST_CONTENT_CHECK === 'cancel'
      ? ['cancel', '取消']
      : ['turn on', '开启', '打开'],
    why: '开自动内容检查（可通过 XNOWPOST_CONTENT_CHECK=cancel 改成跳过）',
  },
  {
    name: '确认退出编辑',
    // ⚠️ 2026-10-18 21:05 卡了 90 秒：填完文案后的 Escape / 误点上"返回"会触发
    //    beforeunload 的「Are you sure you want to exit?」（Exit / Cancel）。
    //    必须点 Cancel 留在页面 —— 点 Exit 会把刚上传的作品和文案全丢掉。
    match: ['are you sure you want to exit', 'your progress and changes will not be saved', '确认退出', '离开此页面'],
    click: ['cancel', '取消', 'stay', '继续编辑', '留在此页'],
    why: '点 Cancel 留在发布页（Exit 会丢弃已上传的作品和文案）',
  },
  {
    name: '放弃作品确认',
    match: ['discard this post', 'discard post', '放弃这', 'discard edits', 'you have unsaved'],
    // 2026-10-19 改成 **点 Not now 取消放弃**（原来 click: [] + blocked = 一个都不点）。
    // 为什么要改：这个框会一直盖着页面 —— 当天 10 轮里 6 轮出现，其中 3 轮反应器认错策略
    // （标题块没被识别 + 同屏有「Got it」浮层），结果白等 28 秒才有人把它关掉。
    // Not now 的语义就是「不放弃」，作品和文案都留着；Discard 依旧被 DANGER_LABELS 一票否决。
    click: ['not now', '以后再说', 'cancel', '取消', 'stay', '继续编辑', '留在此页'],
    why: '点 Not now 取消放弃（Discard 会丢掉已上传的作品和文案，绝不点）',
  },
  {
    // 2026-10-19 22:17 实测（TK04 / pm_2214）：内容检查卡满 90 秒被"超时放行"后，
    // 点 Post 立刻弹「Continue to post? We're still checking your video for potential
    // issues.」，按钮 [Cancel | Post now]。以前规则表里没有它 → 日志写成
    // 「👁️ 未知浮层（不点，只记录）」，靠二次兜底才点成功，复盘时看不出到底点了什么。
    // 正确动作是 **Post now**（Cancel = 放弃这次发布）。注意 'post' 在 DANGER_LABELS 里，
    // 所以这条规则要显式 allowDanger，否则 "Post now" 会被危险词一票否决。
    name: '检查未完成确认框',
    match: ['continue to post', 'still checking your video', 'want to continue posting'],
    click: ['post now', '仍然发布', '继续发布', '继续发布视频'],
    allowDanger: ['post'],
    why: '检查还没跑完但已经决定发 → 点 Post now（Cancel 会取消这次发布）',
  },
  {
    name: '操作频繁 / 限流',
    match: ['too many', 'try again later', '操作过于频繁', '稍后再试', 'rate limit', 'temporarily blocked'],
    click: ['got it', '知道了', 'ok', '确定', '关闭', 'close'],
    fatal: true,
    why: '真发不出去，记下来让上层判失败，别硬重试（会加重风控）',
  },
  {
    name: '登录态失效',
    match: ['log in again', 'session expired', '登录已过期', '请重新登录', 'verify your identity'],
    click: ['got it', '知道了', '关闭', 'close', 'not now', '以后再说'],
    fatal: true,
    why: '需要重新登录，自动补齐不了',
  },
  {
    name: '功能引导 / 教程',
    match: ['get started', '开始使用', "what's new", '新功能', 'tips for'],
    click: ['got it', '知道了', 'skip', '跳过', 'not now', '以后再说', 'close', '关闭'],
  },
];

/** 兜底可点的安全按钮（未知浮层时用） */
const SAFE_LABELS = [
  'not now', '以后再说', '暂不', '稍后', 'skip', '跳过', 'got it', '知道了', '明白了',
  'no thanks', '不用了', 'close', '关闭', 'cancel', '取消', 'dismiss', 'ok', '确定', '×', 'x',
];

/** 永远不点（除非规则显式指定） */
const DANGER_LABELS = [
  'discard', '放弃', 'delete', '删除', 'log out', 'sign out', '退出登录', '退出',
  'post', '发布', 'publish', 'turn off', '关闭标注', 'remove video', '移除视频', 'cancel post',
  // 「确认退出编辑」弹窗里的 Exit：点了会丢弃已上传的作品
  'exit', '退出编辑', 'leave page', 'leave this page',
];

/**
 * 在页面里跑的扫描+点击逻辑（必须自包含，会整个序列化进浏览器）
 * 核心：文本锚点 + 向上爬父节点找按钮（原因见文件头）。
 */
function pageSide({ rules, safe, danger, allowDiscard }) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const vis = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
  };
  const area = (el) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };
  const BTN_SEL = 'button, [role="button"], div[class*="TUXButton"], span[class*="TUXButton-label"], div[class*="Button"]';
  const viewportArea = window.innerWidth * window.innerHeight;

  const results = [];

  /** 在 el 子树里找目标按钮（面积最小 = 最内层可点元素，避免点到外层容器空白）
   *  avoid：按钮文字里出现任一危险词就整条排除。
   *  ⚠️ 必须按"按钮自己的文字"排除，而不是只过滤 want 列表：
   *     2026-10-18 21:22 就是因为 "Cancel post" 里**包含** 'cancel'，
   *     被当成安全按钮点了下去 → 把刚点完 Post 的发布直接取消掉（视频没发出去）。
   */
  const pickBtn = (el, want, avoid) => {
    const btns = Array.from(el.querySelectorAll(BTN_SEL)).filter((b) => vis(b) && norm(b.innerText));
    let best = null;
    for (const b of btns) {
      const t = norm(b.innerText);
      if ((avoid || []).some((d) => t.includes(d))) continue;   // 危险词，永不点
      if (!want.includes(t) && !want.some((w) => t.includes(w))) continue;
      if (!best || area(b) < area(best)) best = b;
    }
    return best;
  };

  /** 弹窗右上角的关闭按钮（× / Close）：DOM click 不生效时的最后手段 */
  const pickCloseBtn = (el) => {
    const cands = Array.from(el.querySelectorAll('button,[role="button"],div[class*="Button"],span[class*="Button"],svg,span'))
      .filter(vis);
    let best = null;
    for (const b of cands) {
      const t = norm(b.innerText);
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const isClose = ['×', '✕', '✖', 'x'].includes(t) || /close|dismiss/.test(aria);
      if (!isClose) continue;
      if (!best || area(b) < area(best)) best = b;
    }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  };

  /** 按文本签名找到「标题」，再往上爬到能看到目标按钮的那一层并点击 */
  const clickByAnchoredText = (keywords, wantLabels, avoidLabels) => {
    const els = document.querySelectorAll('div,section,aside,header,footer,p,span,h1,h2,h3,h4,label,strong,b,li,form');
    let anchor = null;
    for (const el of els) {
      if (!vis(el)) continue;
      // 先按 textContent 粗筛（便宜），再用 innerText 确认"文字真的渲染出来了"。
      // ⚠️ 只用 textContent 会踩坑：页面里藏着未显示的 toast 模板文字，
      //    「操作频繁/限流」规则会被这种隐藏文案误命中（2026-10-18 20:39 实测刷了 3 次假告警）。
      const raw = norm(el.textContent);
      if (!raw || raw.length > 900) continue;
      if (!keywords.some((k) => raw.includes(k))) continue;
      const shown = norm(el.innerText);
      if (!shown || !keywords.some((k) => shown.includes(k))) continue;
      if (!anchor || area(el) < area(anchor)) anchor = el; // 取最贴近文字本身的匹配元素
    }
    if (!anchor) return null;

    let scope = anchor;
    for (let up = 0; up < 9 && scope; up++) {
      // 爬到「整页容器」就该停：再往上会点到页面上别的按钮（比如另一个弹窗的 Turn on）
      if (up > 0 && area(scope) > viewportArea * 0.55) break;
      // 规则命中的按钮同样要过一遍危险词（例如「Cancel post」不能因为含 cancel 就被点）
      const btn = pickBtn(scope, wantLabels, avoidLabels || danger);
      if (btn) {
        const label = norm(btn.innerText).slice(0, 40);
        const headText = norm(scope.innerText).slice(0, 220);
        const rect = btn.getBoundingClientRect();
        btn.click();
        // 同时把按钮中心坐标和关闭按钮坐标带出去：DOM click 对 TUXModal 的 DIV 按钮
        // 经常"没报错但也没生效"（2026-10-18 22:28 实测点了 cancel 弹窗还挂着 40 秒），
        // 外层拿到坐标后用真实鼠标再点一次。
        return {
          clicked: label,
          text: headText,
          cx: Math.round(rect.x + rect.width / 2),
          cy: Math.round(rect.y + rect.height / 2),
          close: pickCloseBtn(scope),
        };
      }
      scope = scope.parentElement;
    }
    return { clicked: '', text: norm(anchor.innerText).slice(0, 220) };
  };

  // ---- 第一轮：按规则签名处理（覆盖「文字与按钮分离」的弹窗）----
  for (const rule of rules) {
    // 规则可以显式豁免个别危险词（例如「检查未完成确认框」必须点 Post now，
    // 而 'post' 本身在 DANGER_LABELS 里）。豁免范围仅限这条规则。
    const ruleDanger = Array.isArray(rule.allowDanger) && rule.allowDanger.length
      ? danger.filter((d) => !rule.allowDanger.includes(d))
      : danger;
    const r = clickByAnchoredText(rule.match, rule.click && rule.click.length ? rule.click : [], ruleDanger);
    if (!r) continue;
    const base = { rule: rule.name, text: r.text, labels: [], keyword: rule.match[0], cx: r.cx, cy: r.cy, close: r.close };
    if (rule.blocked) {
      results.push({ ...base, kind: 'blocked', why: rule.why || '' });
    } else if (r.clicked) {
      results.push({ ...base, kind: 'clicked', clicked: r.clicked });
    } else {
      results.push({ ...base, kind: 'no-match', why: rule.why || '' });
    }
  }

  // ---- 第二轮：只处理**浮层**（fixed 定位且面积够大）。
  //      上传表单里的普通区块（"Content check lite"、检查说明…）不是弹窗，
  //      之前把它们当弹窗 → 每轮都刷一堆假动作 + 截图 ----
  const SEL = 'div[role="dialog"],[role="dialog"],[role="alertdialog"],div[class*="Modal"],div[class*="modal"],div[class*="Overlay"],div[class*="overlay"]';
  let cands = Array.from(document.querySelectorAll(SEL)).filter((el) => vis(el) && area(el) > 20000);
  cands = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));

  const isFloating = (el) => {
    let n = el;
    for (let i = 0; i < 6 && n; i++) {
      const cs = window.getComputedStyle(n);
      if (cs.position === 'fixed') return true;
      n = n.parentElement;
    }
    return false;
  };

  for (const ov of cands) {
    const text = norm(ov.innerText).slice(0, 220);
    if (!text) continue;
    // 已被规则认领的（无论点上没点上）不重复报
    if (rules.some((r) => r.match.some((k) => text.includes(k)))) continue;
    if (!isFloating(ov)) continue;

    // ---- 只有按钮、没有标题的「放弃作品确认」----
    // 2026-10-19 实测 3 次：这个框的标题块偶尔不进浮层集合，浮层里只剩
    // 「Not now / Discard」两个按钮 → 文字签名一个都命中不了 → 被当成"未知弹窗"点掉。
    // 用户看到的日志就是「⚠️ 未知弹窗 → 点了安全按钮「not now」（not now discard…）」，
    // 明明是认得的框却报成未知，复盘时很误导。这里按**按钮组合**兜底识别
    // （和 page-sense 的 policyFromButtons 同一口径：取消类 + Discard = 放弃作品确认）。
    const labels = Array.from(ov.querySelectorAll(BTN_SEL)).filter((b) => vis(b)).map((b) => norm(b.innerText)).filter(Boolean);
    const cancelLabels = labels.filter((t) => ['not now', 'cancel', 'stay', '以后再说', '取消', '继续编辑', '留在此页', 'no thanks'].some((s) => t.includes(s)));
    const hasDiscard = labels.some((t) => t.includes('discard') || t.includes('放弃'));
    if (hasDiscard && cancelLabels.length) {
      // allowDiscard 只在"上传之前"那一步为 true：那时候页面上还没有我们的作品，丢的是旧草稿
      const target = allowDiscard ? pickBtn(ov, ['discard', '放弃'], []) : pickBtn(ov, cancelLabels, danger);
      if (target) {
        const label = norm(target.innerText).slice(0, 40);
        const rect = target.getBoundingClientRect();
        target.click();
        results.push({
          kind: 'clicked', rule: '放弃作品确认', clicked: label, text, labels, buttonOnly: true,
          keyword: 'not now', cx: Math.round(rect.x + rect.width / 2), cy: Math.round(rect.y + rect.height / 2),
          close: pickCloseBtn(ov),
        });
        continue;
      }
    }

    const btn = pickBtn(ov, safe.filter((s) => !danger.includes(s)), danger);
    if (btn) {
      const label = norm(btn.innerText).slice(0, 40);
      const rect = btn.getBoundingClientRect();
      btn.click();
      results.push({
        kind: 'unknown-dismissed', clicked: label, text, labels: [], keyword: text.slice(0, 40),
        cx: Math.round(rect.x + rect.width / 2), cy: Math.round(rect.y + rect.height / 2),
        close: pickCloseBtn(ov),
      });
    } else {
      const all = Array.from(ov.querySelectorAll(BTN_SEL)).filter(vis);
      if (!all.length) continue; // 没有按钮 = 只是浮层正文，不是弹窗
      results.push({ kind: 'unknown-skipped', text, labels: all.map((b) => norm(b.innerText).slice(0, 30)) });
    }
  }
  return results;
}

/** 同一次发布里，同一个弹窗只留一次证据（否则一轮能写几十张 PNG） */
const evidenceTaken = new Set();

/** 同一个"签名命中但没有按钮"的误报只提示一次，别刷屏 */
const loggedOnce = new Set();

/**
 * 处理当前页面上所有可见弹窗。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.allowDiscardDraft] **只在「还没上传我们自己的视频」那一步用**：
 *   打开后「放弃作品确认」这条规则改成点 Discard（= 真的把旧草稿丢掉），
 *   同时把 danger 里的 discard/放弃 摘掉，让这个按钮可以点到。
 *   ⚠️ 上传之后绝不能开这个开关 —— 那时候的「Discard this post?」是问要不要丢掉**我们的作品**。
 * @returns {Promise<{actions:Array, total:number}>}
 */
export async function handleDialogs(page, { sessionPath, tag = 'stage', maxRounds = 3, log = console.log, allowDiscardDraft = false } = {}) {
  const all = [];
  const seen = new Set();

  const rules = DIALOG_RULES.map((r) => {
    const isDiscardRule = r.name === '放弃作品确认';
    return {
      name: r.name,
      match: r.match,
      // 用户口径（2026-10-19）：发布前发现旧草稿，就该真的丢弃它，而不是留着一遍遍弹框。
      click: allowDiscardDraft && isDiscardRule ? ['discard', '放弃'] : (r.click || []),
      // 逐条规则的"危险词豁免"（例如「检查未完成确认框」必须点 Post now，
      // 而 'post' 在 DANGER_LABELS 里）。漏传这一项 → 规则命中但一个按钮都点不到。
      allowDanger: Array.isArray(r.allowDanger) ? r.allowDanger : [],
      blocked: !!r.blocked,
      why: r.why || '',
    };
  });
  // 只在这一步把「discard/放弃」从危险词里摘出来；其余规则和"未知弹窗"路径
  // 仍然拿不到 Discard（SAFE_LABELS 里本来就没有 discard，pickBtn 不会选它）。
  const danger = allowDiscardDraft
    ? DANGER_LABELS.filter((d) => d !== 'discard' && d !== '放弃')
    : DANGER_LABELS;

  for (let round = 1; round <= maxRounds; round++) {
    let actions = [];
    try {
      actions = await page.evaluate(pageSide, { rules, safe: SAFE_LABELS, danger, allowDiscard: allowDiscardDraft });
    } catch (err) {
      log(`  ⚠️ 弹窗扫描失败（不影响主流程）: ${err.message}`);
      return { actions: all, total: all.length };
    }

    if (!Array.isArray(actions) || actions.length === 0) break;

    let acted = false;
    for (const a of actions) {
      const key = `${a.kind}|${(a.text || '').slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(a);

      if (a.kind === 'clicked') {
        acted = true;
        const how = a.buttonOnly ? '（标题块没进来，靠「取消类 + Discard」按钮组合认出来的）' : '';
        log(`  ✅ 弹窗「${a.rule}」→ 点了「${a.clicked}」${how}`);
        if (/AI 生成内容标注/.test(a.rule)) log('     （按 TikTok 政策标注 AI 生成内容；不标注可能被下架）');
        if (allowDiscardDraft && /放弃作品确认/.test(a.rule)) {
          log('     （这一步还没上传我们的视频/文案，丢弃的是上一次留下的旧草稿，所以 Discard 是安全的）');
        }
      } else if (a.kind === 'unknown-dismissed') {
        acted = true;
        log(`  ⚠️ 未知弹窗 → 点了安全按钮「${a.clicked}」（${(a.text || '').slice(0, 60)}…）`);
      } else if (a.kind === 'blocked') {
        log(`  🛑 弹窗「${a.rule}」被拦下不点：${a.why}`);
        log(`     弹窗文字: ${(a.text || '').slice(0, 120)}`);
      } else if (a.kind === 'no-match') {
        // 签名命中但这一层没按钮（例如页面上本来就有 "Edit cover" 这种表单文字）：
        // 只提示一次，别每轮都刷 —— 日志刷屏会盖住真正的关键信息
        const onceKey = `nomatch|${a.rule}|${(a.text || '').slice(0, 40)}`;
        if (!loggedOnce.has(onceKey)) {
          loggedOnce.add(onceKey);
          log(`  ℹ️ 命中弹窗签名「${a.rule}」但附近没有目标按钮，忽略（可用: ${(a.labels || []).join(' / ') || '无'}）`);
        }
      } else {
        log(`  ⚠️ 未知弹窗且没有安全按钮，跳过（可用: ${(a.labels || []).join(' / ')}）`);
      }
    }

    // ---- 真实鼠标补点：DOM click 对 TUXModal 的 DIV 按钮经常"报成功但没效果"----
    // 2026-10-18 22:28 实测：日志写着「点了 cancel」，监控却看到弹窗又挂着 40 秒。
    // 做法：点完 1.2 秒后回读一次，签名文字还在 → 用 page.mouse.click 按坐标真点一次；
    //      还在 → 点右上角 ×。这样才真的把框关掉。
    const clickables = actions.filter(
      (a) => (a.kind === 'clicked' || a.kind === 'unknown-dismissed') && typeof a.cx === 'number' && a.keyword,
    );
    for (const a of clickables) {
      try {
        // ⚠️ 大小写必须忽略：规则里的签名是小写，页面文字是「Turn on automatic content checks?」，
        //    原来直接 includes 永远 false → 误判"弹窗已关闭"，补点逻辑一次都没跑（2026-10-18 22:40 实测）
        const kw = String(a.keyword || '').toLowerCase();
        const stillVisible = () =>
          page.evaluate((needle) => {
            const t = (document.body.innerText || '').toLowerCase();
            return t.includes(needle);
          }, kw).catch(() => false);
        await page.waitForTimeout(1200);
        if (!(await stillVisible())) continue;
        log(`  🖱️ 「${a.clicked}」的 DOM 点击没生效，改用真实鼠标坐标再点一次`);
        if (page.mouse && typeof page.mouse.click === 'function') {
          await page.mouse.click(a.cx, a.cy);
          await page.waitForTimeout(900);
          if (!(await stillVisible())) continue;
          if (a.close) {
            log('  🖱️ 按钮无效，改点右上角关闭 ×');
            await page.mouse.click(a.close.cx, a.close.cy);
            await page.waitForTimeout(600);
          }
          if (await stillVisible()) log('  ⚠️ 弹窗仍然在（交给后续步骤继续处理）');
          else log('  ✅ 弹窗已关闭（真实鼠标点击）');
        }
      } catch (err) {
        log(`  ⚠️ 弹窗补点失败（继续主流程）: ${(err.message || '').split('\n')[0]}`);
      }
    }

    // 留证据：只给"需要人看"的，且同一个弹窗只存一次
    const needEvidence = actions.filter(
      (a) => (a.kind === 'blocked' || a.kind === 'unknown-skipped' || a.kind === 'no-match')
        && !evidenceTaken.has(`${tag}|${a.kind}|${(a.text || '').slice(0, 60)}`),
    );
    if (needEvidence.length && sessionPath) {
      for (const a of needEvidence) evidenceTaken.add(`${tag}|${a.kind}|${(a.text || '').slice(0, 60)}`);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = path.join(sessionPath, `dialog-${tag}-${stamp}`);
      try {
        if (typeof page.screenshot === 'function') {
          const shot = await page.screenshot();
          if (shot && Buffer.isBuffer(shot)) await fs.writeFile(`${base}.png`, shot);
        }
      } catch (err) {
        log(`  ⚠️ 弹窗截图失败: ${err.message}`);
      }
      try {
        await fs.writeJson(`${base}.json`, { tag, at: new Date().toISOString(), actions: needEvidence }, { spaces: 2 });
      } catch (_) {}
      log(`  📸 弹窗证据: ${path.basename(base)}.png / .json`);
    }

    // 只有真的点掉了东西才值得再扫一轮；否则说明剩下的都点不动，别空转
    if (!acted) break;
    await page.waitForTimeout(600);
  }

  return { actions: all, total: all.length };
}

/** 页面侧逻辑导出给单测用（浏览器里跑的那份代码） */
export { pageSide as _pageSide };

/** 有致命弹窗（限流/掉登录）时给上层用 */
export function findFatalDialog(actions) {
  return (actions || []).find(
    // 只有「真的点到了/真的被拦下」才算致命。
    // no-match（签名命中但没按钮）绝不能判致命 —— 那多半是页面正文里的文案，
    // 判致命会直接把一轮正常发布中止掉（2026-10-18 20:39 实测有这种误命中）。
    (a) => (a.kind === 'clicked' || a.kind === 'blocked')
      && DIALOG_RULES.some((r) => r.fatal && r.name === a.rule),
  ) || null;
}

/** 单测用：清掉证据去重表 */
export function _resetEvidence() {
  evidenceTaken.clear();
}
