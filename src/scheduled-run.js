/**
 * 「定时轮次结果」记录：**调度器写 → 主进程读 → 主动说进 AI 助手对话**。
 *
 * 为什么要有这个东西：
 *   `src/scheduler.js` 是独立长驻进程，`electron/main.js` 里的 `reportEngineRun()` 只覆盖
 *   「界面按钮点的 / 助手叫的」那几轮。00:30 / 08:30 那些闹钟跑完，结果只留在
 *   `logs/scheduler-<日期>.log` 里 —— 用户不问就永远不知道那一轮成没成
 *   （PROGRESS 里挂着的「调度器跑的轮次回报不进来」就是这个缺口）。
 *
 * 三条口径（和项目其它地方一致，改之前先看一眼）：
 *   1. **只写已经发生的事**：谁（job/模式/账号）、几点开始结束、结果码、退出原因。
 *      不发散、不猜、不写「应该」。
 *   2. **结果码来自代码返回值**（`runWithRetry()` 的 `ok/insufficient/unconfirmed/timeout`），
 *      不靠搜索日志文字 —— 日志措辞会改，返回值是契约。
 *   3. **汇报文案只看落盘证据**（`.published` / FAILED / 账本 / `cost.json` / `collect-*.json`），
 *      「进程正常退出」绝不写成「已发布」（CLAUDE.md 的「日志不许说谎」）。
 *
 * 为什么用「每轮一个小 JSON」而不是直接盯日志文本：
 *   日志是给人看的，格式随时会改；JSON 字段是给程序读的，还能带 startedAt/finishedAt
 *   去和账本时间窗对齐（否则 publish 模式发的是旧会话，看日志根本分不清哪条是这一轮发的）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from './fs-atomic.js';

/** 轮次结果码（也是 `describeScheduledRun()` 的分支集合） */
export const RUN_RESULTS = ['ok', 'partial', 'unconfirmed', 'insufficient', 'timeout', 'failed', 'skipped'];

/** 模式 → 人话（和 `electron/lib/assistant-tools.js` 的 SCHEDULE_MODE_LABEL 同口径） */
export const RUN_MODE_LABEL = {
  video: '仅视频',
  post: '仅图文',
  auto: '视频+图文',
  collect: '数据采集',
  text: '仅文案',
};

/** 记录目录（相对数据目录） */
export const RUNS_REL = path.join('data', 'runs');

/** 记录保留天数：只用来「别把两个月前的轮次灌进对话」，不是交付物 */
export const RUN_KEEP_DAYS = 7;

