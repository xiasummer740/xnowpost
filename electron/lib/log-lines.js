/**
 * 日志行的解析 / 分类 / 合并（纯函数，可单测）
 *
 * 为什么单独抽出来：日志有两个来源，格式还不一样
 *   ① 应用日志 `logs/app-<日期>.log`：`[2026/10/19 10:45:07] [INFO] 消息`
 *   ② 调度器日志 `logs/scheduler-<日期>.log`：`[2026-10-19 10:45:01]   消息`（**没有级别**）
 * 而且应用日志会把调度器的输出再"回声"一遍（消息以 `⏰` 开头），直接合并会重复两万行。
 * 2026-10-19 用户反馈「运行日志只能看到这几行」——真因就是只读了 app 日志的内存缓冲。
 */

const LEVEL_MAP = {
  INFO: 'info',
  DEBUG: 'info',
  TRACE: 'info',
  SUCCESS: 'success',
  OK: 'success',
  WARN: 'warning',
  WARNING: 'warning',
  ERROR: 'error',
  FATAL: 'error',
};

/**
 * 判定一行日志的类型。
 * 调度器日志没有级别标签，只能靠内容里的符号/关键词判断 ——
 * 这也是界面「✅ 成功 / ❌ 错误」筛选能不能用的关键。
 */
export function classifyLevel(level, message) {
  const known = LEVEL_MAP[String(level || '').toUpperCase()];
  if (known) return known;
  const m = String(message || '').trim();
  // ⚠️ 必须**先看行首的表情**，再看关键词。反例（今天真实踩到）：
  //    `🗣️ 先做配音（失败则一分钱不花在生图上）...` 只是提了一句"失败"，被判成错误 →
  //    10 轮任务在界面上全变成「❌ 失败」，实际全都发布成功了。
  //    `⚠️ 日报未确认送达：TG 未配置或推送失败（…）` 是警告，不是错误。
  //
  // 🐛 坑：**不要写 `/^[🔶]/` 这种 emoji 字符类** —— 没有 `u` 标志时 `🔶` 会被拆成
  //    两个代理半区（\uD83D\uDED6），于是**所有 U+1F5xx 开头的 emoji 都会被它匹配**
  //    （`🗣️`、`📤` 全都算），判定直接串味。这里改成按「第一个码位」比对字符串。
  // ⚠️ 另一个坑：`'⚠❗🔶'.includes('')` **恒为 true**（空串是任何字符串的子串），
  //    所以必须先判 head 非空，否则空消息会被判成 warning。
  const head = [...m][0] || '';
  if (head && '⚠❗🔶🚫'.includes(head)) return 'warning';   // 🚫 = 被拦下重写，不是失败
  if (head && '❌✖✗⛔'.includes(head)) return 'error';
  if (head && '✅✔☑'.includes(head)) return 'success';
  // 没有表情前缀时，只认明确表示失败的写法（`失败：`/`Error:`/`FAILED`…），
  // 别用裸「失败」「超时」——它们经常出现在正常行的括号/从句里。
  if (/失败[:：]|FAILED|FATAL|Error:|Exception:|timed out/i.test(m)) return 'error';
  if (/警告|重试|未配置|未确认/.test(m)) return 'warning';
  if (/完成！|已发布|已公开/.test(m)) return 'success';
  return 'info';
}

/** `2026/10/19 10:45:07` 或 `2026-10-19 10:45:01` → 可比较的 key（同时用于显示） */
export function normalizeTime(raw) {
  const s = String(raw || '').trim().replace(/\//g, '-');
  return s;
}

/**
 * 解析一整份日志文本
 * @param {string} text 文件内容
 * @param {'app'|'scheduler'} source 来源（界面用它区分颜色/标签）
 * @returns {Array<{time:string, key:string, type:string, message:string, source:string}>}
 */
export function parseLogText(text, source = 'app') {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^\[(.+?)\]\s*\[(\w+)\]\s*([\s\S]*)$/);
    if (m) {
      const time = normalizeTime(m[1]);
      out.push({ time, key: time, type: classifyLevel(m[2], m[3]), message: m[3], source });
      continue;
    }
    const m2 = line.match(/^\[(.+?)\]\s*([\s\S]*)$/);
    if (m2) {
      const time = normalizeTime(m2[1]);
      const message = m2[2].replace(/^\s+/, '');
      out.push({ time, key: time, type: classifyLevel('', message), message, source });
      continue;
    }
    out.push({ time: '', key: '', type: classifyLevel('', line), message: line, source });
  }
  return out;
}

/**
 * 去掉应用日志里"回声"调度器的那部分。
 * 应用日志会把调度器输出加上 `⏰` 前缀再写一遍，合并时留着就是每条都出现两次。
 */
export function dropEchoedSchedulerLines(lines) {
  return (lines || []).filter((l) => !(l.source === 'app' && /^⏰/.test(String(l.message || '').trim())));
}

/**
 * 合并多份日志并按时间排序（同一秒内保持各自原有顺序，app 在前）
 * @param {Array<Array>} lists
 * @param {number} limit 只保留最后 N 行
 */
export function mergeLogLines(lists, limit = 2000) {
  const all = [];
  let seq = 0;
  for (const list of lists || []) {
    for (const item of list || []) all.push({ ...item, _seq: seq++ });
  }
  all.sort((a, b) => {
    if (a.key === b.key) return a._seq - b._seq;
    if (!a.key) return 1;      // 没有时间的行（罕见）排最后
    if (!b.key) return -1;
    return a.key < b.key ? -1 : 1;
  });
  const sliced = limit > 0 && all.length > limit ? all.slice(-limit) : all;
  return sliced.map(({ _seq, ...rest }) => rest);
}
