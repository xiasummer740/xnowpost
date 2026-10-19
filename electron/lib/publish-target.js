/**
 * 「这条要发到哪个账号」——唯一实现（纯函数 + 单测）。
 *
 * 为什么单独拎出来（2026-10-19 真实事故）：
 *   用户让助手「TK02 也发布一条视频」，助手跑了生成、又跑了发布，结果发到了 **TK01**。
 *   根因不是模型胡说，而是 `publish:run` 这条链路**只认 accounts[0]**：
 *   `const envId = config.accounts[0].bitEnvId`，opts 里给什么都没用。
 *
 * 现在的口径（不许再退化）：
 *   ① 用户/助手点名了账号（`account` = 定时页那种 name，如 "02"）或环境（`env` = "TK02"），
 *      **必须**解析到这个账号；解析不到就**失败**，绝不静默回落到第一个账号；
 *   ② 什么都没指定才用 accounts[0]，并且调用方要把"发到默认账号"明说给用户看；
 *   ③ name 允许 "2" / "02" 两种写法（用户嘴上说「02 号」）。
 */

/**
 * @param {Array} accounts 配置里的 accounts 数组
 * @param {{account?: string, env?: string}} want
 * @returns {{ok: boolean, envId?: string, name?: string, explicit?: boolean, error?: string}}
 */
export function resolvePublishTarget(accounts, want = {}) {
  const list = Array.isArray(accounts) ? accounts.filter(Boolean) : [];
  const account = String(want.account ?? '').trim();
  const env = String(want.env ?? '').trim().toUpperCase();
  const envOf = (a) => String(a?.browserEnv || a?.bitEnvId || '').trim();
  const nameOf = (a) => String(a?.name ?? '').trim();

  if (!account && !env) {
    const first = list[0];
    const envId = first ? envOf(first) : '';
    if (!envId) return { ok: false, error: '未配置指纹浏览器环境名（配置页 → 账号）' };
    return { ok: true, envId, name: nameOf(first), explicit: false };
  }

  if (account) {
    const wanted = /^\d+$/.test(account) ? account.padStart(2, '0') : account;
    const hit = list.find((a) => nameOf(a) === wanted || nameOf(a) === account);
    if (!hit) {
      const have = list.map(nameOf).filter(Boolean).join('、') || '（空）';
      return { ok: false, error: `配置里没有账号 ${account}（现有：${have}）` };
    }
    const envId = envOf(hit);
    if (!envId) return { ok: false, error: `账号 ${nameOf(hit)} 没绑定指纹环境（配置页 → 账号 → 环境名）` };
    return { ok: true, envId, name: nameOf(hit), explicit: true };
  }

  const hit = list.find((a) => envOf(a).toUpperCase() === env);
  if (!hit) {
    const have = list.map((a) => envOf(a).toUpperCase()).filter(Boolean).join('、') || '（空）';
    return { ok: false, error: `配置里没有环境 ${env}（现有：${have}）` };
  }
  const envId = envOf(hit);
  if (!envId) return { ok: false, error: `环境 ${env} 没有可用的指纹环境名` };
  return { ok: true, envId, name: nameOf(hit), explicit: true };
}

/** 给日志/预备用的一句话 */
export function describePublishTarget(t) {
  if (!t || t.ok === false) return t?.error || '目标账号未确定';
  return t.explicit ? `账号 ${t.name}（${t.envId}）` : `默认账号 ${t.name}（${t.envId}）`;
}
