/**
 * 发布耗时预算（P2-5）
 *
 * 问题：TikTok 发布核心内部的等待循环最坏情况约 33 分钟
 * （上传 3min + 检查 15min + 转场 2.5min + 视频渲染 2.5min + 审查 10min），
 * 再加上最多 3 次重试就更长；而宿主（调度器 execSync / 主进程）只给 15 分钟。
 * 于是进程会在发布中途被强杀：比特窗口残留、标记可能没写、下一轮重复上传。
 *
 * 解决：把"总耗时预算"显式化，交给调用方传（budgetMs）。
 * 每个等待循环都检查预算，超了就**提前、明确地结束**并给出"未确认"结果，
 * 而不是无限等下去最后被外面杀掉。
 */

/** 默认预算：30 分钟（调用方应传 ≤ 宿主超时的值） */
export const DEFAULT_BUDGET_MS = 30 * 60 * 1000;

/** 重试至少要留这么多预算才值得再跑一轮，否则直接放弃（避免又被杀在半路） */
export const MIN_RETRY_BUDGET_MS = 5 * 60 * 1000;

/** 从环境变量读预算（可选）：XNOWPOST_PUBLISH_BUDGET_MS */
export function envBudgetMs() {
  const n = Number(process.env.XNOWPOST_PUBLISH_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_MS;
}

/**
 * 预算耗尽 —— 明确的"未确认"结果。
 * posted=true 表示**已经点过发布按钮**：这种情况下绝不能重试/重发。
 */
export class BudgetExceededError extends Error {
  constructor(message, { posted = false } = {}) {
    super(message);
    this.name = 'BudgetExceededError';
    this.posted = posted;
    this.confirmed = false;
  }
}

export function createDeadline(budgetMs) {
  const total = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : DEFAULT_BUDGET_MS;
  const startedAt = Date.now();
  return {
    total,
    startedAt,
    elapsed: () => Date.now() - startedAt,
    remaining: () => Math.max(0, total - (Date.now() - startedAt)),
    exceeded: () => Date.now() - startedAt >= total,
    describe() {
      return `${(this.elapsed() / 60000).toFixed(1)}/${(total / 60000).toFixed(1)} 分钟`;
    },
  };
}

/** 预算已耗尽则抛错（stage 用于说明卡在哪一步） */
export function assertBudget(deadline, stage, { posted = false } = {}) {
  if (!deadline || typeof deadline.exceeded !== 'function') return;
  if (!deadline.exceeded()) return;
  const tail = posted
    ? '，且已点击发布按钮 → **结果未确认**（标记已写，不会重复上传）'
    : '，尚未发布';
  throw new BudgetExceededError(
    `发布耗时预算已用尽（${deadline.describe()}），卡在「${stage}」${tail}`,
    { posted }
  );
}

/**
 * 受预算约束的等待：按 5 秒分片等待，每片之前检查预算。
 * 用 page.waitForTimeout（而不是 setTimeout）以免与页面关闭竞态。
 */
export async function budgetedWait(page, ms, deadline, stage, opts = {}) {
  const CHUNK = 5000;
  let left = ms;
  while (left > 0) {
    assertBudget(deadline, stage, opts);
    const slice = Math.min(CHUNK, left);
    await page.waitForTimeout(slice);
    left -= slice;
  }
}