const SESSION_LINE = /📅\s*(.*?)\s*\|\s*模式:\s*([^\s|]+)/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 时间戳 → 本地 HH:MM（不许用 toISOString 切片，那是 UTC，北京时间少 8 小时） */
export function localHHMM(ms) {
  const d = new Date(Number(ms) || 0);
  if (!Number.isFinite(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 从引擎的会话行里取会话目录：
 *   `📅 F:\...\output\2026-10-19\am_0830 | 模式: video`
 * 返回 `{ date, session, mode }`；不是会话行返回 null。
 */
export function parseSessionLine(line) {
  const m = String(line || '').match(SESSION_LINE);
  if (!m) return null;
  const p = m[1].trim().replace(/\\/g, '/');
  const sess = p.match(/((?:am|pm)_\d{4})/);
  if (!sess) return null;
  const date = p.match(/(\d{4}-\d{2}-\d{2})/);
  return { date: date ? date[1] : '', session: sess[1], mode: m[2].trim() };
}

/** 一轮里可能有多条会话行（重试），取**最后一条**：那才是这一轮真正落地的产物 */
export function pickSession(lines) {
  let found = null;
  for (const line of Array.isArray(lines) ? lines : []) {
    const s = parseSessionLine(line);
    if (s) found = s;
  }
  return found;
}

/** `runWithRetry()` 的返回值 → 结果码（唯一映射，别在别处再写一份） */
export function resultFromRunWithRetry(r) {
  if (!r) return 'failed';
  if (r.ok) return r.partial ? 'partial' : 'ok';
  if (r.insufficient) return 'insufficient';
  if (r.unconfirmed) return 'unconfirmed';
  if (r.timeout) return 'timeout';
  return 'failed';
}

/** 耗时的人话：<90 秒说秒（11 秒别写成「1 分钟」），否则「N 分 M 秒」 */
export function fmtDuration(ms) {
  const total = Math.round((Number(ms) || 0) / 1000);
  if (!(total > 0)) return '';
  if (total < 90) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

/** 花费：<¥0.1 保留三位（¥0.004 别写成 ¥0.00） */
export function fmtCost(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  return `¥${v.toFixed(v < 0.1 ? 3 : 2)}`;
}

/**
 * 组装一条轮次记录（纯函数，不碰磁盘）。
 * 字段名就是主进程要读的名字，改字段先改 `tests/unit/scheduled-run.test.js`。
 */
export function buildRunRecord({
  job = {},
  startedAtMs = Date.now(),
  finishedAtMs = Date.now(),
  result = 'ok',
  reason = '',
  date = '',
  session = '',
  logFile = '',
} = {}) {
  const startedAt = Number(startedAtMs) || Date.now();
  const finishedAt = Number(finishedAtMs) || startedAt;
  return {
    v: 1,
    jobId: Number.isFinite(Number(job.id)) ? Number(job.id) : null,
    label: String(job.label || ''),
    mode: String(job.mode || 'auto'),
    account: String(job.account || '').trim(),
    startedAt: new Date(startedAt).toISOString(),
    startedAtMs: startedAt,
    finishedAt: new Date(finishedAt).toISOString(),
    finishedAtMs: finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    result: RUN_RESULTS.includes(result) ? result : 'failed',
    reason: String(reason || '').slice(0, 300),
    date: String(date || ''),
    session: String(session || ''),
    logFile: String(logFile || ''),
  };
}

/**
 * 记录文件名：`<日期>-<HHMM>-<jobId>.json`。
 * 带时间前缀是为了「按名字排序 = 按时间排序」，出问题时直接看目录就知道今晚跑了哪些轮次。
 */
export function runRecordFileName(record) {
  const r = record || {};
  const d = new Date(Number(r.startedAtMs) || 0);
  const date = r.date || (Number.isFinite(d.getTime()) ? d.toLocaleDateString('sv-SE') : 'nodate');
  const hm = localHHMM(r.startedAtMs).replace(':', '') || '0000';
  const id = r.jobId === null || r.jobId === undefined ? 'x' : String(r.jobId);
  return `${date}-${hm}-${id}.json`;
}

/**
 * 合并「这一轮发出去的」证据。
 *
 * 为什么必须合并：同一次发布有两个来源 —— 会话里的 `.published` 标记和
 * `data/publish-ledger.jsonl` 的账本行，**时间戳各写各的**
 * （实测 2026-10-19 pm_2257：标记 `14:59:12.421Z` / 账本 `14:59:12.422Z`，差 1 毫秒），
 * 直接拼起来会把「发了 1 条」说成「已发布 2 条」—— 这正是"日志不许说谎"要防的那类错。
 * 去重口径：**环境 + 会话**（同一环境同一会话只可能是一条作品）；
 * 缺字段就互补（标记里没标题、账本里有，反之亦然）。
 *
 * @param {Array<{env?:string,session?:string,at?:string,title?:string}>} items
 * @returns {Array<{env:string,session:string,at:string,title:string}>}
 */
export function mergePublishedEvidence(items) {
  const map = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it) continue;
    const env = String(it.env || '').trim();
    const session = String(it.session || '').trim();
    const at = String(it.at || '');
    const title = String(it.title || '');
    const key = `${env}|${session}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { env, session, at, title });
      continue;
    }
    if (!prev.at && at) prev.at = at;
    if (!prev.title && title) prev.title = title;
  }
  return [...map.values()];
}

function titlesOf(list) {
  return list.map((x) => (x && x.title ? `《${String(x.title).slice(0, 40)}》` : '')).filter(Boolean);
}

/** 「已发布 → TK01《标题》」/「已发布 3 条 → TK01、TK05」 */
export function publishedText(list) {
  const items = (Array.isArray(list) ? list : []).filter(Boolean);
  if (!items.length) return '';
  const envs = [...new Set(items.map((x) => String(x.env || '').trim()).filter(Boolean))];
  const where = envs.length ? ` → ${envs.join('、')}` : '';
  const titles = titlesOf(items);
  if (items.length === 1) return `已发布${where}${titles[0] || ''}`;
  return `已发布 ${items.length} 条${where}${titles.length ? `（含${titles[0]}）` : ''}`;
}

function headOf(record) {
  const r = record || {};
  const bits = [];
  const t = localHHMM(r.startedAtMs);
  if (t) bits.push(t);
  const mode = RUN_MODE_LABEL[r.mode] || r.label || r.mode || '';
  if (mode) bits.push(mode);
  if (r.account) bits.push(`账号 ${r.account}`);
  return bits.join(' · ');
}

/**
 * 一轮定时任务 → 一句给人看的话。
 *
 * @param {object} record   `buildRunRecord()` 的产物
 * @param {object} ev       落盘证据：`{ published:[{env,title,at}], unconfirmedPublish, failed:{stage,reason},
 *                          hasVideo, hasText, cost, collect:{ok,total,collected,insufficient} }`
 * @returns {string} 一行中文（末尾带句号，不带换行）
 */
export function describeScheduledRun(record, ev = {}) {
  const r = record || {};
  const evidence = ev || {};
  const where = `（${headOf(r)}）`;
  const took = fmtDuration(r.durationMs);
  const cost = fmtCost(evidence.cost);
  const logName = r.logFile ? path.basename(String(r.logFile)) : '';
  const withTook = (extra = []) => {
    const bits = [took ? `用时 ${took}` : '', cost, ...extra].filter(Boolean);
    return bits.length ? `（${bits.join(' · ')}）` : '';
  };
  const sessionPrefix = r.session ? `${r.session} ` : '';

  switch (r.result) {
    case 'ok': {
      const pub = publishedText(evidence.published);
      if (pub) return `✅ 定时轮次完成${where}：${pub}${withTook()}。`;
      if (evidence.unconfirmedPublish) {
        return `⚠️ 定时轮次结束${where}：点了发布按钮但没确认到公开（不重发，请到 TikTok 后台核对）${withTook()}。`;
      }
      if (r.mode === 'collect' && evidence.collect) {
        const c = evidence.collect;
        const total = Number(c.total) || 0;
        const collected = Number(c.collected) || 0;
        const short = Number(c.insufficient) || 0;
        const failN = Array.isArray(c.failures) ? c.failures.length : 0;
        const bits = [`采集到 ${collected}/${total} 个账号的数据`];
        if (short) bits.push(`${short} 个数据不足（分析页只有「--」占位）`);
        if (failN) bits.push(`${failN} 个失败`);
        return `✅ 定时轮次完成${where}：${bits.join('，')}${withTook()}。`;
      }
      if (evidence.hasVideo) return `📦 定时轮次完成${where}：${sessionPrefix}成片好了（video.mp4），这次没发布${withTook()}。`;
      if (evidence.hasText) return `📝 定时轮次完成${where}：${sessionPrefix}只出了文案，没有成片${withTook()}。`;
      return `⚠️ 定时轮次完成${where}：进程正常退出，但${sessionPrefix || '这一轮 '}没看到成片也没看到发布记录${withTook()} —— 要我查日志就说「看日志」。`;
    }
    case 'unconfirmed':
      return `⚠️ 定时轮次未确认${where}：已点发布按钮但没能证明已公开（不重试、不重发），请到 TikTok 后台核对${withTook(logName ? [`日志 ${logName}`] : [])}。`;
    case 'insufficient':
      return `ℹ️ 定时轮次结束${where}：数据不足（TikTok 分析页只返回「--」占位，本轮不重试，账号有数据后会自己恢复）${withTook()}。`;
    case 'partial':
      // 养号有账号被拦/白屏，但别的号是真的养了。说「失败」会让用户以为整晚白跑，
      // 说「完成」又不老实 —— 只按落盘证据说话：哪几个号没养成。
      return `⚠️ 定时轮次部分完成${where}：${r.reason || '部分账号没养成'}，其余账号已正常养完（不重试，避免重复点赞）${withTook(logName ? [`日志 ${logName}`] : [])}。`;
    case 'timeout':
      return `⏱️ 定时轮次超时${where}：子进程被强制结束，产物/发布状态未知，本轮没重试 —— 请人工确认${withTook(logName ? [`日志 ${logName}`] : [])}。`;
    case 'skipped':
      return `⏭️ 定时轮次跳过${where}：${r.reason || '本轮没有执行'}${withTook()}。`;
    case 'failed':
    default: {
      const stage = evidence.failed && evidence.failed.stage ? ` · 卡在「${evidence.failed.stage}」` : '';
      const why = r.reason || (evidence.failed && evidence.failed.reason) || '退出码非 0';
      return `❌ 定时轮次失败${where}：${why}${stage}${withTook(logName ? [`日志 ${logName}`] : [])}。`;
    }
  }
}

// ───────────────────────── 落盘：写 / 读未回报的 / 标记已回报 / 清理 ─────────────────────────

/** 写一条记录（原子写：调度器被杀也不会留半截 JSON） */
export function writeRunRecord(dir, record) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, runRecordFileName(record));
  writeJsonAtomicSync(file, record);
  return file;
}

/**
 * 列出「还没回报过」的记录（按结束时间正序，主进程照这个顺序说进对话）。
 * 已 `reportedAt` 的跳过；`maxAgeMs` 之外的也跳过（重装/迁移后别把老记录全灌一遍）。
 */
export function listPendingRunRecords(dir, { maxAgeMs = 6 * 3600 * 1000, now = Date.now() } = {}) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const full = path.join(dir, f);
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }   // 坏文件跳过
    if (!rec || rec.reportedAt) continue;
    const at = Number(rec.finishedAtMs);
    if (!Number.isFinite(at) || at <= 0) continue;
    if (maxAgeMs > 0 && now - at > maxAgeMs) continue;
    out.push({ file: f, full, record: rec });
  }
  out.sort((a, b) => Number(a.record.finishedAtMs) - Number(b.record.finishedAtMs));
  return out;
}

/** 标记已回报（读-改-写原子落盘；失败不抛，最多下次重复说一遍） */
export function markRunReported(item, at = new Date().toISOString()) {
  try {
    const rec = { ...(item.record || {}), reportedAt: at };
    writeJsonAtomicSync(item.full, rec);
    return true;
  } catch {
    return false;
  }
}

/** 清理过期记录（按记录里的 finishedAtMs，不按 mtime —— 拷贝/解压会改 mtime） */
export function pruneRunRecords(dir, { days = RUN_KEEP_DAYS, now = Date.now() } = {}) {
  if (!(days > 0)) return 0;
  const cutoff = now - days * 24 * 3600 * 1000;
  let removed = 0;
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return 0; }
  for (const f of files) {
    const full = path.join(dir, f);
    let at = NaN;
    try { at = Number(JSON.parse(fs.readFileSync(full, 'utf8')).finishedAtMs); } catch { at = NaN; }
    if (!Number.isFinite(at)) {
      // 坏文件按 mtime 兜底，否则会永远留在目录里
      try { at = fs.statSync(full).mtimeMs; } catch { continue; }
    }
    if (at >= cutoff) continue;
    try { fs.unlinkSync(full); removed++; } catch { /* 被占用就下次再说 */ }
  }
  return removed;
}
