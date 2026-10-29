/**
 * 批量闹钟（一个闹钟一串账号）的纯逻辑。
 *
 * 用户口径（2026-10-29）：「我设置闹钟开始，然后选择几个账号，你就按顺序生成、发布完就完事了」。
 * 以前是「每 5 分钟一个号」的 11 个闹钟，既要算间隔又要算每轮预算；现在一个闹钟搞定。
 * 调度器只负责 spawn，顺序/文案/汇总这些能测的部分都放这里。
 */

/**
 * 把勾选的账号排成执行顺序。
 *
 * 规则：**按配置里的账号顺序**（01 → 02 → …），勾选顺序不可信（用户可能先点 05 再点 01）。
 * 配置里没有的（例如刚改名、配置没同步）排在后面，仍然执行，只是顺序按勾选顺序。
 *
 * @param {{ picks: string[], configAccounts: string[] }} args
 * @returns {string[]}
 */
export function orderBatchAccounts({ picks = [], configAccounts = [] } = {}) {
  const uniq = [];
  for (const raw of picks) {
    const name = String(raw || '').trim();
    if (name && !uniq.includes(name)) uniq.push(name);
  }
  const order = configAccounts.map((n) => String(n || '').trim()).filter(Boolean);
  if (!order.length) return uniq;
  const known = order.filter((n) => uniq.includes(n));
  const unknown = uniq.filter((n) => !order.includes(n));
  return [...known, ...unknown];
}

/**
 * 一轮批量跑完的汇总文案（日志/告警/轮次回报共用一份，口径别分叉）。
 *
 * @param {object} r
 * @param {number} r.total 队列长度
 * @param {string[]} r.done 成功
 * @param {string[]} r.failed 失败
 * @param {string[]} r.skipped 跳过（未登录 / 数据不足）
 * @param {number} r.published 确认公开的条数
 * @param {number} r.unconfirmed 点了 Post 但没确认公开的条数
 * @param {boolean} r.wantPublish 本轮是否发布了
 * @returns {string} 形如 `11 个号，成功 9，失败 1（05），跳过 1（08），发布 9 条`
 */
export function summarizeBatch(r = {}) {
  const total = Number(r.total) || 0;
  const done = Array.isArray(r.done) ? r.done : [];
  const failed = Array.isArray(r.failed) ? r.failed : [];
  const skipped = Array.isArray(r.skipped) ? r.skipped : [];
  const parts = [`${total} 个号`, `成功 ${done.length}`];
  if (failed.length) parts.push(`失败 ${failed.length}（${failed.join('、')}）`);
  if (skipped.length) parts.push(`跳过 ${skipped.length}（${skipped.join('、')}）`);
  if (r.wantPublish) parts.push(`发布 ${Number(r.published) || 0} 条`);
  if (Number(r.unconfirmed) > 0) {
    parts.push(`未确认 ${Number(r.unconfirmed)} 条（点过 Post 但没证明公开，请人工核对）`);
  }
  return parts.join('，');
}

/**
 * 整轮的结果码（轮次记录/助手回报按它说话）。
 * 有失败就是 failed；一个都没成就是 skipped；否则 ok。
 */
export function batchResult({ total = 0, done = [], failed = [] } = {}) {
  if (Array.isArray(failed) && failed.length) return 'failed';
  if (!Array.isArray(done) || !done.length) return 'skipped';
  if (Number(total) > 0 && done.length + (failed || []).length === 0) return 'skipped';
  return 'ok';
}

/**
 * 单个号的执行预算：生成 + （要发布时）发布留量。
 * 不再有"固定 45 分钟"这种和账号数无关的数字。
 */
export function perAccountBudgetMs({ engineMs, publishAllowMs, wantPublish = true }) {
  const base = Number(engineMs) > 0 ? Number(engineMs) : 0;
  const allow = Number(publishAllowMs) > 0 ? Number(publishAllowMs) : 0;
  return base + (wantPublish ? allow : 0);
}

/** 整轮预算 = 号数 × 单号预算 + 收尾余量 */
export function totalBudgetMs({ count, perAccountMs, tailMs = 0 }) {
  const n = Math.max(0, Number(count) || 0);
  const per = Math.max(0, Number(perAccountMs) || 0);
  return n * per + Math.max(0, Number(tailMs) || 0);
}
