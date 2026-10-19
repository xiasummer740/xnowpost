/**
 * AI 服务错误的人话翻译（DeepSeek / 硅基流动 / Pexels 等"测试连接"共用）。
 *
 * 为什么需要：
 *   2026-10-19 用户点「测试」看到的是
 *   `DeepSeek ❌ Invalid response body while trying to fetch https://api.deepseek.com/chat/completions: Premature close`
 *   —— 同一把 Key 我连打 5 次全通（0.4~0.9s），那只是**传输中途断了**，
 *   跟 Key 无效、余额不足完全是两回事，但界面上看不出区别，用户会以为 Key 坏了。
 *
 * 口径：先按 HTTP 状态码分（最可靠），再按错误文本兜底；每条都带"是不是该重试"的暗示。
 */

/** 网络层瞬时故障的特征（重试一次通常就好） */
const TRANSIENT_RE = /premature close|econnreset|ecONNrefused|socket hang up|other side closed|und_err|network|fetch failed|aborted/i;
/** 超时特征 */
const TIMEOUT_RE = /etimedout|timed out|timeout|超时/i;
/** DNS / 完全不通 */
const DNS_RE = /enotfound|eai_again|getaddrinfo|dns/i;

/**
 * @param {any} err 捕获到的错误（openai SDK / axios 都可以）
 * @param {object} [opts]
 * @param {string} [opts.provider] 展示用名字，如 'DeepSeek'
 * @param {number} [opts.elapsedMs] 实际耗时（毫秒）
 * @param {number} [opts.attempts] 一共尝试了几次（>1 表示已经自动重试过）
 * @returns {string} 给界面看的一句话
 */
export function describeAiError(err, opts = {}) {
  const { provider = 'AI 服务', elapsedMs = 0, attempts = 1 } = opts;
  const status = Number(err && (err.status || err.statusCode || err.response?.status)) || 0;
  const raw = String((err && (err.message || err)) || '').trim();
  const detail = raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;

  // 已尝试几次 / 花了多久，统一附在末尾（时间是最有用的排查线索）
  const secs = elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(1)}s` : '';
  const retried = attempts > 1 ? `，已重试 ${attempts - 1} 次` : '';
  const tail = secs || retried ? `（${[secs && `耗时 ${secs}`, retried.replace(/^，/, '')].filter(Boolean).join('，')}）` : '';

  if (!raw && !status) return `${provider} ❌ 未知错误${tail}`;

  if (status === 401 || status === 403) {
    return `${provider} ❌ Key 无效或没有权限（HTTP ${status}）：到服务商控制台核对 Key，别带空格${tail}`;
  }
  if (status === 402) {
    return `${provider} ❌ 余额不足（HTTP 402）：先充值再试，Key 本身是好的${tail}`;
  }
  if (status === 429) {
    return `${provider} ❌ 请求过快被限流（HTTP 429）：等十几秒再点一次${tail}`;
  }
  if (status === 400 && /model|模型/i.test(raw)) {
    return `${provider} ❌ 这个模型名不被接受（HTTP 400）：检查「模型」下拉里选的是否存在${tail}`;
  }
  if (status >= 500) {
    return `${provider} ❌ 服务端错误（HTTP ${status}）：不是你的配置问题，过几分钟再试${tail}`;
  }
  if (TIMEOUT_RE.test(raw) || /timeout/i.test(String((err && err.name) || ''))) {
    return `${provider} ❌ 超时没有响应${tail}：网络慢或服务商排队，再点一次测试`;
  }
  if (DNS_RE.test(raw)) {
    return `${provider} ❌ 连不上服务器（DNS/网络不通）${tail}：检查网络或代理`;
  }
  if (TRANSIENT_RE.test(raw)) {
    // 这条最容易误判成"Key 坏了"，所以专门写清楚
    return `${provider} ❌ 传输中途断开（不是 Key 的问题，可以再点一次）${tail}`;
  }
  return `${provider} ❌ ${detail}${tail}`;
}
