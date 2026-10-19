/**
 * 弹窗处理规则单测（不需要真浏览器：用最小 DOM 影子对象跑页面侧那段逻辑）
 *
 * 覆盖的真实事故（2026-10-18）：
 *   TikTok 上传完弹「Labeling AI-generated content」引导框（Not now / Turn on），
 *   旧实现点「弹窗里第一个按钮」→ 点了 Not now（拒绝 AI 标注），
 *   甚至可能点到 Discard / Delete。这里把判定逻辑钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DIALOG_RULES, handleDialogs, findFatalDialog, _pageSide } from '../../src/publisher/dialogs.js';

// ---------- 最小 DOM 影子 ----------
function el(opts = {}) {
  const node = {
    tag: opts.tag || 'div',
    text: opts.text || '',
    hiddenText: opts.hiddenText || '',
    role: opts.role || '',
    className: opts.className || '',
    width: opts.width ?? 400,
    height: opts.height ?? 300,
    children: [],
    clicked: 0,
    parent: null,
    get offsetWidth() { return this.width; },
    get offsetHeight() { return this.height; },
    get innerText() {
      const childText = this.children.map((c) => c.innerText).join(' ');
      return [this.text, childText].filter(Boolean).join(' ').trim();
    },
    // 页面侧的锚点匹配用的是 textContent（不触发排版，比 innerText 便宜）
    // 页面侧的锚点匹配先用 textContent 粗筛、再用 innerText 确认
    // hiddenText 专门用来模拟"藏在 DOM 里但没渲染出来的文案"（真实踩过）
    get textContent() { return [this.innerText, this.hiddenText].filter(Boolean).join(' '); },
    get parentElement() { return this.parent; },
    position: opts.position || 'fixed',
    ariaLabel: opts.ariaLabel || '',
    getAttribute(name) { return name === 'aria-label' ? this.ariaLabel : ''; },
    getClientRects() { return this.width || this.height ? [{}] : []; },
    getBoundingClientRect() {
      return { width: this.width, height: this.height, top: 10, left: 10, bottom: 10 + this.height, right: 10 + this.width };
    },
    contains(other) {
      if (other === this) return true;
      return this.children.some((c) => c.contains(other));
    },
    querySelectorAll() {
      // 影子实现：把子孙里标记为可点的都返回（页面侧只用这一个选择器组取按钮）
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (c.clickable) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    click() { this.clicked += 1; },
  };
  for (const c of opts.children || []) {
    c.parent = node;
    node.children.push(c);
  }
  return node;
}

/** 当前「页面上」存在的弹窗；点掉按钮后清空，模拟真实弹窗关闭，避免多轮重复点击 */
let liveModals = [];

function btn(label, opts = {}) {
  const b = el({ text: label, width: opts.width ?? 100, height: opts.height ?? 36, className: 'TUXButton', ...opts });
  b.clickable = true;
  b.click = () => { b.clicked += 1; liveModals = []; };
  return b;
}

function installDom(modals) {
  liveModals = modals;
  // 真实 DOM 里 querySelectorAll 会按选择器返回不同集合，这里按用途区分：
  //   - 带 role=dialog / Modal / Overlay 的查询 → 只返回弹窗根
  //   - 其它（页面侧找文本锚点用的大列表）→ 返回整棵树，才能测"标题与按钮分离"的爬升逻辑
  const collectAll = () => {
    const out = [];
    const walk = (n) => { out.push(n); for (const c of n.children) walk(c); };
    for (const m of liveModals) walk(m);
    return out;
  };
  globalThis.document = {
    // Node 侧的"补点前回读"用 document.body.innerText 判断弹窗是否还在
    body: { get innerText() { return liveModals.map((m) => m.innerText).join(' '); } },
    querySelectorAll: (sel) => (/dialog|Modal|modal|Overlay|overlay/.test(sel) ? liveModals : collectAll()),
  };
  globalThis.window = {
    innerHeight: 900,
    innerWidth: 1200,
    getComputedStyle: (n) => ({ position: (n && n.position) || 'static' }),
  };
  return () => { liveModals = []; delete globalThis.document; delete globalThis.window; };
}

