/**
 * 定时任务 id 的唯一实现（界面 / 主进程 / 迁移脚本共用）。
 *
 * 为什么单独抽出来（2026-10-19 用户提的「编码能统一一下吗」）：
 * 老版本新建任务用过 `Date.now()` 当 id，于是 `config/schedule.json` 里同时出现
 * `1 / 2 / 102` 和 `1783852240727` 这种 13 位数字 —— 两种编码混在一份配置里，
 * 看日志、看审计账本、跟人沟通都容易把「任务编号」误认成「账号」。
 *
 * 现在定的口径（改这里等价于改全局约定）：
 *   · id 一律是 **1~999 的整数**，纯序号，不含时间/账号信息（时间和账号是可改的，
 *     写进 id 就一定会名不符实）；
 *   · **只增不改**：已经存在的合法 id 永远保留（任务改名、改时间都不换号），
 *     新任务 = 当前最大号 + 1；
 *   · 重复 / 非法（0、负数、非数字、> 999 的老时间戳）/ 越界 → 重新发号，
 *     仍然不覆盖任何合法 id。
 *
 * 历史迁移（把 13 位时间戳换成序号）是**一次性脚本**，不在运行时自动做 ——
 * 运行时只修「坏 id」，不对好 id 大规模重排（否则每次打开定时页都可能换号）。
 */

/** id 上限：3 位数，够用一辈子，也让「id 不是账号号」这件事一眼看得出来 */
export const MAX_JOB_ID = 999;

/** 这个 id 能不能直接用（合法 = 正整数、而且不超过上限） */
export function isValidJobId(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return false;
  if (!Number.isInteger(n)) return false;
  return n >= 1 && n <= MAX_JOB_ID;
}

/**
 * 修坏 id：保留首次出现的合法 id，重复/非法的重新发号（> 当前最大值），
 * **原地修改**传入的对象并返回当前最大 id。
 * @param {Array<object>} list
 * @returns {number} 当前最大 id（供 nextJobId 继续发号）
 */
export function reconcileJobIds(list) {
  const arr = Array.isArray(list) ? list : [];
  let max = 0;
  for (const job of arr) {
    if (job && isValidJobId(job.id)) max = Math.max(max, Number(job.id));
  }
  const seen = new Set();
  for (const job of arr) {
    if (!job) continue;
    const n = Number(job.id);
    if (isValidJobId(n) && !seen.has(n)) {
      job.id = n;
      seen.add(n);
      continue;
    }
    let next = max + 1;
    while (seen.has(next)) next += 1;
    job.id = next;
    max = Math.max(max, next);
    seen.add(next);
  }
  return max;
}

/**
 * 下一个可用 id = 当前最大值 + 1；到顶（999）时回收最小的空号。
 * 为什么到顶要回收：宁可复用空号，也不许再冒出四位数/时间戳，编码一旦破例就回不去了。
 * @param {Array<object>} list
 * @param {number} [seq] 调用方缓存的最大值
 */
export function nextJobId(list, seq = 0) {
  const arr = Array.isArray(list) ? list : [];
  let max = Number.isFinite(Number(seq)) ? Math.max(0, Number(seq)) : 0;
  const used = new Set();
  for (const job of arr) {
    const n = Number(job && job.id);
    if (isValidJobId(n)) {
      used.add(n);
      max = Math.max(max, n);
    }
  }
  const next = max + 1;
  if (next <= MAX_JOB_ID) return next;
  for (let i = 1; i <= MAX_JOB_ID; i += 1) {
    if (!used.has(i)) return i;
  }
  throw new Error(`定时任务数量已达上限（${MAX_JOB_ID} 个）`);
}

/**
 * 一次性迁移用的发号顺序（id 一旦定下就永不变，所以这个顺序只影响迁移那一刻）：
 *   ① 启用中的排前面 —— 真正在跑的任务拿小号，用户说「08:30 那个」时和 `#1` 对得上；
 *   ② 同为启用时，「跑内容的」（video/auto）在「采集」之前；
 *   ③ 同组按时间升序；时间相同再按账号。
 * 结果（2026-10-19 实际迁移）：08:30–09:15 十个视频任务 = 1–10（正好对应账号 01–10），
 * 10:00 采集 = 11，剩下 9 个停用的老任务 = 12–20。
 */
export function jobSortKey(job) {
  const j = job || {};
  const disabled = j.enabled === false ? 1 : 0;
  const isCollect = j.mode === 'collect' ? 1 : 0;
  const t = String(j.time || '99:99');
  return [disabled, isCollect, t, String(j.account || '')];
}

/**
 * 把整份列表重排成 1..N（**只给迁移脚本用**，运行时不调）。
 * @returns {{jobs: Array<object>, before: Array<{id:any, time:string, mode:string, account:string}>, after: Array<{id:number, oldId:any, time:string, mode:string, account:string}>}}
 */
export function renumberJobs(list) {
  // 数组顺序**保持原样**：迁移应该只改 id 字段，diff 里其他行一个字都不动（便于人工核对）
  const arr = (Array.isArray(list) ? list : []).filter(Boolean).map((j) => ({ ...j }));
  const before = arr.map((j) => ({ id: j.id, time: j.time, mode: j.mode, account: j.account }));
  const order = arr.map((_, i) => i).sort((ia, ib) => {
    const ka = jobSortKey(arr[ia]);
    const kb = jobSortKey(arr[ib]);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] < kb[1] ? -1 : 1;
    return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
  });
  const after = [];
  order.forEach((idx, n) => {
    const j = arr[idx];
    const oldId = j.id;
    j.id = n + 1;
    after.push({ id: j.id, oldId, time: j.time, mode: j.mode, account: j.account });
  });
  return { jobs: arr, before, after };
}
