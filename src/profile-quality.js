/**
 * 账号资料"抓到了"和"资料是好的"是两件事（v1.6.56）。
 *
 * 2026-10-20 23:36 实测 TK07：昵称被平台退回成用户名、简介为空，
 * 但抓取脚本照样打 ✅ —— 用户看日志会以为 10 个号都正常。
 * 判定抽成纯函数，脚本和单测共用一份口径。
 */

/**
 * @param {{username?:string, nickname?:string, bio?:string, avatarUrl?:string, avatarSha?:string}} p
 * @returns {{ok:boolean, problems:string[]}}
 */
export function judgeProfileCompleteness(p = {}) {
  const problems = [];
  const handle = String(p.username || '').trim();
  const nick = String(p.nickname || '').trim();
  const bio = String(p.bio || '').trim();
  if (!nick) problems.push('昵称为空');
  else if (handle && nick.toLowerCase() === handle.toLowerCase()) problems.push('昵称退回了用户名');
  if (!bio) problems.push('简介为空');
  if (!String(p.avatarUrl || '').trim() || !String(p.avatarSha || '').trim()) problems.push('头像没拿到');
  return { ok: problems.length === 0, problems };
}

/**
 * 判断这个错误是不是"页面自己跳转把我们的导航打断了"。
 *
 * 2026-10-21 13:41 实测：TikTok 会把带 `?_r=` 的地址跳回干净地址，
 * Playwright 抛 `Page.goto: Navigation to "…?_r=…" is interrupted by another navigation to "…/@user"`。
 * 这**不是**打不开页面（页面已经开了），当成失败就会整轮漏掉那个号（TK07 就是这样被跳过的）。
 */
export function isNavigationInterrupted(err) {
  const msg = String(err && err.message ? err.message : err || '');
  return /interrupted by another navigation|NS_BINDING_ABORTED|navigation aborted/i.test(msg);
}