function fakePage() {
  const calls = [];
  return {
    calls,
    mouseClicks: [],
    mouse: {
      async click(x, y) { this.owner.mouseClicks.push([x, y]); },
      owner: null,
    },
    async evaluate(fn, arg) {
      // 真实实现里 fn 被序列化进浏览器；这里直接在同一进程调用
      calls.push(arg);
      return fn(arg);
    },
    async waitForTimeout() {},
    async screenshot() { return Buffer.from(''); },
  };
}

// ---------- 规则表本身 ----------
test('AI 标注规则：点 Turn on，绝不能点 Not now', () => {
  const rule = DIALOG_RULES.find((r) => /AI 生成内容标注/.test(r.name));
  assert.ok(rule, '必须存在 AI 标注规则');
  assert.ok(rule.match.some((k) => k.includes('ai-generated')), '按 TikTok 实际文案匹配');
  assert.ok(rule.click.includes('turn on'), '指定 Turn on');
  assert.ok(!rule.click.includes('not now'), '不能把 Not now 当目标按钮');
});

test('危险按钮清单覆盖 Discard/Delete/Log out/Post', () => {
  // 通过页面侧行为验证：未知弹窗里只有危险按钮时必须不点
  const restore = installDom([]);
  try {
    const dangerOnly = el({
      text: 'Are you sure?',
      children: [btn('Discard'), btn('Delete'), btn('Log out')],
    });
    globalThis.document = { querySelectorAll: () => [dangerOnly] };
    const actions = _pageSide({ rules: [], safe: ['not now', 'close', 'discard', 'delete', 'log out'], danger: ['discard', 'delete', 'log out', 'post'] });
    assert.equal(actions[0].kind, 'unknown-skipped', '只有危险按钮时应当跳过，不点任何东西');
    assert.equal(dangerOnly.children.reduce((n, c) => n + c.clicked, 0), 0, '一个按钮都不能被点');
  } finally {
    restore();
  }
});

// ---------- 核心：AI 标注引导 ----------
test('AI 标注引导弹窗 → 点 Turn on，不点 Not now', async () => {
  const turnOn = btn('Turn on');
  const notNow = btn('Not now');
  const modal = el({
    text: 'Labeling AI-generated content Creators should label content that is completely AI-generated',
    children: [notNow, turnOn],
  });
  const restore = installDom([modal]);
  try {
    const page = fakePage();
    const { actions } = await handleDialogs(page, {});
    assert.equal(turnOn.clicked, 1, 'Turn on 必须被点到');
    assert.equal(notNow.clicked, 0, 'Not now 一次都不能点');
    const clicked = actions.find((a) => a.kind === 'clicked');
    assert.ok(clicked, '应当记一条 clicked 动作');
    assert.match(clicked.rule, /AI 生成内容标注/);
    assert.equal(clicked.clicked, 'turn on');
  } finally {
    restore();
  }
});

test('放弃作品确认弹窗 → 点 Not now 收掉，Discard 绝不点', async () => {
  // 2026-10-19 改口径：原来「整个框都不点」，结果框一直盖着页面、
  // 当天 3/10 轮白等 28 秒。Not now 的语义是「不放弃」，必须点上。
  const discard = btn('Discard');
  const notNow = btn('Not now');
  const modal = el({
    text: 'Discard this post? Your video “video” and any edits will be discarded permanently.',
    children: [notNow, discard],
  });
  const restore = installDom([modal]);
  try {
    const page = fakePage();
    const { actions } = await handleDialogs(page, {});
    assert.equal(discard.clicked, 0, 'Discard 绝不能点（会丢掉已上传的作品）');
    assert.equal(notNow.clicked, 1, 'Not now 必须点上，否则遮罩一直挡着页面');
    const clicked = actions.find((a) => a.kind === 'clicked');
    assert.ok(clicked, '应当记一条 clicked 动作');
    assert.match(clicked.rule, /放弃作品确认/);
  } finally {
    restore();
  }
});

