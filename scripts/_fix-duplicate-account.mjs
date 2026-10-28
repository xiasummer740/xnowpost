/**
 * 一次性清理：把 TK12（@ryloclyjdcf）并回 TK01（@xnow.matrix）。
 *
 * 来龙去脉（2026-10-24）：
 *   TK01 的 TikTok 用户名被改成 xnow.matrix 之后，再导入 10-18 那份老账号文件时，
 *   旧用户名 ryloclyjdcf 匹配不上 → 被当成新号分了 TK12，于是同一个号在凭据文件里出现两条
 *   （邮箱/密码/邮箱密码完全一样，TK12 反而多存了 2FA 密钥），而 FoxProfile 里根本没有 TK12 环境。
 *   正确做法：把 TK12 独有的字段（2FA 密钥）补到 TK01，然后删掉 TK12。
 *
 * 用法：
 *   node scripts/_fix-duplicate-account.mjs --from TK12 --into TK01 [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const val = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const from = String(val('--from', '')).toUpperCase();
const into = String(val('--into', '')).toUpperCase();
const dryRun = args.includes('--dry-run');
if (!from || !into) {
  console.error('用法: node scripts/_fix-duplicate-account.mjs --from TK12 --into TK01 [--dry-run]');
  process.exit(1);
}

const dataDir = process.env.XNOWPOST_DATA_DIR || path.join(os.homedir(), 'AppData', 'Roaming', 'xnowpost');
const file = path.join(dataDir, 'data', 'env-accounts.json');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const a = state[from];
const b = state[into];
if (!a) throw new Error(`${from} 不存在`);
if (!b) throw new Error(`${into} 不存在`);

// 只补「into 缺失、from 有」的字段；已有的一律不动（别覆盖用户在用的凭据）
const MERGE_FIELDS = ['totpSecret', 'email', 'emailPassword', 'password', 'region'];
const filled = [];
for (const k of MERGE_FIELDS) {
  if (!b[k] && a[k]) {
    b[k] = a[k];
    filled.push(k);
  }
}

// 邮箱/密码必须一致，否则不是同一个号 —— 不一致就拒绝执行（宁可不动）
const sameEmail = String(a.email || '').toLowerCase() === String(b.email || '').toLowerCase();
const samePass = String(a.password || '') === String(b.password || '');
console.log(`  ${from}: @${a.username}  ${a.email}`);
console.log(`  ${into}: @${b.username}  ${b.email}`);
console.log(`  邮箱一致: ${sameEmail}   密码一致: ${samePass}`);
if (!sameEmail || !samePass) {
  console.error('❌ 两条记录不是同一个号（邮箱或密码不一致），拒绝合并');
  process.exit(2);
}
console.log(`  补进 ${into} 的字段: ${filled.length ? filled.join(', ') : '（无，already 齐全）'}`);

if (dryRun) {
  console.log('  [dry-run] 不写盘');
  process.exit(0);
}

const backup = path.join(dataDir, 'data', `env-accounts.bak-${Date.now()}.json`);
fs.copyFileSync(file, backup);
delete state[from];
fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
console.log(`  ✅ 已删除 ${from}，备份: ${backup}`);
console.log(`  现在记录数: ${Object.keys(state).length}`);
