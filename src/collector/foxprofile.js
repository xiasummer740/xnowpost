/**
 * FoxProfile 指纹浏览器桥接
 *
 * FoxProfile 是 Firefox（Camoufox）内核，没有 CDP 端口，Playwright 的
 * connectOverCDP() 用不上。但采集器实际只用到 page 的三个方法
 * （goto / waitForTimeout / evaluate），所以这里做一个"假 page"，
 * 把调用翻译成 FoxProfile 的 HTTP 接口，采集器代码一行都不用改。
 *
 * 接口对照：
 *   page.goto(url)        → POST /browser/{name}/page/navigate
 *   page.evaluate(fn)     → POST /browser/{name}/page/evaluate
 *   page.waitForTimeout() → 本地 sleep（无需请求浏览器）
 */
import axios from 'axios';

const DEFAULT_BASE = 'http://127.0.0.1:8000/api/v1';
const NAME_SEG = (name) => encodeURIComponent(String(name || ''));

/** 接口地址（配置里可覆盖，默认本机 8000 端口） */
export function foxBase(base) {
  return String(base || process.env.FOXPROFILE_API || DEFAULT_BASE).replace(/\/+$/, '');
}

async function call(base, path, { method = 'GET', body, timeout = 60000 } = {}) {
  const url = `${foxBase(base)}${path}`;
  try {
    const resp = await axios.request({
      url,
      method,
      data: body,
      timeout,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    });
    return resp.data;
  } catch (e) {
    if (e.code === 'ECONNREFUSED' || e.code === 'ECONNABORTED') {
      throw new Error('FoxProfile 未运行（127.0.0.1:8000 连不上），请先双击桌面「FoxProfile 指纹浏览器」');
    }
    throw new Error(`FoxProfile 接口失败 ${path}: ${e.message}`);
  }
}

/** 健康检查 */
export async function foxHealth(base) {
  return call(base, '/health', { timeout: 5000 });
}

/** 环境列表 */
export async function listFoxProfiles(base) {
  const d = await call(base, '/profiles', { timeout: 10000 });
  return d?.profiles || [];
}

/** 当前正在运行的环境名列表 */
export async function foxRunning(base) {
  const d = await call(base, '/browser', { timeout: 10000 });
  return d?.running || [];
}

/**
 * 启动指定环境（wait=true 等到浏览器真正可用）
 *
 * focus=false：程序自动启动的浏览器不抢前台焦点，免得定时任务半夜把窗口弹到最前面。
 * 想看着它跑就传 focus=true（或直接在 FoxProfile 界面里点「启动」）。
 */
export async function foxLaunch(name, base, { focus = false } = {}) {
  if (!name) throw new Error('未指定浏览器环境名');
  const q = `wait=true${focus ? '&focus=true' : '&focus=false'}`;
  const res = await call(base, `/browser/${NAME_SEG(name)}/launch?${q}`, {
    method: 'POST',
    timeout: 180000,
  });
  return res;
}

/** 关闭指定环境 */
export async function foxStop(name, base) {
  if (!name) return { success: false };
  return call(base, `/browser/${NAME_SEG(name)}/stop`, { method: 'POST', timeout: 90000 });
}

/**
 * 只保留一个环境在跑：把除 envName 之外还开着的环境全部关掉。
 *
 * 这 10 个环境共用同一个出口 IP，同 IP 上同时跑多个号容易被平台关联。
 * 设 XNOWPOST_KEEP_OTHER_ENVS=1 可以关掉这个保护（想同时开多个时用）。
 */
export async function foxStopOthers(envName, base) {
  if (process.env.XNOWPOST_KEEP_OTHER_ENVS === '1') return [];
  const keep = String(envName || '').trim().toLowerCase();
  let running = [];
  try {
    running = await foxRunning(base);
  } catch {
    return []; // 拿不到列表就别乱关
  }
  const others = running.filter((n) => String(n).trim().toLowerCase() !== keep);
  const stopped = [];
  for (const name of others) {
    try {
      await foxStop(name, base);
      stopped.push(name);
    } catch (_) { /* 关不掉不影响主流程 */ }
  }
  return stopped;
}

/**
 * 假 page：把 Playwright 的调用翻译成 FoxProfile HTTP 请求
 */
class FoxPage {
  constructor(name, base) {
    this.name = name;
    this.base = base;
    this._url = '';
    this._title = '';
  }

  async goto(url, opts = {}) {
    const waitUntil = ['load', 'domcontentloaded', 'networkidle'].includes(opts.waitUntil)
      ? opts.waitUntil
      : 'load';
    const d = await call(this.base, `/browser/${NAME_SEG(this.name)}/page/navigate`, {
      method: 'POST',
      body: { url: String(url), wait_until: waitUntil },
      timeout: opts.timeout || 60000,
    });
    if (d?.url) this._url = d.url;
    if (d?.title) this._title = d.title;
    return d;
  }

  async waitForTimeout(ms) {
    const wait = Math.max(0, Number(ms) || 0);
    await new Promise((r) => setTimeout(r, wait));
  }

