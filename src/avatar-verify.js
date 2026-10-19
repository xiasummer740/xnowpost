/**
 * 「保存后头像到底换没换」的复查策略。
 *
 * 2026-10-19 实测的教训：改完资料点完 Save，TikTok 返回 "Profile has been updated"，
 * 但**主页的头像 URL 要几十秒才刷新**。老实现保存后固定等 7 秒读一次就下结论，
 * 结果是 4 个号里 3 个被误判成「头像地址没变（大概率没真正保存）」——其实全成功了，
 * 事后读线上头像 URL 全都变了。
 *
 * 所以判据只能这样定：**给一段时间反复读**，读到变了就是成功；
 * 直到超时都没变才提示"可能延迟"。宁可说"稍后再看"，也不能把成功说成失败。
 */

/** 头像 URL 去掉查询串（TikTok 的签名参数每次都变，只有路径稳定） */
export function avatarKey(url) {
  return String(url || '').split('?')[0];
}

/** 是否是「真的变了一个头像」（任一侧为空都不算变） */
export function avatarReallyChanged(beforeUrl, afterUrl) {
  const a = avatarKey(beforeUrl);
  const b = avatarKey(afterUrl);
  if (!a || !b) return false;
  return a !== b;
}

/**
 * 下次还要不要继续复查？
 *
 * @param {object} o
 * @param {string} o.beforeUrl 保存前的头像 URL
 * @param {string} o.afterUrl  本次读到的头像 URL
 * @param {number} o.elapsedMs 从点完 Save 到现在过了多久
 * @param {number} [o.timeoutMs] 最多等多久（默认 45 秒）
 * @param {number} [o.attempt]   已经读了几次（从 1 开始，只用于日志）
 * @returns {{ done: boolean, changed: boolean, reason: 'changed'|'timeout'|'pending' }}
 */
export function avatarReadbackPlan({ beforeUrl, afterUrl, elapsedMs, timeoutMs = 45000 }) {
  const changed = avatarReallyChanged(beforeUrl, afterUrl);
  if (changed) return { done: true, changed: true, reason: 'changed' };
  if (!Number.isFinite(elapsedMs) || elapsedMs >= timeoutMs) {
    return { done: true, changed: false, reason: 'timeout' };
  }
  return { done: false, changed: false, reason: 'pending' };
}

/** 复查间隔：前面密一点（可能几秒就好），后面稀一点 */
export function avatarRetryDelayMs(attempt) {
  const n = Math.max(1, Number(attempt) || 1);
  if (n <= 3) return 4000;
  if (n <= 6) return 6000;
  return 8000;
}
