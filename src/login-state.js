/**
 * 登录态判定（定时任务发布前预检用）
 *
 * 为什么要有这个：2026-10-18 08:35 那轮定时，账号其实已经掉登录了，
 * 任务照样启动引擎、跑满 5 分钟、到「上传视频」那一步才发现页面上是
 * 「Log in to TikTok」，留下一个 FAILED 目录 —— 时间、API 费用全白花。
 *
 * 判定方式：直接读 FoxProfile 环境的 cookies.sqlite（moz_cookies 表），
 * 毫秒级、不拉起浏览器、不调 /profiles/{env}/cookies（那个接口一次 4 秒）。
 *
 * 三态而不是两态：拿不准（库不存在/被占用/Node 没有 node:sqlite）时返回
 * `unknown`，调用方**不能**据此拦任务 —— 预检只拦「确定没登录」的情况，
 * 宁可放过也不误杀。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 代表登录态的 cookie 名（TikTok 网页端，任一存在即视为已登录） */
export const SESSION_COOKIES = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'];

/** FoxProfile 的 camoufox_data 目录（每个环境一个子目录） */
export function foxDataDir() {
  return process.env.FOXPROFILE_DATA || 'E:/software/FoxProfile/camoufox_data';
}

/** 某环境的 cookie 库路径 */
export function cookieDbFor(env, dir) {
  return path.join(dir || path.join(foxDataDir(), String(env || '')), 'cookies.sqlite');
}

let sqliteMod;
async function getSqlite() {
  if (sqliteMod !== undefined) return sqliteMod;
  try {
    sqliteMod = await import('node:sqlite'); // Node 22.5+ / Electron 43 自带
  } catch (_) {
    sqliteMod = null;
  }
  return sqliteMod;
}

/**
 * 读一个环境的登录态。
 * @returns {Promise<{env:string, state:'in'|'out'|'unknown', cookies:number, session:number,
 *                    note:string, dbFile:string, mtime:string}>}
 */
export async function checkLogin(env, opts = {}) {
  const name = String(env || '').toUpperCase();
  const dbFile = cookieDbFor(name, opts.dir);
  const out = { env: name, state: 'unknown', cookies: 0, session: 0, note: '', dbFile, mtime: '' };

  if (!name) {
    out.note = '环境名为空';
    return out;
  }
  if (!fs.existsSync(dbFile)) {
    // 环境从没启动过 / 换过数据目录 —— 不能断定「未登录」，交给任务自己判断
    out.note = '没有 cookie 库（环境可能从未启动）';
    return out;
  }
  try {
    out.mtime = fs.statSync(dbFile).mtime.toISOString();
  } catch (_) {
    /* 忽略 */
  }

  const sqlite = await getSqlite();
  if (!sqlite) {
    out.note = '当前 Node 没有 node:sqlite，跳过判定';
    return out;
  }

  try {
    const db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
    try {
      const placeholders = SESSION_COOKIES.map(() => '?').join(',');
      const row = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN name IN (${placeholders}) THEN 1 ELSE 0 END) AS session
             FROM moz_cookies WHERE host LIKE '%tiktok%'`,
        )
        .get(...SESSION_COOKIES);
      out.cookies = Number(row?.total || 0);
      out.session = Number(row?.session || 0);
      out.state = out.session > 0 ? 'in' : 'out';
      if (out.state === 'out') out.note = out.cookies ? '有 cookie 但没有 sessionid' : '没有任何 TikTok cookie';
    } finally {
      db.close();
    }
  } catch (e) {
    // 浏览器正开着时库可能被锁；这种情况一律「拿不准」，不要拦任务
    out.note = /locked|busy|EACCES|EBUSY/i.test(String(e.message || e)) ? 'cookie 库被占用' : `读取失败: ${e.message || e}`;
  }
  return out;
}

/** 批量判定，返回 { [env]: 结果 } */
export async function checkLogins(envs, opts = {}) {
  const list = (Array.isArray(envs) ? envs : [envs]).map((e) => String(e || '').toUpperCase()).filter(Boolean);
  const map = {};
  for (const env of list) {
    map[env] = await checkLogin(env, opts);
  }
  return map;
}

/**
 * 把定时的 account 值（"01" / "1" / "TK01" / "01,TK02"）解析成环境名。
 * 配置里 accounts[].name 是 "01"…"10"，bitEnvId / browserEnv 是 "TK01"…"TK10"。
 */
export function resolveEnvs(accountValue, cfg) {
  const accounts = Array.isArray(cfg?.accounts) ? cfg.accounts : [];
  const raw = Array.isArray(accountValue) ? accountValue : String(accountValue || '').split(',');
  const asked = raw.map((s) => String(s || '').trim()).filter(Boolean);
  const envs = [];

  for (const a of asked) {
    const up = a.toUpperCase();
    const hit =
      accounts.find((x) => String(x.name || '').trim() === a) ||
      accounts.find((x) => String(x.bitEnvId || '').toUpperCase() === up) ||
      accounts.find((x) => String(x.browserEnv || '').toUpperCase() === up);
    if (hit) {
      const env = String(hit.bitEnvId || hit.browserEnv || hit.name || '').toUpperCase();
      if (env) envs.push(env);
      continue;
    }
    // 配置里没有这条（例如新加的环境还没写进配置）——只要能对上 TKxx / 纯数字就照用
    if (/^TK\d+$/i.test(a)) envs.push(up);
    else if (/^\d+$/.test(a)) envs.push('TK' + a.padStart(2, '0'));
  }
  return [...new Set(envs)];
}

/** 配置里所有已登记的环境 */
export function allConfigEnvs(cfg) {
  const accounts = Array.isArray(cfg?.accounts) ? cfg.accounts : [];
  return [
    ...new Set(
      accounts
        .map((a) => String(a.bitEnvId || a.browserEnv || a.name || '').toUpperCase())
        .filter((e) => /^TK\d+$/i.test(e)),
    ),
  ];
}

/** 结果对象 → 一行说明 */
export function describeLogin(one) {
  if (one.state === 'in') return `${one.env} 已登录（${one.session} 个 session cookie）`;
  if (one.state === 'out') return `${one.env} 未登录（${one.note}）`;
  return `${one.env} 登录态未知（${one.note}）`;
}

export default { SESSION_COOKIES, foxDataDir, cookieDbFor, checkLogin, checkLogins, resolveEnvs, allConfigEnvs, describeLogin };
