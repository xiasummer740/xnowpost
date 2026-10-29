/**
 * 发布轮次的**总预算**分配（2026-10-29 审查发现的那个洞）。
 *
 * 原来两个预算各说各话：
 *   - 宿主（调度器）给发布子进程 45 分钟（`TIMEOUTS.publish`）；
 *   - 子进程给**每一条**视频 30 分钟（`DEFAULT_BUDGET_MS`），条数不限。
 * 于是待发 2 条时，第一条就可能吃掉 30 分钟，第二条跑到一半被宿主 SIGKILL ——
 * 窗口残留、标记没写、日志停在半句，看起来像"发布器有 bug"。
 *
 * 现在的口径：**总预算是宿主的，子进程负责分配**。
 * 每一条开跑前算一次"还剩多少"，单条预算 = min(单条上限, 剩余 - 收尾余量)；
 * 剩余不够再跑一条（< MIN_RETRY_BUDGET_MS）就明确收工，把剩下的留给下一轮，
 * 并在日志里说清"还剩几条没发"。
 *
 * 纯函数，单测 tests/unit/publish-budget.test.js。
 */

/** 收尾余量：关浏览器、写标记、落账本都要时间，不能把预算吃干 */
export const TAIL_RESERVE_MS = 4 * 60 * 1000;

/** 少于这个剩余就不值得再开一条（开了也大概率被掐在半路） */
export const MIN_ITEM_MS = 5 * 60 * 1000;

/**
 * @param {object} p
 * @param {number} p.totalBudgetMs  这一轮的硬上限（宿主超时 - 余量）
 * @param {number} p.elapsedMs      已经过的时间
 * @param {number} p.perItemCapMs   单条最多给多少（默认 30 分钟）
 * @param {number} [p.tailReserveMs]
 * @param {number} [p.minItemMs]
 * @returns {{ok:true, itemBudgetMs:number, remainingMs:number} | {ok:false, reason:string, remainingMs:number}}
 */
export function planItemBudget({
  totalBudgetMs,
  elapsedMs = 0,
  perItemCapMs,
  tailReserveMs = TAIL_RESERVE_MS,
  minItemMs = MIN_ITEM_MS,
}) {
  const total = Number(totalBudgetMs);
  const spent = Number(elapsedMs) || 0;
  const cap = Number(perItemCapMs);
  const remaining = Number.isFinite(total) && total > 0 ? total - spent : Infinity;

  // 没给总预算（命令行手动跑）→ 只用单条上限，保持老行为
  if (!Number.isFinite(remaining)) {
    return { ok: true, itemBudgetMs: Number.isFinite(cap) && cap > 0 ? cap : 30 * 60 * 1000, remainingMs: Infinity };
  }
  const usable = remaining - tailReserveMs;
  if (usable < minItemMs) {
    return { ok: false, reason: 'budget-exhausted', remainingMs: Math.max(0, remaining) };
  }
  const itemBudgetMs = Number.isFinite(cap) && cap > 0 ? Math.min(cap, usable) : usable;
  return { ok: true, itemBudgetMs: Math.round(itemBudgetMs), remainingMs: Math.round(remaining) };
}

/** 调度器要给子进程的总预算：宿主超时 - 余量（余量留给收尾、写记录、关窗口） */
export function totalFromHostTimeout(hostTimeoutMs, { slackMs = TAIL_RESERVE_MS } = {}) {
  const h = Number(hostTimeoutMs);
  if (!Number.isFinite(h) || h <= 0) return 0;
  return Math.max(0, Math.round(h - slackMs));
}

/** 从环境变量读总预算（调度器会设），没设返回 0 = 不限制 */
export function envTotalBudgetMs() {
  const n = Number(process.env.XNOWPOST_PUBLISH_TOTAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 人话时长 */
export function humanMin(ms) {
  const m = Math.round((Number(ms) || 0) / 60000);
  return `${m} 分钟`;
}