test('放弃作品确认弹窗只有 Discard 一个按钮 → 一个都不点（留证据）', async () => {
  const discard = btn('Discard');
  const modal = el({ text: 'Discard this post? Your edits will be discarded permanently.', children: [discard] });
  const restore = installDom([modal]);
  try {
    const page = fakePage();
    const { actions } = await handleDialogs(page, {});
    assert.equal(discard.clicked, 0, '没有安全按钮时绝不能碰 Discard');
    assert.ok(actions.some((a) => a.kind === 'no-match'), '要留下命中但没按钮的痕迹');
  } finally {
    restore();
  }
});

test('发布前丢旧草稿：allowDiscardDraft 时点 Discard，绝不点 Not now', async () => {
  // 用户口径（2026-10-19）：发布时里面有草稿就该真丢掉 —— 点 Not now 等于没丢，下次还弹。
  const discard = btn('Discard');
  const notNow = btn('Not now');
  const modal = el({
    text: 'Discard this post? Your video “video” and any edits will be discarded permanently.',
    children: [notNow, discard],
  });
  const restore = installDom([modal]);
  try {
    const page = fakePage();
    const { actions } = await handleDialogs(page, { allowDiscardDraft: true });
    assert.equal(discard.clicked, 1, '这一步必须点 Discard 把旧草稿真正丢掉');
    assert.equal(notNow.clicked, 0, '点 Not now 等于取消丢弃');
    const clicked = actions.find((a) => a.kind === 'clicked');
    assert.match(clicked.rule, /放弃作品确认/);
    assert.match(clicked.clicked, /discard/i);
  } finally {
    restore();
  }
});

test('allowDiscardDraft 只放开「放弃作品确认」这一条规则，未知弹窗里的 Discard 依旧不点', async () => {
  const discard = btn('Discard');
  const gotIt = btn('Got it');
  const modal = el({ text: 'Some brand new tutorial you have never seen', children: [discard, gotIt] });
  const restore = installDom([modal]);
  try {
    const page = fakePage();
    await handleDialogs(page, { allowDiscardDraft: true });
    assert.equal(discard.clicked, 0, '放开开关不能顺手让未知弹窗点到 Discard');
    assert.equal(gotIt.clicked, 1, '未知弹窗还是只点安全按钮');
  } finally {
    restore();
  }
});

test('只有按钮没有标题的「放弃作品确认」→ 按按钮组合认出来，点 Not now（不许报未知弹窗）', async () => {
  // 2026-10-19 当天实测 3 次（08:47 / 08:57 / 09:07）：标题块没进浮层集合，
  // 浮层里只剩「Not now / Discard」→ 文字签名全不命中 → 日志写成
  // 「⚠️ 未知弹窗 → 点了安全按钮「not now」（not now discard…）」，误导复盘。
  const discard = btn('Discard');
  const notNow = btn('Not now');
  const modal = el({ text: '', children: [notNow, discard] });
  const restore = installDom([modal]);
  try {
    const page = fakePage();
    const { actions } = await handleDialogs(page, {});
    assert.equal(notNow.clicked, 1, 'Not now 要真的点上（关掉遮罩但不放弃作品）');
    assert.equal(discard.clicked, 0, 'Discard 绝不点');
    assert.ok(!actions.some((a) => /unknown/.test(a.kind)), '认得出来就别再报"未知弹窗"');
    const clicked = actions.find((a) => a.kind === 'clicked');
    assert.match(clicked.rule, /放弃作品确认/);
    assert.equal(clicked.buttonOnly, true, '标记这是靠按钮组合认出来的，日志要说明');
  } finally {
    restore();
  }
});

test('只有按钮的「放弃作品确认」+ allowDiscardDraft → 点 Discard 真丢掉', async () => {
  const discard = btn('Discard');
  const notNow = btn('Not now');
  const modal = el({ text: '', children: [notNow, discard] });
  const restore = installDom([modal]);
  try {
    const page = fakePage();
    await handleDialogs(page, { allowDiscardDraft: true });
    assert.equal(discard.clicked, 1, '发布前那一步没有我们的作品，丢的是旧草稿');
    assert.equal(notNow.clicked, 0);
  } finally {
    restore();
  }
});

