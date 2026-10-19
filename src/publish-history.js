/**
 * 发布历史：从 `output/<日期>/<会话>/.published` 里整理出「每个环境最后一次发布成功」。
 *
 * 为什么单独一个模块：账号页（Electron 主进程）、命令行脚本、以后的通知都要用同一份数据，
 * 逻辑写在界面里就会分叉。
 *
 * 数据来源（都是发布器自己落的盘，没有额外数据库）：
 *   · `.published`  → publishedAt / platform / url，新版本还带 env / session / title
 *   · `publish.log` → 老会话没写 env，用里面第一行 `🌐 打开指纹环境 TK02...` 兜底解析
 *   · `文案.txt`    → 标题（.published 里没有 title 时兜底）
 *
 * 判定「发布成功」的口径：
 *   · 有 `.published` 且 `confirmed !== false` —— 发布器点了 Post 并确认过；
 *   · `confirmed === false`（点了按钮但没确认结果）记进列表但**不算**最后成功时间。
 */
import fs from 'node:fs';
import path from 'node:path';

const ENV_IN_LOG = /打开指纹环境\s*(TK\d{2})/;
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function readJsonQuiet(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 老会话没有 env 字段时，从 publish.log 里找「打开指纹环境 TKxx」 */
export function envFromPublishLog(sessionDir) {
  try {
    const log = fs.readFileSync(path.join(sessionDir, 'publish.log'), 'utf8');
    const m = log.match(ENV_IN_LOG);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function titleFromSession(sessionDir) {
  try {
    const txt = fs.readFileSync(path.join(sessionDir, '文案.txt'), 'utf8');
    return (txt.split('\n')[0] || '').trim().slice(0, 60);
  } catch {
    return '';
  }
}

/**
 * 扫描所有发布记录（新的在前）。
 * @param {string} outputDir  `<数据目录>/output`
 * @param {{ limit?: number }} opts
 * @returns {Array<{env:string,date:string,session:string,at:string,confirmed:boolean,url:string,title:string,dir:string}>}
 */
export function scanPublishHistory(outputDir, opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 500;
  const out = [];
  if (!outputDir || !fs.existsSync(outputDir)) return out;

  let dateDirs = [];
  try { dateDirs = fs.readdirSync(outputDir).filter((d) => DATE_DIR.test(d)).sort().reverse(); } catch { return out; }

  for (const date of dateDirs) {
    const datePath = path.join(outputDir, date);
    let sessions = [];
    try { sessions = fs.readdirSync(datePath).filter((s) => isDir(path.join(datePath, s))).sort().reverse(); } catch { continue; }

    for (const session of sessions) {
      const dir = path.join(datePath, session);
      const marker = path.join(dir, '.published');
      if (!fs.existsSync(marker)) continue;

      const meta = readJsonQuiet(marker) || {};
      let at = meta.publishedAt || '';
      if (!at) {
        try { at = fs.statSync(marker).mtime.toISOString(); } catch { at = ''; }
      }
      out.push({
        env: meta.env || envFromPublishLog(dir),
        date,
        session,
        at,
        confirmed: meta.confirmed !== false,
        url: meta.url || '',
        title: meta.title || titleFromSession(dir),
        dir,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * 每个环境最后一次**确认成功**的发布时间。
 * @returns {Record<string, {at:string,date:string,session:string,title:string,url:string}>}
 */
export function latestByEnv(outputDir) {
  const map = {};
  for (const rec of scanPublishHistory(outputDir)) {
    if (!rec.env || !rec.at) continue;
    if (!rec.confirmed) continue;   // 「点了按钮但没确认」不算成功
    const prev = map[rec.env];
    if (!prev || new Date(rec.at).getTime() > new Date(prev.at).getTime()) {
      map[rec.env] = { at: rec.at, date: rec.date, session: rec.session, title: rec.title, url: rec.url };
    }
  }
  return map;
}

// ───────────────────────── 发布账本（publish-ledger.jsonl） ─────────────────────────
//
// 为什么在上面的 `.published` 之外还要一个账本：
//   · `.published` 在会话目录里，扫描要遍历 200+ 个目录（几百毫秒），而且老会话没有 env；
//   · 账本是**追加**的一行一条，发布成功的瞬间就能写、能监听 —— 账号页据此「发完立刻更新」。
// 一行一条 JSON（jsonl），追加写不用锁，坏一行也不影响其它行。

export const LEDGER_REL = path.join('data', 'publish-ledger.jsonl');

/** 由会话目录反推数据目录：<数据目录>/output/<日期>/<会话> */
export function dataDirOfSession(sessionPath) {
  return path.resolve(sessionPath, '..', '..', '..');
}

/** 追加一条发布记录（失败静默：账本不该影响发布本身） */
export function appendLedger(dataDir, entry) {
  try {
    const file = path.join(dataDir, LEDGER_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({
      env: entry.env || '',
      account: entry.account || '',
      at: entry.at || new Date().toISOString(),
      date: entry.date || '',
      session: entry.session || '',
      title: (entry.title || '').slice(0, 120),
      url: entry.url || '',
      source: entry.source || 'publisher',
    });
    fs.appendFileSync(file, line + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 读账本（坏行跳过） */
export function readLedger(dataDir) {
  const file = path.join(dataDir, LEDGER_REL);
  const out = [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  return out;
}

/**
 * 账本 + `.published` 标记合并，得到每个环境最后成功发布时间。
 * 账本优先（它有精确的 env），标记兜底（老版本没账本）。
 */
export function latestPublishByEnv(dataDir) {
  const outputDir = path.join(dataDir, 'output');
  const map = latestByEnv(outputDir);

  for (const rec of readLedger(dataDir)) {
    if (!rec.env || !rec.at) continue;
    const prev = map[rec.env];
    if (!prev || new Date(rec.at).getTime() > new Date(prev.at).getTime()) {
      map[rec.env] = {
        at: rec.at,
        date: rec.date || (rec.at || '').slice(0, 10),
        session: rec.session || '',
        title: rec.title || '',
        url: rec.url || '',
        source: rec.source || 'ledger',
      };
    }
  }
  return map;
}