  /**
   * 支持传函数（和 Playwright 一样）或直接传表达式字符串。
   * 函数会被序列化成 IIFE 交给浏览器执行。
   */
  async evaluate(fn, arg) {
    let script;
    if (typeof fn === 'function') {
      const src = fn.toString();
      script = arg === undefined ? `(${src})()` : `(${src})(${JSON.stringify(arg)})`;
    } else {
      script = String(fn);
    }
    const d = await call(this.base, `/browser/${NAME_SEG(this.name)}/page/evaluate`, {
      method: 'POST',
      body: { script },
      timeout: 60000,
    });
    return d?.result;
  }

  async text() {
    const d = await call(this.base, `/browser/${NAME_SEG(this.name)}/page/text`, { timeout: 30000 });
    return d?.text || '';
  }

  url() {
    return this._url;
  }

  async title() {
    return this._title;
  }

  /** 环境在采集结束后整体停止，这里不需要单独关页 */
  async close() {
    /* no-op */
  }
}

/**
 * 打开一个 FoxProfile 环境，返回与比特浏览器一致的 { context, page } 结构
 */
export async function openFoxProfile(name, base) {
  const envName = String(name || '').trim();
  if (!envName) throw new Error('未配置浏览器环境名');

  // 先校验环境存在，避免"打开了但名字拼错"的沉默失败
  const profiles = await listFoxProfiles(base);
  if (!profiles.some((p) => p.name === envName)) {
    const names = profiles.slice(0, 10).map((p) => p.name).join(', ');
    throw new Error(`FoxProfile 里没有名为「${envName}」的环境（现有: ${names || '无'}）`);
  }

  // 这 10 个环境共用一个出口 IP，同 IP 同时跑多个号容易被关联，先收掉其它环境
  const others = await foxStopOthers(envName, base);
  if (others.length) {
    console.log(`  🧹 已关闭其它还在运行的环境: ${others.join(', ')}（同 IP 只跑一个）`);
  }

  const d = await foxLaunch(envName, base);
  if (d && d.success === false) {
    throw new Error(d.message || `环境 ${envName} 启动失败`);
  }

  console.log(`  ✅ 指纹环境 ${envName} 已启动`);
  const page = new FoxPage(envName, base);
  return { name: envName, page, context: { newPage: async () => page }, browser: null };
}

/** 关闭一个环境 */
export async function closeFoxProfile(name, base) {
  const envName = String(name || '').trim();
  if (!envName) return;
  try {
    const ok = await foxStop(envName, base);
    if (ok && ok.success !== false) console.log(`  ✅ 指纹环境 ${envName} 已关闭`);
    else console.warn(`  ⚠️ 指纹环境 ${envName} 关闭未确认`);
  } catch (e) {
    console.warn(`  ⚠️ 关闭指纹环境 ${envName} 失败: ${e.message}`);
  }
}

/** 采集前清理所有残留窗口，防止累积占内存 */
export async function closeAllFoxProfiles(base) {
  try {
    const running = await foxRunning(base);
    if (!running.length) return;
    console.log(`  🧹 发现 ${running.length} 个残留窗口，正在关闭...`);
    await Promise.allSettled(running.map((n) => foxStop(n, base)));
    console.log(`  ✅ 已关闭 ${running.length} 个残留窗口`);
  } catch (_) {
    /* 清理失败不阻断采集 */
  }
}

/**
 * 新建一个指纹环境（用于账号数多于现有环境时自动补齐）。
 * 代理/时区/语言一般照抄模板环境，保证新号和老号环境一致。
 */
export async function foxCreateProfile({ name, proxy, osType = 'windows', timezone, locale, engine = 'camoufox' }, base) {
  if (!name) throw new Error('新建环境需要名字');
  const body = { name, os_type: osType, engine };
  if (proxy) body.proxy = proxy;
  if (timezone) body.timezone = timezone;
  if (locale) body.locale = locale;
  const d = await call(base, '/profiles', { method: 'POST', body, timeout: 60000 });
  if (d && d.success === false) throw new Error(d.message || `新建环境 ${name} 失败`);
  return d;
}

/**
 * 导出环境的 cookie（要求该环境已停止）。
 * 返回纯文本：format=json → Cookie-Editor 格式；format=netscape → cookies.txt
 * 路由是 GET /profiles/{name}/cookies（不是 export-cookies）
 */
export async function foxExportCookies(name, base, format = 'json') {
  const f = format === 'netscape' ? 'netscape' : 'json';
  const d = await call(base, `/profiles/${NAME_SEG(name)}/cookies?format=${f}`, { timeout: 60000 });
  const text = typeof d === 'string' ? d : JSON.stringify(d);
  // 接口出错时后端会返回 {"detail":"Not Found"} 之类，别把错误内容当成 cookie 存下来
  if (!text || /^\s*\{\s*"detail"/.test(text) || /^\s*\{\s*"success"\s*:\s*false/.test(text)) {
    throw new Error(`导出 cookie 失败: ${text.slice(0, 120) || '空响应'}`);
  }
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object') {
    if (d.success === false) throw new Error(d.message || '导出 cookie 失败');
    return JSON.stringify(d, null, 2);
  }
  return String(d ?? '');
}