test('未知弹窗 → 只点安全按钮', async () => {
  const gotIt = btn('Got it');
  const post = btn('Post');
  const modal = el({ text: 'Some brand new tutorial you have never seen', children: [post, gotIt] });
  const restore = installDom([modal]);
  try {
    const page = fakePage();
    await handleDialogs(page, {});
    assert.equal(gotIt.clicked, 1);
    assert.equal(post.clicked, 0, 'Post 属于危险按钮，未知弹窗里不点');
  } finally {
    restore();
  }
});

test('限流弹窗被识别为致命，但不阻止当前这轮清理', async () => {
  const ok = btn('Got it');
  const modal = el({ text: 'Too many attempts, please try again later', children: [ok] });
  const restore = installDom([modal]);
  try {
    const page = fakePage();
    const { actions } = await handleDialogs(page, {});
    assert.equal(ok.clicked, 1, '先点掉弹窗');
    const fatal = findFatalDialog(actions);
    assert.ok(fatal, '同时要能被 findFatalDialog 识别为致命');
    assert.match(fatal.rule, /限流/);
  } finally {
    restore();
  }
});

test('没有弹窗时不产生任何动作', async () => {
  const restore = installDom([]);
  try {
    const page = fakePage();
    const { total } = await handleDialogs(page, {});
    assert.equal(total, 0);
  } finally {
    restore();
  }
});

// ---------- 真实事故复现：标题与按钮不在同一层 ----------
test('「Turn on automatic content checks?」标题与按钮分离 → 点 Turn on（用户指定）', async () => {
  // 复刻 20:14 那轮的真实结构：标题在 body，按钮在 footer，两者平级。
  // 2026-10-18 22:5x 用户明确要求：这个框出现就点 **Turn on**（他要开自动内容检查）。
  // 点 Turn on 后 TikTok 会跑 "Checking in progress… about 10 minutes"，
  // 但发不发布不看它 → 由 CHECKS_MAX_WAIT 兜底（默认 90 秒就放行），不会再把预算烧光。
  const turnOn = btn('Turn on');
  const cancel = btn('Cancel');
  const title = el({ text: "Turn on automatic content checks? We'll automatically check your video for copyright.", width: 400, height: 90 });
  const footer = el({ children: [cancel, turnOn], width: 400, height: 60 });
  const modal = el({ children: [title, footer], width: 520, height: 300 });
  const restore = installDom([modal]);
  try {
    const page = fakePage();
    const rule = DIALOG_RULES.find((r) => /自动内容检查/.test(r.name));
    assert.ok(rule, '规则必须存在');
    const { actions } = await handleDialogs(page, {});
    assert.equal(turnOn.clicked, 1, '必须把框点掉，否则 Post 一直被遮罩挡住');
    assert.equal(cancel.clicked, 0, '默认不点 Cancel（用户要求点 Turn on）');
    const clicked = actions.find((a) => a.kind === 'clicked');
    assert.match(clicked.rule, /自动内容检查/);
    // 按钮坐标要带出来，Node 侧才能用真实鼠标补点
    assert.equal(typeof clicked.cx, 'number', '必须带回点击坐标');
  } finally {
    restore();
  }
});

test('「Cancel post now?」提示条上的 Cancel post 绝不能被当成安全按钮点掉', async () => {
  // 复刻 21:22 的翻车：点完 Post 后 TikTok 弹 "Posting… Cancel post"，
  // 老逻辑按 includes('cancel') 判定 → 点了 Cancel post → 视频没发出去
  const cancelPost = btn('Cancel post');
  const keep = btn('Got it');
  const title = el({ text: 'Posting your video… Cancel post now?', width: 400, height: 70 });
  const footer = el({ children: [cancelPost, keep], width: 400, height: 56 });
  const modal = el({ children: [title, footer], width: 520, height: 260 });
  const restore = installDom([modal]);
  try {
    const page = fakePage();
    const { actions } = await handleDialogs(page, {});
    assert.equal(cancelPost.clicked, 0, 'Cancel post 会取消刚发出去的视频，绝不能点');
    const clicked = actions.find((a) => a.kind === 'clicked');
    if (clicked) assert.notMatch(clicked.clicked || '', /cancel post/i);
  } finally {
    restore();
  }
});

