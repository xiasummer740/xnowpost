/**
 * 凭据与关键状态的加密备份 —— 纯逻辑，不 import electron / fs。
 *
 * 为什么要有（2026-10-19 全盘审查 P0-4）：
 *   10 个号的用户名/密码/邮箱密码只存在 `data/env-accounts.json` 一份里，**没有任何备份**；
 *   cookie 备份目录是空的（0/10 环境）；2FA 密钥全盘检索命中 0。
 *   也就是说：一次误删、一次写坏、一次坏盘 = 10 个号彻底失联。
 *
 * 约定：
 *   - 加密由调用方做（主进程用 Electron `safeStorage`，Windows 上走 DPAPI）。
 *     本模块只负责"装什么、缺什么、能不能恢复"，绝不自己写明文。
 *   - 备份目录 `backups/secrets/<本地日期>/secrets.enc`，只保留最近 `SECRET_KEEP_DAYS` 天。
 *   - `files` 的键是**相对数据目录**的路径（`data/env-accounts.json`），恢复时原样写回。
 */

/** 要备份哪些文件：顺序即日志里的展示顺序 */
export const SECRET_FILES = [
  { rel: 'data/env-accounts.json', label: '账号凭据（用户名/密码/邮箱密码/2FA）' },
  { rel: 'data/account-profiles.json', label: '账号资料（昵称/粉丝/头像 URL）' },
  { rel: 'data/account-meta.json', label: '账号状态' },
  { rel: 'config/schedule.json', label: '闹钟配置' },
  { rel: 'data/publish-ledger.jsonl', label: '发布账本' },
];

/** 备份保留天数（与 cookie 备份同一口径） */
export const SECRET_KEEP_DAYS = 14;

/** 打包后的文件名（每天一个目录，目录里就这一个文件） */
export const BUNDLE_FILE = 'secrets.enc';

/** 最小可信的包结构版本 */
export const BUNDLE_VERSION = 1;

/** 这些相对路径属于敏感内容：只能进加密包，不许写明文（单测守这条） */
export function isSensitiveRel(rel) {
  const r = String(rel || '').replace(/\\/g, '/');
  return r === 'data/env-accounts.json' || r.startsWith('backups/') || r === 'config/user.json';
}

/**
 * 组包。
 * @param {object} p
 * @param {Object<string,string>} p.files 相对路径 → 文件原文
 * @param {Object<string,Array>} [p.cookies] 环境名 → cookie 数组（可选）
 * @param {string} [p.at] ISO 时间
 * @param {string} [p.version] 应用版本（仅诊断用）
 */
export function buildBundle({ files = {}, cookies = {}, at = new Date().toISOString(), version = '' } = {}) {
  const clean = {};
  for (const [rel, text] of Object.entries(files || {})) {
    if (typeof rel !== 'string' || !rel) continue;
    if (typeof text !== 'string') continue;
    clean[rel.replace(/\\/g, '/')] = text;
  }
  const cook = {};
  for (const [env, list] of Object.entries(cookies || {})) {
    if (!Array.isArray(list) || !list.length) continue;
    cook[env] = list;
  }
  return { v: BUNDLE_VERSION, at, version, files: clean, cookies: cook };
}

/** 包内容摘要（日志用）：文件数 / cookie 环境数 / 原始字节数 */
export function summarizeBundle(bundle) {
  const files = (bundle && bundle.files) || {};
  const cookies = (bundle && bundle.cookies) || {};
  const rels = Object.keys(files);
  let bytes = 0;
  for (const rel of rels) bytes += Buffer.byteLength(String(files[rel]), 'utf8');
  for (const env of Object.keys(cookies)) bytes += Buffer.byteLength(JSON.stringify(cookies[env]), 'utf8');
  return {
    fileCount: rels.length,
    cookieEnvs: Object.keys(cookies),
    bytes,
    rels,
  };
}

/** 空包（什么都没读到）—— 不该写盘，写了等于假备份 */
export function isEmptyBundle(bundle) {
  const s = summarizeBundle(bundle);
  return s.fileCount === 0 && s.cookieEnvs.length === 0;
}

/** 少了哪些该有的文件（给日志提示用；不阻断备份） */
export function missingSecretLabels(bundle) {
  const files = (bundle && bundle.files) || {};
  return SECRET_FILES.filter((item) => !Object.prototype.hasOwnProperty.call(files, item.rel)).map((item) => item.label);
}

/** 解析并校验包；坏包返回 null（绝不抛异常，调用方按"没备份"处理） */
export function parseBundle(text) {
  try {
    const obj = typeof text === 'string' ? JSON.parse(text) : text;
    if (!obj || typeof obj !== 'object') return null;
    if (obj.v !== BUNDLE_VERSION) return null;
    if (!obj.files || typeof obj.files !== 'object' || Array.isArray(obj.files)) return null;
    const files = {};
    for (const [rel, body] of Object.entries(obj.files)) {
      if (typeof body === 'string') files[rel.replace(/\\/g, '/')] = body;
    }
    const cookies = {};
    if (obj.cookies && typeof obj.cookies === 'object') {
      for (const [env, list] of Object.entries(obj.cookies)) {
        if (Array.isArray(list)) cookies[env] = list;
      }
    }
    return { v: BUNDLE_VERSION, at: obj.at || '', version: obj.version || '', files, cookies };
  } catch (_) {
    return null;
  }
}

/** 把一次 cookie 导出的结果并进包（同一环境覆盖旧的） */
export function mergeCookies(bundle, env, list) {
  const base = bundle && typeof bundle === 'object' ? bundle : buildBundle({});
  const cookies = { ...(base.cookies || {}) };
  if (env && Array.isArray(list) && list.length) cookies[String(env)] = list;
  return { ...base, cookies };
}

/**
 * 决定恢复哪些文件。
 * @param {object} bundle
 * @param {(rel:string)=>'ok'|'missing'|'corrupt'} check 现状探测
 * @returns {Array<{rel:string,label:string,reason:'missing'|'corrupt'}>}
 */
export function planRestore(bundle, check) {
  const files = (bundle && bundle.files) || {};
  const out = [];
  for (const item of SECRET_FILES) {
    if (!Object.prototype.hasOwnProperty.call(files, item.rel)) continue;
    let state = 'ok';
    try {
      state = typeof check === 'function' ? check(item.rel) : 'ok';
    } catch (_) {
      state = 'corrupt';
    }
    if (state === 'missing' || state === 'corrupt') out.push({ rel: item.rel, label: item.label, reason: state });
  }
  return out;
}

/** 人类可读的字节数（日志用，避免 0.00 MB 这种看不清的数） */
export function describeBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}
