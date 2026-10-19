/**
 * 「这次发布要发到哪个账号」——渲染进程侧的唯一实现（纯函数 + 单测）。
 *
 * 背景（2026-10-19）：首页「发布」按钮原来只能发 accounts[0]，用户想发 02 号没有任何入口，
 * 助手于是也照着 accounts[0] 发 → 「让发 TK02，结果发到 TK01」。
 * 现在界面上有「发到」下拉，这里负责把它翻译成 `publish:run` 的 opts，
 * 并且**确认卡上的文案和真正发出去的目标必须来自同一个函数**（否则又是"看到的和做的不是一回事"）。
 */

/**
 * 组 `publish:run` 的参数。
 * @param {{target?: string, includeOld?: boolean}} input target = 账号 name（'02'），空 = 按配置第一个
 * @returns {{account?: string, includeOld?: boolean}}
 */
export function buildPublishOpts(input = {}) {
  const opts = {};
  if (input.includeOld) opts.includeOld = true;   // 只在明确勾选时带（旧会话必须显式放行）
  const account = String(input.target ?? '').trim();
  if (account) opts.account = account;
  return opts;
}

/**
 * 确认卡/按钮上显示的目标，例如「账号 02（TK02）」「默认账号（01）」。
 * @param {Array<{name?: string, browserEnv?: string, bitEnvId?: string}>} accounts
 * @param {string} target
 */
export function publishTargetLabel(accounts, target) {
  const list = Array.isArray(accounts) ? accounts.filter((a) => a && a.name) : [];
  const name = String(target ?? '').trim();
  // 三种来源都认：配置原始账号（browserEnv / bitEnvId）、publishTargetOptions 的输出（env）。
  // 踩过：只读前两个字段，而界面传进来的是 {name, env} → 确认卡显示「未绑定环境」。
  const envOf = (a) => String(a?.browserEnv || a?.bitEnvId || a?.env || '').trim();

  if (!name) {
    const first = list[0];
    return first ? `默认账号（${first.name}）` : '默认账号';
  }
  const hit = list.find((a) => String(a.name).trim() === name);
  if (!hit) return `账号 ${name}`;   // 配置里没有：照实说，别假装有环境
  const env = envOf(hit);
  return env ? `账号 ${hit.name}（${env}）` : `账号 ${hit.name}（未绑定环境）`;
}

/** 下拉选项：默认项 + 每个账号 */
export function publishTargetOptions(accounts) {
  const list = Array.isArray(accounts) ? accounts.filter((a) => a && a.name) : [];
  const first = list[0];
  return {
    defaultLabel: first ? `默认账号（${first.name}）` : '默认账号',
    options: list.map((a) => ({
      name: String(a.name).trim(),
      env: String(a.browserEnv || a.bitEnvId || '').trim(),
    })),
  };
}

/**
 * 勾选模式：把界面选中的行变成 `publish:run` 的 `pick`（`date/session`）。
 * 空数组 = 没勾，按"条数 + 顺序"发。
 * @param {Array<{date?: string, session?: string}>} items 勾选的行
 */
export function buildPickKeys(items) {
  const list = Array.isArray(items) ? items : [];
  const keys = [];
  for (const it of list) {
    const date = String(it?.date ?? '').trim();
    const session = String(it?.session ?? '').trim();
    if (!session) continue;
    const key = date ? `${date}/${session}` : session;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * 这一轮到底发几条、发哪些 —— 确认卡和真正执行共用这一份判断。
 * @param {{pick?: Array, count?: number|'all', total?: number, eligible?: number}} input
 *   total    = 当天待发条数（用于文案）
 *   eligible = 本次实际可能发出去的条数（勾了「含旧会话」时比 total 大；默认等于 total）
 * @returns {{mode: 'pick'|'all'|'count', count: number, send: number, detail: string}}
 */
export function describePublishPlan(input = {}) {
  const picked = buildPickKeys(input.pick);
  const total = Number(input.total) || 0;
  const eligibleRaw = Number(input.eligible);
  const eligible = Number.isFinite(eligibleRaw) && eligibleRaw >= 0 ? eligibleRaw : total;

  if (picked.length) {
    return { mode: 'pick', count: picked.length, send: picked.length, detail: `只发勾选的 ${picked.length} 条` };
  }
  if (input.count === 'all') {
    return {
      mode: 'all',
      count: -1,
      send: eligible,
      detail: `发全部 ${eligible} 条待发（不限条数）`,
    };
  }
  const n = Number(input.count);
  const count = Number.isFinite(n) && n > 0 ? n : 3;
  // 「发 1 条」但今天一条都没有时，真实结果是发 0 条 —— 按钮上必须显示这个数，
  // 否则用户会以为点下去会发一条（2026-10-19 首页按钮统一文案时定的口径）。
  const send = Math.min(count, eligible);
  return { mode: 'count', count, send, detail: `按顺序发前 ${count} 条（不勾选时默认），本轮实际发 ${send} 条` };
}