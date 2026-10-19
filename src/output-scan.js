/**
 * 扫 output/<日期>/<会话>/，判断哪些内容**可以发布** —— 全项目唯一实现。
 *
 * 为什么必须有这一份（2026-10-19 全盘审查 P0-1/P0-6）：
 *   同一件事原来有三份实现，规则各不相同：
 *     ① `electron/main.js` 的手动发布（有 FAILED 拦截、默认限 3 条、未确认不打成功）
 *     ② `electron/main.js` 的待发布列表（不看 FAILED、不限日期、能列出 6 月的老会话）
 *     ③ `src/publisher/index.js` 的调度器发布（**没有 FAILED 拦截、`--all` 全发、
 *        不认 confirmed、所有条目打到 accounts[0]**）
 *   实测积压 57 个未发布会话（14 个带 FAILED，最老 2026-06-18），
 *   而无人值守走的正是规则最松的那一份 —— 一次 `--all` 就能把两个月前的老内容发出去。
 *
 * 现在的口径（默认值就是安全值）：
 *   - **只认当天**（`onlyToday: true`）。老会话要显式 `includeOld: true` 才进候选。
 *   - **跳过 FAILED**，除非 FAILED.stage 是"发布相关"（那种视频本身没问题，该重试）。
 *   - **跳过 `.published`**（哪怕 `confirmed:false` —— 重传会产生重复作品）。
 *   - 默认每轮最多 `DEFAULT_MAX_PER_RUN` 条。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 默认每轮最多发几条（积压时一次全推容易被判定为批量营销） */
export const DEFAULT_MAX_PER_RUN = 3;

/** 日期目录名必须是 YYYY-MM-DD */
export function isDateDirName(name) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(name || ''));
}

/** 会话目录名 → "HH:MM"；认不出就是空串（**不要**返回 "undefined:undefined"） */
export function sessionTime(name) {
  const m = String(name || '').match(/(\d{2})(\d{2})(?:-\d+)?$/);
  if (!m) return '';
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!(h >= 0 && h < 24) || !(min >= 0 && min < 60)) return '';
  return `${m[1]}:${m[2]}`;
}

/** 读会话目录里的标记文件（不存在/坏掉 → null） */
export function readMarker(sessionPath, fileName) {
  const p = path.join(sessionPath, fileName);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf-8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (_) {
    // 坏标记按"存在但内容不明"处理，调用方会保守地跳过
    return { __broken: true };
  }
}

/**
 * 单个会话的处置判定（纯函数：只吃文件名列表 + 两个标记对象）。
 * @returns {{action:'publish'|'retry'|'skip', reason:string, detail?:string}}
 */
export function classifySession({ files = [], published = null, failed = null } = {}) {
  const hasVideo = files.some((f) => String(f).toLowerCase().endsWith('.mp4'));
  const hasImages = files.some((f) => /\.(png|jpg|jpeg)$/i.test(f) && f !== '封面.png');
  const hasTxt = files.includes('文案.txt');

  if (!hasTxt) return { action: 'skip', reason: 'no-txt', detail: '没有 文案.txt' };
  if (!hasVideo && !hasImages) return { action: 'skip', reason: 'no-content', detail: '没有 mp4/图片' };

  if (published) {
    if (published.__broken) return { action: 'skip', reason: 'published', detail: '已发布（.published 内容损坏，按已发布处理）' };
    if (published.confirmed === false || published.note === 'post-clicked-unconfirmed') {
      return { action: 'skip', reason: 'unconfirmed', detail: '已点过发布按钮但结果未确认（不重复上传，请人工核对）' };
    }
    return { action: 'skip', reason: 'published', detail: '已发布' };
  }

  if (failed) {
    if (failed.__broken) return { action: 'skip', reason: 'failed-broken', detail: 'FAILED 标记损坏，按失败处理（先重跑生成）' };
    if (failed.published === true) return { action: 'skip', reason: 'failed-published', detail: '失败标记显示视频已发出' };
    const stage = String(failed.stage || '');
    // 视频合成阶段失败 → mp4 可能是半成品，不许发
    if (stage.includes('视频') || stage.includes('合成')) {
      return { action: 'skip', reason: 'failed-synthesize', detail: `合成失败(${stage || '未知'})，mp4 不可信，请先重跑生成` };
    }
    // 只有发布相关阶段失败 → 视频本身是好的，该重试
    return { action: 'retry', reason: 'retry-publish', detail: `上次失败于「${stage || '未知'}」，重试发布` };
  }

  return { action: 'publish', reason: 'ok' };
}

/** 把 output 下的会话摊平（顺序：日期新→旧、会话新→旧） */
export function walkSessions(outputDir, { dateDirs = null } = {}) {
  const out = [];
  let dirs = dateDirs;
  if (!dirs) {
    try {
      dirs = fs.readdirSync(outputDir).filter(isDateDirName);
    } catch (_) {
      return out;
    }
  }
  for (const dd of [...dirs].sort().reverse()) {
    const dp = path.join(outputDir, dd);
    let names = [];
    try {
      names = fs.readdirSync(dp);
    } catch (_) {
      continue;
    }
    const sessions = names
      .filter((n) => {
        try {
          return fs.statSync(path.join(dp, n)).isDirectory();
        } catch (_) {
          return false;
        }
      })
      .sort()
      .reverse();
    for (const s of sessions) {
      const sp = path.join(dp, s);
      let files = [];
      try {
        files = fs.readdirSync(sp);
      } catch (_) {
        continue;
      }
      out.push({ date: dd, session: s, path: sp, files });
    }
  }
  return out;
}

