/**
 * 「检查到底通过没通过」怎么说话 —— 单独一个小模块，纯函数、可单测。
 *
 * 为什么需要它（2026-10-19 22:17 实测 pm_2214）：
 *   日志先打「⏭️ 检查还在跑但 Post 已可点（等了 90s），放行发布」，
 *   紧接着又打「⏳ 检查已通过，等 3s 后发布」—— 同一件事两种结论。
 *   复盘时只看第二句会以为「检查正常通过」，其实是超时放行。
 *
 * 口径：**放行 ≠ 通过**。只有两项都真的出现「未发现问题」才算通过；
 * 等够 CHECKS_MAX_WAIT 就发，必须说「未完成（超时放行）」。
 */

/**
 * @param {boolean} timedOut 是否是"等够时间就放行"（检查没跑完）
 * @param {number} waitedSec 实际等了多久（秒）
 * @returns {string} 一行日志（不含缩进）
 */
export function releaseMessage(timedOut, waitedSec) {
  const sec = Number.isFinite(Number(waitedSec)) ? Math.max(0, Math.round(Number(waitedSec))) : 0;
  if (timedOut) {
    return `⏳ 检查未完成（等了 ${sec}s 就放行），等 3s 后发布...`;
  }
  return '⏳ 检查已通过，等 3s 后发布...';
}

/**
 * 超时放行时额外提醒一句：点 Post 后 TikTok 可能再弹一次「Continue to post?」。
 * 这句不是噪音 —— 它把"后面会弹框"提前说清楚，人工看日志时不会以为卡住了。
 */
export function releaseNote(timedOut) {
  return timedOut ? '注意：这次不是"检查通过"，是超时放行 —— 点 Post 后 TikTok 可能再弹「Continue to post?」' : '';
}
