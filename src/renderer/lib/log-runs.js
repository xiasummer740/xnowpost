/**
 * 把上千行日志折叠成「一轮任务一行」（纯函数，单测在 tests/unit/log-runs.test.js）
 *
 * 为什么需要：调度器日志一条轮次动辄一两百行，一天 11 轮就是一千多行，
 * 而真正有用的是「08:30 那轮成没成、花了多少、发了几个号」（2026-10-19 用户反馈
 * 「还是得翻一千多行才能找到 08:30」）。这里按 `🚀 … 任务开始` 切轮，
 * 从轮内日志里抽出结果/耗时/账号/花费，界面只渲染这一行，点开才看细节。
 *
 * 切分口径（故意宽松，宁可少切也不要切错）：
 *   - 新的一轮从 `🚀 <模式> 任务开始…` 开始，到**下一个** `🚀 …任务开始` 之前结束；
 *   - 不依赖"结束标记"（各任务收尾文字都不一样：`✅ 仅视频 完成` / `✅ 数据采集 + 日报 完成` /
 *     `❌ … 失败：…`），结果从轮内日志推断；
 *   - 第一轮之前的行（应用启动、配置、环境检查）归到一个「启动 / 配置」组，默认折叠。
 */

const START_RE = /🚀\s*(.+?)\s*任务开始/;

function pick(re, s, i = 1) {
  const m = String(s || '').match(re);
  return m ? m[i] : '';
}

function toMs(time) {
  // '2026-10-19 08:30:00'
  const m = String(time || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m} 分 ${r} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

/** 从一轮的日志行里抽出摘要 */
function summarize(run) {
  const lines = run.lines;
  const errors = [];
  const warnings = [];
  const accounts = [];
  const envs = [];
  let published = 0;
  let cost = 0;
  let session = '';
  let lastTime = run.startTime;
  let endTime = '';        // 明确的收尾行（`✅ 仅视频 完成` / `❌ … 失败…`）时间

  for (const l of lines) {
    const msg = String(l.message || '').trim();
    if (l.time) lastTime = l.time;
    if (l.type === 'error') errors.push(msg);
    else if (l.type === 'warning') warnings.push(msg);

    const acc = pick(/📤 自动发布到账号:\s*(\S+)/, msg);
    if (acc && !accounts.includes(acc)) accounts.push(acc);
    // 环境只认「真的打开了哪个环境」：`🔐 … 已登录` 是调度器对**所有**账号做的预检，
    // 算进来的话每一轮都会显示十个环境（第一版就踩了这个）
    const env = pick(/🌐 打开指纹环境\s*(TK\d+)/, msg);
    if (env && !envs.includes(env)) envs.push(env);
    if (/✅\s*审查完成，视频已公开/.test(msg)) published++;
    const c = msg.match(/💰.*?¥\s*([\d.]+)/);
    if (c) cost += Number(c[1]) || 0;
    if (!session) session = pick(/📅\s*(.*?(?:am|pm)_\d{4})/, msg);
    // 收尾行：带任务名 + 完成/失败，且以 ✅/❌ 开头
    if (run.title && msg.includes(run.title) && /^[✅❌]/.test(msg) && /(完成|失败)/.test(msg)) {
      endTime = l.time;
    }
  }
  if (!envs.length) {
    // 兜底：至少显示这轮预检的那个环境
    const one = pick(/🔐\s*(TK\d+)\s*已登录/, lines.map((l) => l.message).join('\n'));
    if (one) envs.push(one);
  }

  // 明确的失败行优先（`❌ xxx 失败…`），其次看有没有成功收尾，再其次 unknown
  const failLine = errors.find((m) => /失败/.test(m)) || '';
  let result = 'unknown';
  if (failLine) result = 'error';
  else if (lines.some((l) => /✅\s*.{0,20}(完成|已公开)/.test(String(l.message || '')))) result = 'success';
  else if (errors.length) result = 'error';

  const startMs = toMs(run.startTime);
  const endMs = toMs(endTime || lastTime);
  return {
    ...run,
    endTime: endTime || lastTime,
    durationMs: endMs - startMs,
    durationText: formatDuration(endMs - startMs),
    result,
    failReason: failLine ? failLine.replace(/^❌\s*/, '').slice(0, 120) : '',
    errors,
    warnings,
    accounts,
    envs,
    published,
    cost: Math.round(cost * 10000) / 10000,
    session,
    count: lines.length,
  };
}

/**
 * @param {Array<{time:string,type:string,message:string,source:string}>} lines 已按时间排序
 * @returns {Array} 轮次列表（按时间顺序，最后一轮在最后）
 */
export function groupLogRuns(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const runs = [];
  let current = null;

  for (const l of list) {
    const msg = String(l.message || '');
    const started = msg.match(START_RE);
    if (started) {
      if (current) runs.push(current);
      current = { id: `run-${runs.length}`, title: started[1].trim(), startTime: l.time, lines: [] };
    }
    if (!current) {
      if (!runs.length) {
        // 第一轮之前的杂项：先攒一个"未归属"组，等真正出现任务再定
        current = { id: 'pre', title: '启动 / 配置（不属于任何一轮任务）', startTime: l.time, lines: [], pre: true };
      }
    }
    current.lines.push(l);
  }
  if (current) runs.push(current);

  return runs.map((r) => {
    if (r.pre) {
      const s = summarize(r);
      return { ...s, title: r.title, startTime: r.lines[0] ? r.lines[0].time : '', result: 'muted', count: r.lines.length };
    }
    return summarize(r);
  });
}

/** 界面筛选：按类型/来源过滤后，只保留还有匹配行的轮次 */
export function filterRuns(runs, { type = 'all', source = 'all' } = {}) {
  const out = [];
  for (const r of runs || []) {
    const lines = (r.lines || []).filter((l) => {
      if (type !== 'all' && l.type !== type) return false;
      if (source !== 'all' && (l.source || 'app') !== source) return false;
      return true;
    });
    if (!lines.length) continue;
    out.push({ ...r, lines, matched: lines.length });
  }
  return out;
}