/**
 * 扫描待发布内容。
 * @param {object} opts
 * @param {string} opts.outputDir
 * @param {string} opts.today           本地日期 YYYY-MM-DD
 * @param {boolean} [opts.onlyToday=true] 只认当天（安全默认）
 * @param {number} [opts.maxCount=0]    0 = 不限（调用方自己再截断）
 * @param {boolean} [opts.includeFailedRetry=true] FAILED 但属于发布阶段失败的要不要重试
 * @returns {{items:Array, skipped:Array, pending:Array}}
 */
export function scanUnpublished(opts = {}) {
  const { outputDir, today, onlyToday = true, maxCount = 0, includeFailedRetry = true } = opts;
  const items = [];
  const skipped = [];
  const pending = [];

  for (const row of walkSessions(outputDir)) {
    const published = readMarker(row.path, '.published');
    const failed = readMarker(row.path, 'FAILED');
    const verdict = classifySession({ files: row.files, published, failed });
    const time = sessionTime(row.session);
    const title = readTitle(row.path, row.files, row.session);

    // 界面里的「待发布」列表：所有还没 .published 的（含 FAILED / 老会话），要标出来
    if (!published && (verdict.action === 'publish' || verdict.action === 'retry' || verdict.reason.startsWith('failed'))) {
      pending.push({
        date: row.date,
        session: row.session,
        path: row.path,
        type: row.files.some((f) => f.toLowerCase().endsWith('.mp4')) ? 'video' : 'post',
        title,
        time,
        failed: !!failed,
        failedStage: failed && !failed.__broken ? String(failed.stage || '') : '',
        old: !!(today && row.date !== today),
        retryable: verdict.action === 'retry',
      });
    }

    if (verdict.action === 'skip') {
      skipped.push({ date: row.date, session: row.session, reason: verdict.reason, detail: verdict.detail || '' });
      continue;
    }
    if (verdict.action === 'retry' && !includeFailedRetry) {
      skipped.push({ date: row.date, session: row.session, reason: 'failed-retry-off', detail: '失败过但未开启重试' });
      continue;
    }
    // 只认当天：老会话不进候选（除非显式 includeOld）
    const isOld = !!(today && row.date !== today);
    if (onlyToday && isOld) {
      skipped.push({ date: row.date, session: row.session, reason: 'old-date', detail: `${row.date} 的旧会话（默认不发）` });
      continue;
    }

    const videoFile = row.files.find((f) => f.toLowerCase().endsWith('.mp4')) || null;
    const imageFiles = row.files.filter((f) => /\.(png|jpg|jpeg)$/i.test(f) && f !== '封面.png');
    items.push({
      date: row.date,
      session: row.session,
      path: row.path,
      title,
      time,
      retry: verdict.action === 'retry',
      hasVideo: !!videoFile,
      hasImages: imageFiles.length > 0,
      videoFile,
      imageFiles,
      txtFile: path.join(row.path, '文案.txt'),
    });
  }

  const limited = maxCount && maxCount > 0 ? items.slice(0, maxCount) : items;
  if (limited.length !== items.length) {
    for (const extra of items.slice(limited.length)) {
      skipped.push({ date: extra.date, session: extra.session, reason: 'over-limit', detail: `超出本轮上限 ${maxCount} 条` });
    }
  }
  return { items: limited, skipped, pending };
}

/** 读文案第一行当标题（读不到就用会话名） */
function readTitle(sessionPath, files, fallback) {
  if (!files.includes('文案.txt')) return fallback;
  try {
    const txt = fs.readFileSync(path.join(sessionPath, '文案.txt'), 'utf-8');
    const first = String(txt || '').split('\n')[0].trim();
    return first ? first.slice(0, 60) : fallback;
  } catch (_) {
    return fallback;
  }
}

/** 把跳过原因聚合成一句话（日志用，避免几十行刷屏） */
export function summarizeSkips(skipped) {
  const counts = new Map();
  for (const s of skipped || []) {
    counts.set(s.reason, (counts.get(s.reason) || 0) + 1);
  }
  const LABEL = {
    published: '已发布',
    unconfirmed: '已点击但未确认',
    'failed-synthesize': '合成失败（mp4 不可信）',
    'failed-published': '失败标记显示已发出',
    'failed-broken': 'FAILED 标记损坏',
    'failed-retry-off': '失败过但未开重试',
    'no-txt': '缺文案',
    'no-content': '没有视频/图片',
    'old-date': '旧日期会话',
    'over-limit': '超出本轮上限',
  };
  return [...counts.entries()].map(([reason, n]) => `${LABEL[reason] || reason} ${n}`).join('、');
}
