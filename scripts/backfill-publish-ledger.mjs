/**
 * 一次性回填「发布账本」：把历史发布记录归到具体环境上。
 *
 * 为什么需要：老版本的 `.published` 只记了时间，没记环境/账号，
 * 所以账号页没法显示"这个号最后一次发布是什么时候"。
 * 但日志里其实有线索 —— 一次发布在日志里是这样的顺序：
 *
 *     📅 <会话目录> | 模式: video ...
 *     📤 自动发布到账号: 01
 *     🌐 打开指纹环境 TK01...
 *
 * 所以：解析日志 → 按「会话目录 → 账号 → 环境」配对 → 用该会话 `.published`
 * 里的真实发布时间写进账本（`data/publish-ledger.jsonl`）。
 *
 * 用法：
 *   node scripts/backfill-publish-ledger.mjs                 # 真写
 *   node scripts/backfill-publish-ledger.mjs --dry-run       # 只看会写什么
 *   node scripts/backfill-publish-ledger.mjs --data C:\...\xnowpost
 */
import fs from 'node:fs';
import path from 'node:path';
import { appendLedger, readLedger, LEDGER_REL } from '../src/publish-history.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const getArg = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const DATA_DIR = getArg('--data') || path.join(process.env.APPDATA || '', 'xnowpost');

const logDir = path.join(DATA_DIR, 'logs');
const outputDir = path.join(DATA_DIR, 'output');
if (!fs.existsSync(logDir)) { console.error(`找不到日志目录: ${logDir}`); process.exit(1); }

// 1) 读配置，拿到 账号名(01) → 环境名(TK01) 的映射
let accountToEnv = {};
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config', 'user.json'), 'utf8'));
  for (const a of cfg.accounts || []) {
    const env = a.bitEnvId || a.browserEnv || '';
    if (a.name && env) accountToEnv[String(a.name)] = env;
  }
} catch (e) {
  console.warn(`  ⚠️ 读配置失败（账号→环境映射为空）: ${e.message}`);
}
console.log(`  数据目录: ${DATA_DIR}`);
console.log(`  账号→环境: ${JSON.stringify(accountToEnv)}`);

// 2) 扫日志，配对「会话目录 → 环境」
const sessionEnv = new Map();   // sessionDir -> Set(env)
const SESSION_RE = /(?:📅\s+|📁\s+)(.+?output[\\/](\d{4}-\d{2}-\d{2})[\\/]([\w-]+))/;
const ACCOUNT_RE = /发布到账号[:：]\s*(\d{1,2})/;
const ENV_RE = /打开指纹环境\s*(TK\d{2})/;

const logs = fs.readdirSync(logDir).filter((f) => /^(app|scheduler)-.*\.log$/.test(f)).sort();
let pairs = 0;
for (const logName of logs) {
  let text = '';
  try { text = fs.readFileSync(path.join(logDir, logName), 'utf8'); } catch { continue; }
  let curSession = null;
  let pendingAccount = null;
  for (const raw of text.split('\n')) {
    const sm = raw.match(SESSION_RE);
    if (sm) { curSession = { dir: sm[1], date: sm[2], session: sm[3] }; continue; }
    const am = raw.match(ACCOUNT_RE);
    if (am) { pendingAccount = am[1].padStart(2, '0'); continue; }
    const em = raw.match(ENV_RE);
    if (em && curSession) {
      const env = em[1];
      // 顺序配对：账号 01 之后紧接着打开 TK01，就是这条发布用的环境
      const envOfAccount = pendingAccount ? accountToEnv[pendingAccount] : '';
      const match = !pendingAccount || envOfAccount === env;
      if (match) {
        if (!sessionEnv.has(curSession.dir)) sessionEnv.set(curSession.dir, new Map());
        sessionEnv.get(curSession.dir).set(env, {
          date: curSession.date, session: curSession.session, account: pendingAccount || '',
        });
        pairs++;
      }
      pendingAccount = null;
    }
  }
}
console.log(`  日志里配出 ${pairs} 条「会话→环境」`);

// 3) 用会话的 .published 拿真实发布时间，写账本
const already = new Set(readLedger(DATA_DIR).map((r) => `${r.env}|${r.session}|${r.at}`));
const rows = [];
for (const [dir, envs] of sessionEnv) {
  const marker = path.join(dir, '.published');
  if (!fs.existsSync(marker)) continue;
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { continue; }
  if (meta.confirmed === false) continue;
  const at = meta.publishedAt || '';
  if (!at) continue;
  let title = meta.title || '';
  if (!title) {
    try { title = (fs.readFileSync(path.join(dir, '文案.txt'), 'utf8').split('\n')[0] || '').trim(); } catch { /* 无标题也能写 */ }
  }
  for (const [env, info] of envs) {
    const key = `${env}|${info.session}|${at}`;
    if (already.has(key)) continue;
    rows.push({
      env, at, date: info.date, session: info.session,
      account: info.account, title, url: meta.url || '', source: 'backfill',
    });
  }
}

rows.sort((a, b) => new Date(a.at) - new Date(b.at));
console.log(`  待写入账本: ${rows.length} 条`);
for (const r of rows.slice(-15)) {
  console.log(`    ${r.env}  ${r.at}  ${r.date}/${r.session}  ${String(r.title).slice(0, 26)}`);
}
if (!rows.length) { console.log('  没有新记录可写'); process.exit(0); }

if (dryRun) { console.log('  （--dry-run 不写盘）'); process.exit(0); }
for (const r of rows) appendLedger(DATA_DIR, r);
console.log(`  ✅ 已写入 ${path.join(DATA_DIR, LEDGER_REL)}`);

// 4) 回填后汇总
const { latestPublishByEnv } = await import('../src/publish-history.js');
const latest = latestPublishByEnv(DATA_DIR);
for (const env of Object.keys(latest).sort()) {
  console.log(`    ${env}: ${latest[env].at}  ${latest[env].date}/${latest[env].session}`);
}
if (!fs.existsSync(outputDir)) console.log('  （没有 output 目录？）');
