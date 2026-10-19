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
  const envOf = (a) => String(a?.browserEnv || a?.bitEnvId || '').trim();

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
