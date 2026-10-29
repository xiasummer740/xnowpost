/**
 * 串行队列：定时任务「一个接一个跑」，不丢轮、不并发。
 *
 * 为什么需要（2026-10-29 审查发现）：
 * 调度器原来用 `spawnSync` 跑任务 —— 跑的时候整个事件循环被占死，而 node-cron 只在
 * 「当前这一秒」触发回调。于是上一轮跨过下一轮的分钟，**那一轮当天直接消失**
 * （不排队、不补跑、日志里也没有任何痕迹）。实测 08:50 那轮跑了 4 分 16 秒，
 * 距下一轮 08:55 只剩 44 秒；凌晨批次是 11 个号每 5 分钟一个，任一轮超 5 分钟
 * 就有一个号当天没有视频，而且看起来像"本来就没这个任务"。
 *
 * 现在：`spawn` 异步跑（事件循环不被占死 → cron 一定按时触发），触发的任务进队列，
 * 前一个结束再跑下一个。宁可晚几分钟，也不能静默少发一条。
 *
 * 纯逻辑、无 IO，单测在 tests/unit/serial-queue.test.js。
 */

/**
 * @param {{ onQueued?: (depth:number, meta:any) => void }} [opts]
 *        onQueued：有任务在排队时回调（用于写「已排队，前面还有 N 个」的日志）
 */
export function createSerialQueue(opts = {}) {
  const { onQueued } = opts;
  let tail = Promise.resolve();
  let depth = 0;      // 正在跑 + 已排队
  let maxSeen = 0;

  return {
    /** 当前积压（含正在跑的那一个） */
    get depth() { return depth; },
    /** 历史最大积压，便于事后看"这轮到底排了多少" */
    get maxSeen() { return maxSeen; },

    /**
     * 入队一个任务。返回的 Promise 就是该任务的最终结果（失败会 reject）。
     * 注意：即使 fn 抛错，队列本身也不会卡住（内部吞掉异常继续下一个）。
     */
    push(fn, meta = null) {
      depth += 1;
      if (depth > 1) {
        maxSeen = Math.max(maxSeen, depth);
        if (typeof onQueued === 'function') {
          try { onQueued(depth - 1, meta); } catch (_) { /* 日志失败不影响队列 */ }
        }
      }
      const run = tail.then(() => fn());
      // 队列自身永不 reject：否则一次失败会把后面的任务全部带崩
      tail = run.then(() => {}, () => {}).finally(() => { depth -= 1; });
      return run;
    },
  };
}
