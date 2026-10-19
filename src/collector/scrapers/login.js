/**
 * 采集器页面读取与登录态检测
 *
 * 背景（P2-14）：6 个采集器里有 5 个完全没有登录检测，未登录时页面照样能扫出几个数字，
 * 于是"编造指标"被当成真实数据写进库里。这里把登录判定收敛成一处：
 * 未登录 / 被重定向到登录页 / 页面空白 → **直接抛错**，由调用方（collector）记为该账号失败。
 */

const LOGIN_URL_RE = /(\/login|\/signin|\/sign-in|\/sign_in|\/accounts\/login|\/auth\/|\/passport\/|accounts\.google\.com|\/i\/flow\/login|\/login\.php)/i;

// 强登录特征：命中一个即可判定未登录
const STRONG_LOGIN_HINTS = [
  'forgot password', '忘记密码', 'create new account', '创建新账号', '注册', '註冊', 'sign up', '免費註冊',
  'use another account', '使用其他账号', '手机号/邮箱/用户名', '手机号 / 邮箱 / 用户名',
  'continue with google', '使用 google 继续',
];

// 弱登录特征：需要同时命中两个、且页面没有仪表盘特征时才算未登录
const WEAK_LOGIN_HINTS = ['log in', 'login', 'sign in', '登录', '登入'];

// 仪表盘特征：出现这些说明确实进到了后台（用来压低误报）
const DASHBOARD_HINTS = [
  'creator center', '创作者中心', '创作者服務中心', 'studio', 'analytics', '数据概览', '數據概覽',
  'dashboard', 'overview', '仪表盘', '儀表板', 'followers', '粉丝', 'subscribers', '订阅',
  'logout', '退出登录', '退出帳號',
];

/**
 * 判断页面是否处于未登录态
 * @param {{url?: string, title?: string, text?: string}} page
 * @returns {{loggedOut: boolean, reason: string}}
 */
export function detectLoginState({ url = '', title = '', text = '' } = {}) {
  if (LOGIN_URL_RE.test(String(url))) {
    return { loggedOut: true, reason: `被重定向到登录页 ${url}` };
  }
  const hay = `${title}\n${text}`.toLowerCase();
  const strong = STRONG_LOGIN_HINTS.filter(h => hay.includes(h));
  if (strong.length) {
    return { loggedOut: true, reason: `页面出现登录/注册提示（${strong.slice(0, 3).join('/')}）` };
  }
  const weak = WEAK_LOGIN_HINTS.filter(h => hay.includes(h));
  const hasDashboard = DASHBOARD_HINTS.some(h => hay.includes(h));
  if (weak.length >= 2 && !hasDashboard) {
    return { loggedOut: true, reason: `页面出现多处登录提示（${weak.slice(0, 3).join('/')}）` };
  }
  return { loggedOut: false, reason: '' };
}

/**
 * 在页面上下文中执行：只负责把原始文本取回来。
 * 解析统一放在 Node 侧（可测试、可复用，登录判定也不该跑在页面里）。
 */
export function readPageText() {
  const text = document.body ? document.body.innerText : '';
  return {
    url: location.href,
    title: document.title,
    lines: text.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 400),
    text: text.slice(0, 100000),
  };
}

/**
 * 读取仪表盘页面并做登录/加载检查
 * @param {import('playwright').Page} page
 * @param {string} platform 平台名，用于报错信息
 */
export async function readDashboard(page, platform) {
  const raw = await page.evaluate(readPageText);
  const state = detectLoginState({ url: raw.url, title: raw.title, text: raw.lines.join('\n') });
  if (state.loggedOut) {
    throw new Error(`${platform} 未登录：${state.reason}。为避免编造数据，本次不返回任何指标，请先在该比特环境中登录账号`);
  }
  if (!raw.lines || raw.lines.length < 3) {
    throw new Error(`${platform} 页面内容为空（${raw.url}），可能未加载完成或页面结构已变化`);
  }
  return raw;
}

/** 从页面文本/URL 里取 @用户名（不参与指标解析） */
export function pickAtUsername(text, url = '') {
  const m = String(text || '').match(/@([A-Za-z0-9._]{2,30})/);
  if (m) return m[0];
  const u = String(url || '').match(/@([A-Za-z0-9._]{2,30})/);
  return u ? u[0] : '';
}