test('「Are you sure you want to exit?」→ 点 Cancel 留在页面，绝不点 Exit', async () => {
  // 21:05 实测：填完文案后的 Escape 触发了 beforeunload 确认框，没人点 → 卡 90 秒
  const exit = btn('Exit');
  const cancel = btn('Cancel');
  const title = el({ text: 'Are you sure you want to exit? Your progress and changes will not be saved.', width: 400, height: 80 });
  const footer = el({ children: [exit, cancel], width: 400, height: 60 });
  const modal = el({ children: [title, footer], width: 520, height: 300 });
  const restore = installDom([modal]);
  try {
    const page = fakePage();
    const { actions } = await handleDialogs(page, {});
    assert.equal(cancel.clicked, 1, 'Cancel 必须被点到');
    assert.equal(exit.clicked, 0, 'Exit 会丢弃已上传的作品，绝不能点');
    assert.match(actions.find((a) => a.kind === 'clicked').rule, /确认退出/);
  } finally {
    restore();
  }
});

test('AI 标注引导（弯引号 + 按钮分离）→ 点 Turn on', async () => {
  const turnOn = btn('Turn on');
  const notNow = btn('Not now');
  const title = el({ text: 'Creators should label content that\u2019s completely AI-generated or significantly edited by AI', width: 400, height: 90 });
  const footer = el({ children: [notNow, turnOn], width: 400, height: 60 });
  const modal = el({ children: [title, footer], width: 520, height: 320 });
  const restore = installDom([modal]);
  try {
    const page = fakePage();
    await handleDialogs(page, {});
    assert.equal(turnOn.clicked, 1);
    assert.equal(notNow.clicked, 0);
  } finally {
    restore();
  }
});

test('上传表单里的普通区块（非浮层）不算弹窗，不产生动作也不刷截图', async () => {  // 20:15 那轮就因为这些区块被当成弹窗，一轮写了几十张 PNG
  const section = el({
    position: 'static',
    text: "Content check lite We'll automatically check your content for For You feed eligibility.",
    width: 800,
    height: 120,
  });
  const restore = installDom([section]);
  try {
    const page = fakePage();
    const { total } = await handleDialogs(page, {});
    assert.equal(total, 0, '静态表单区块不该被当成弹窗');
  } finally {
    restore();
  }
});

// ---------- 2026-10-18 20:39 实测的两个误判 ----------
test('藏在 DOM 里但没渲染的文案（隐藏 toast）不该命中弹窗规则', async () => {
  // 真实现场：页面隐藏着一个 toast 模板 "Too many attempts…
  // 只按 textContent 匹配就会把它当"限流弹窗"，一次发布刷出 3 条假告警
  const section = el({
    position: 'static',
    text: 'Content check lite',
    hiddenText: 'Too many attempts. Please try again later.',
    width: 800,
    height: 120,
  });
  const restore = installDom([section]);
  try {
    const page = fakePage();
    const { total, actions } = await handleDialogs(page, {});
    assert.equal(total, 0, '只有渲染出来的文字才算');
    assert.equal(findFatalDialog(actions), null, '更不能因此判致命');
  } finally {
    restore();
  }
});

test('findFatalDialog 只认「真点到/真被拦」，no-match 绝不判致命', async () => {
  assert.equal(findFatalDialog([{ kind: 'no-match', rule: '操作频繁 / 限流', text: 'Content check lite' }]), null);
  assert.equal(findFatalDialog([{ kind: 'unknown-skipped', rule: '操作频繁 / 限流' }]), null);
  assert.ok(findFatalDialog([{ kind: 'clicked', rule: '操作频繁 / 限流', clicked: 'got it' }]));
  assert.ok(findFatalDialog([{ kind: 'blocked', rule: '操作频繁 / 限流' }]));
});

