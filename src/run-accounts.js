/**
 * 从一轮任务的输出里认出「哪个号成了、哪个号没成」。
 *
 * 为什么要有这个文件（2026-11-01 用户口径）：
 *   首页要一张「已完成任务 + 完成情况」的表，得能逐号说清成功/失败。
 *   这些信息以前只存在于 `logs/scheduler-<日期>.log` 的文字里 —— 主进程要展示，
 *   只能去 grep 日志文本，而日志措辞随时会改（CLAUDE.md 明令不许靠日志文字判成败）。
 *   所以：调度器跑完时**顺手把逐号结论解析成数据**写进轮次记录（`accounts` 字段），
 *   界面只读记录。日志怎么改措辞，这里跟着改一处即可。
 *
 * ⚠️ 只解析**明确的行首图标**（✅ / ⚠️ / ❌），和 `electron/lib/log-lines.js` 同一套规矩：
 *   别按「行里出现失败两个字」判断（`不算推送失败` 这种会误判）。
 * ⚠️ 必须排除 `🌐 打开指纹环境 / ✅ 指纹环境 TK05 已关闭` 这类环境开关行：
 *   它们同样以 ✅ 开头、同样带 TKxx，混进来会把刚失败的号"覆盖成成功"。
 */

const LEVEL_BY_ICON = new Map([
  ['✅', 'ok'],
  ['⚠', 'warn'],
  ['❌', 'error'],
]);

/** 行首第一个码位（不能用字符类：⚠️ 的变体选择符会把 emoji 拆开，见 log-lines.js 的坑） */
function headOf(line) {
  return [...line][0] || '';
}

function levelOf(line) {
  return LEVEL_BY_ICON.get(headOf(line)) || '';
}

/** 环境开关行，一律不算「这个号跑了什么」 */
const NOISE = /指纹环境|已启动|已关闭|窗口缩到任务栏/;

/**
 * 一行 → { env, level, text } 或 null
 *
 * 认这三种写法（都来自实测日志）：
 *   养号  `✅ TK01 看了 40 条（真播 40 条，共 562 秒） · 赞4`
 *   养号  `⚠️ TK05 看了 4 条（真播 3 条，共 38 秒） · 无动作 · 卡住11次`
 *   养号  `❌ TK09 养号失败：环境 TK09 的浏览器进程起来了，但页面 150 秒都没就绪…`
 *   批量  `✅ 批量 · 账号 01（1/11） 完成` / `❌ 批量 · 账号 01（1/11） 失败：…`
 *   采集  `✅ 01: {"views":4,…} (@xnow.matrix)` / `❌ 03: …`
 */
export function parseAccountLine(raw) {
  const line = String(raw || '').replace(/^\[[^\]]*\]\s*/, '').trim();   // 去掉日志时间戳
  if (!line) return null;
  const level = levelOf(line);
  if (!level) return null;
  if (NOISE.test(line)) return null;

  // ① 养号 / 发布这类按环境名报的
  let m = line.match(/^(?:✅|⚠️?|❌)\s*(TK\d{2})\b/);
  if (m) return { env: m[1], level, text: clip(line) };

  // ② 批量：`✅ 批量 · 账号 01（1/11） 完成`
  m = line.match(/^(?:✅|⚠️?|❌)\s*批量\s*·\s*账号\s*(\d{1,2})/);
  if (m) return { env: 'TK' + String(m[1]).padStart(2, '0'), level, text: clip(line) };

  // ③ 采集：`✅ 01: {…}`（两位数账号序号 + 冒号）
  m = line.match(/^(?:✅|⚠️?|❌)\s*(\d{2}):\s/);
  if (m) return { env: 'TK' + m[1], level, text: clip(line) };

  return null;
}

function clip(s, n = 80) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * 整轮输出 → 逐号结论（同一账号出现多次时以**最后一次**为准：重试后的那次才是真的）
 * @returns {Array<{env: string, level: 'ok'|'warn'|'error', text: string}>}
 */
export function parseAccountResults(lines = []) {
  const byEnv = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    const hit = parseAccountLine(line);
    if (hit) byEnv.set(hit.env, hit);
  }
  return [...byEnv.values()].sort((a, b) => a.env.localeCompare(b.env));
}

/** 汇总成界面上的三个数 */
export function summarizeAccountResults(list = []) {
  const rows = Array.isArray(list) ? list : [];
  return {
    total: rows.length,
    ok: rows.filter((r) => r.level === 'ok').length,
    warn: rows.filter((r) => r.level === 'warn').length,
    error: rows.filter((r) => r.level === 'error').length,
  };
}
