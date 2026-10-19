// API Key 有效性预检
//
// 为什么需要这个：
//   仓库里的 `.env` 是**模板**，里面是 `sk-your-api-key-here` 这类占位符；
//   而引擎只读 process.env（不回退 user.json，那条回退由主进程注入实现）。
//   于是命令行直接跑时会拿占位符去请求，服务端只回一句
//     "401 Authentication Fails, Your api key: ****here is invalid"
//   —— 要盯很久才反应过来 "here" 是占位符的尾巴。
//   占位符检查不需要花钱，应该在调用任何 API 之前就拦下来。

// 覆盖常见占位符写法：your-api-key / xxx / placeholder / 中文提示语等
const PLACEHOLDER_PATTERNS = [
  /your[-_ ]?api/i,
  /^your[-_ ]/i,
  /api[-_ ]?key[-_ ]?here/i,
  /^sk-your/i,
  /here$/i,
  /^x{4,}$/i,
  /placeholder/i,
  /change[-_ ]?me/i,
  /example/i,
  /填入/,
  /拿到/,
  /待填/,
  /下轮加/,
];

/** 值是否"看起来是占位符"（空值不算占位符，那是"未配置"） */
export function looksLikePlaceholder(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return false;
  return PLACEHOLDER_PATTERNS.some(re => re.test(v));
}

/**
 * 校验一个 Key。
 * @returns {{ok: boolean, value?: string, reason?: string}}
 */
export function validateApiKey(value, label) {
  const v = String(value == null ? '' : value).trim();
  if (!v) {
    return { ok: false, reason: `${label} 未配置` };
  }
  if (looksLikePlaceholder(v)) {
    // 只回显前 8 个字符，避免把疑似真实 Key 打进日志
    const head = v.length > 8 ? `${v.slice(0, 8)}…` : v;
    return {
      ok: false,
      reason: `${label} 是占位符而不是真实 Key（值以「${head}」开头），请求一定会 401`,
    };
  }
  return { ok: true, value: v };
}

/** 批量校验，返回失败原因数组（空数组 = 全部通过） */
export function validateApiKeys(list) {
  const problems = [];
  for (const { value, label } of list) {
    const r = validateApiKey(value, label);
    if (!r.ok) problems.push(r.reason);
  }
  return problems;
}
