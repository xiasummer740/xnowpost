/**
 * 账号 → 环境 的分配规则（界面导入、命令行批量登录**共用这一份**）。
 *
 * 为什么要有它（2026-10-24 用户提问「我要加 1 个 / 10 个 / 20 个号，怎么最方便」）：
 * 老规则是「文件第 N 行 = TKNN」，于是想加第 11 个号就得把前 10 个号也写进文件；
 * 只给新增的号，新号会被按行号错配到 TK01 并**覆盖掉 TK01 的凭据**（真事故级风险）。
 *
 * 新规则：
 *   1. 用户名已经登记过（`env-accounts.json` 里查得到）→ 永远留在它原来的环境，绝不搬家；
 *   2. 用户名没登记过、但**邮箱对得上**某个已登记的环境 → 也算同一个号（认到原环境）。
 *      为什么要有这条（2026-10-24 真实事故）：TK01 改过用户名（`ryloclyjdcf` → `xnow.matrix`），
 *      再导入那份老账号文件时，旧用户名匹配不上 → 被当成新号分了 `TK12`，
 *      结果同一个号在凭据文件里出现两条（邮箱/密码/2FA 完全一样），而 FoxProfile 里根本没有 TK12 环境。
 *      TikTok 的邮箱唯一，所以「邮箱相同 = 同一个号」，把它认回原环境并顺手更新用户名即可。
 *   3. 新用户名 → 分配**当前最小的空号**（TK11、TK12…），不会碰已有环境；
 *   4. 同一份文件里重复的同一用户名只分配一次，重复行标记 `duplicate: true`（调用方跳过）。
 *
 * @param {Array<{username?:string, email?:string}>} rows   账号文件解析出来的行（顺序即文件顺序）
 * @param {Record<string,{username?:string, email?:string}>} state  `data/env-accounts.json`
 * @param {string[]} [knownEnvs]             FoxProfile 里已存在的环境名（用来避开空号撞车）
 * @returns {Array<{index:number, env:string, username:string, duplicate:boolean}>}
 */
export function allocateAccountEnvs(rows, state, knownEnvs = []) {
  const envOf = (n) => `TK${String(n).padStart(2, '0')}`;

  const byUser = new Map();
  const byEmail = new Map();
  for (const [env, v] of Object.entries(state || {})) {
    const user = v && v.username ? String(v.username).trim().toLowerCase() : '';
    if (user) byUser.set(user, String(env).toUpperCase());
    const mail = v && v.email ? String(v.email).trim().toLowerCase() : '';
    if (mail) byEmail.set(mail, String(env).toUpperCase());
  }

  const taken = new Set();
  const mark = (env) => {
    const m = /^TK(\d+)$/i.exec(String(env || ''));
    if (m) taken.add(Number(m[1]));
  };
  Object.keys(state || {}).forEach(mark);
  (knownEnvs || []).forEach(mark);

  const nextFree = () => {
    let n = 1;
    while (taken.has(n)) n += 1;
    taken.add(n);
    return envOf(n);
  };

  const seen = new Set();
  const out = [];
  (rows || []).forEach((row, i) => {
    const username = String((row && row.username) || '').trim();
    if (!username) return;
    const key = username.toLowerCase();
    if (seen.has(key)) {
      out.push({ index: i + 1, env: byUser.get(key) || '', username, duplicate: true });
      return;
    }
    seen.add(key);
    let env = byUser.get(key);
    if (!env) {
      // 用户名没匹配上 → 再看邮箱是不是同一个号（改过用户名的情况）
      const mail = String((row && row.email) || '').trim().toLowerCase();
      if (mail) env = byEmail.get(mail);
      if (env) {
        // 认回原环境，并把新用户名记上（旧用户名以后不再需要，但留着也能匹配）
        byUser.set(key, env);
      }
    }
    if (!env) {
      env = nextFree();
      byUser.set(key, env);
    }
    out.push({ index: i + 1, env, username, duplicate: false });
  });
  return out;
}
