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
import fs from 'node:fs';

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

/**
 * 确保 FoxProfile 在跑：探不通就自己把服务拉起来，然后等它就绪。
 *
 * 为什么要有它（2026-10-24 真实事故）：FoxProfile 没有托盘，夜里自己退出/被关掉之后，
 * 02:00 那轮养号 0/10、早上 08:30–09:15 十轮发布全部「FoxProfile 未运行」，
 * 10:00 采集也全废 —— 而引擎那边已经把视频生成完了（钱花了，东西没发出去）。
 * 调度器是独立进程，应用启动时的守护管不到它，所以每个"要开环境"的入口都得自己兜住。
 *
 * 返回 true = API 可用（原本就在跑，或刚被拉起来）。
 */
let _lastAutoStart = 0;
export async function ensureFoxProfile(base, { waitSeconds = 90 } = {}) {
  const alive = async () => {
    try {
      await call(base, '/browser', { timeout: 3000 });
      return true;
    } catch (_) {
      return false;
    }
  };

  if (await alive()) return true;

  // 多个账号/多轮任务会连着调，60 秒内只拉起一次，别把界面开成一堆
  if (Date.now() - _lastAutoStart > 60000) {
    _lastAutoStart = Date.now();
    try {
      const { spawn, execFileSync } = await import('node:child_process');
      const path = await import('node:path');
      const { resolveCodeRoot } = await import('../paths.js');
      const script = path.join(resolveCodeRoot(), 'scripts', 'foxprofile-guard.ps1');
      if (fs.existsSync(script)) {
        console.log('  🧩 FoxProfile 没在运行 → 自动拉起（约 10 秒）');
        const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
          windowsHide: true,
          detached: false,
          stdio: 'ignore',
        });
        child.unref?.();
      } else {
        console.warn('  ⚠️ 找不到 scripts/foxprofile-guard.ps1，无法自动拉起 FoxProfile');
      }
    } catch (e) {
      console.warn(`  ⚠️ 自动拉起 FoxProfile 失败: ${e.message}`);
    }
  }

  const rounds = Math.max(1, Math.ceil(waitSeconds / 2));
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await alive()) {
      console.log('  ✅ FoxProfile 已就绪（自动拉起）');
      return true;
    }
  }
  return false;
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
 * 启动环境，并且把「Browser is still starting」当成"还没好"来处理。
 *
 * ⚠️ 2026-10-20 23:31 实测：`launch?wait=true` 仍可能立刻返回
 * `{"success":false,"message":"Browser is still starting"}` —— 上一步刚 stop 掉别的环境时，
 * Camoufox 进程还在收尾，下一个环境就抢不到。旧代码直接判失败，
 * 结果那个号整轮没数据（用户手动抓资料时 TK02 就被跳过，资料停在 5 小时前）。
 * 2026-10-22 起发布/采集/养号都走这一个函数，别再各写一份。
 */
export async function launchAndWait(name, base, { focus = false } = {}) {
  let d = await foxLaunch(name, base, { focus });
  if (!(d && d.success === false && /still starting|starting|starting up/i.test(String(d.message || '')))) {
    return d;
  }
  console.log(`  ⏳ ${name} 还在启动中，等它就绪（最多 90 秒）...`);
  const startedAt = Date.now();
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    let running = [];
    try {
      running = await foxRunning(base);
    } catch (_) { /* 状态查不到就继续等 */ }
    if (running.includes(name)) {
      d = { success: true };
      break;
    }
    // 没在运行列表里就再补一次 launch（有些版本 stop 完成后 launch 才会真正接管）
    if (i === 10 || i === 25) {
      try {
        const retry = await foxLaunch(name, base, { focus });
        if (retry && retry.success !== false) { d = retry; break; }
      } catch (_) { /* 继续等 */ }
    }
    if (Date.now() - startedAt > 90000) break;
  }
  if (d && d.success !== false) {
    console.log(`  ✅ ${name} 已就绪（等了 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`);
  }
  return d;
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
export async function openFoxProfile(name, base, opts = {}) {
  const envName = String(name || '').trim();
  if (!envName) throw new Error('未配置浏览器环境名');

  // 服务没在跑就先拉起来（夜里挂掉会让整轮任务白跑，见 ensureFoxProfile 注释）
  await ensureFoxProfile(base);

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

  let d = await launchAndWait(envName, base);
  if (d && d.success === false) {
    throw new Error(d.message || `环境 ${envName} 启动失败`);
  }

  console.log(`  ✅ 指纹环境 ${envName} 已启动`);
  // 采集全程只读（goto + evaluate，不发鼠标事件），所以可以把窗口缩到任务栏不挡屏幕。
  // 注意：要点击的任务（养号/发布）不能最小化 —— 最小化后鼠标事件点不动。
  if (opts.minimize) {
    try {
      const { minimizeEnvWindow } = await import('./fox-window.js');
      if (minimizeEnvWindow(envName)) console.log(`  🗕 已把 ${envName} 的窗口缩到任务栏`);
    } catch (_) { /* 缩不了不影响采集 */ }
  }
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



