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
import path from 'node:path';
import { execFile } from 'node:child_process';

const DEFAULT_BASE = 'http://127.0.0.1:8000/api/v1';
const NAME_SEG = (name) => encodeURIComponent(String(name || ''));

/** FoxProfile 的 camoufox_data 目录（每个环境一个子目录） */
function foxDataDir() {
  return process.env.FOXPROFILE_DATA || 'E:/software/FoxProfile/camoufox_data';
}

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
 * 页面通道真的就绪了吗？—— **这是"能不能用"的唯一判据**。
 *
 * ⚠️ 2026-10-29 事故（14:00 那轮养号 6/11 全废）：
 * `/browser` 返回的 running 只代表**进程还活着**。FoxProfile 内部还要等浏览器把
 * 控制通道登记上（`self._controls[name] = (port, token)`），这之前任何页面动作都返回
 * `503 {"detail":"Browser is still starting"}`。
 * 旧版 launchAndWait 一看 running 里有它就当成功 → 第一个页面动作立刻 503
 * → TK06–TK11 六个号整轮被判「养号失败：Browser is still starting」，
 * 而浏览器其实 20 秒后就完全可用了。
 *
 * 探针用 `GET /page/tabs`：它必须走控制通道，通得回来才算真就绪（不打开新页、不改状态）。
 */
export async function foxPageReady(name, base) {
  try {
    const d = await call(base, `/browser/${NAME_SEG(name)}/page/tabs`, { timeout: 5000 });
    if (!d) return false;
    const bad = String(d.detail || d.message || '');
    if (/still starting|not running|未运行|启动中/i.test(bad)) return false;
    if (d.success === false) return false;
    return Array.isArray(d.tabs);
  } catch (_) {
    return false;
  }
}

/**
 * 硬重置一个"卡住的启动"：停环境 → （还在 running 就）按 profile 路径杀残留 camoufox
 * → 删掉 Firefox 的 `parent.lock` → 让调用方重新 launch。
 *
 * ⚠️ 2026-10-30 实测（这功能就是为它写的）：12:23 / 12:26 / 12:30 连续三次启动 TK02
 * 都卡在 `BrowserType.launch_persistent_context: Timeout 180000ms exceeded` ——
 * 窗口开出来了、`/browser` 说 running，但控制通道 150 秒都不登记，任何页面动作都是
 * 503 `Browser is still starting`。原因是前一次失败留下的 camoufox / runner.py 进程
 * 还在占着这个 profile（`parent.lock` 也在），新的 Firefox 起不来。
 * 手工清掉残留进程 + 删 lock 之后，同样的 launch **10.1 秒**就绪。
 *
 * 只在"等了很久还不就绪"这条路上调用，正常启动完全不受影响。
 */
export async function foxHardReset(name, base, { waitMs = 6000 } = {}) {
  const out = { stopped: false, killed: 0, lockRemoved: false };
  if (!name) return out;
  try {
    await foxStop(name, base);
    out.stopped = true;
  } catch (_) { /* 停不掉也继续往下清 */ }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    let running = [];
    try {
      running = await foxRunning(base);
    } catch (_) {
      break;
    }
    if (!running.includes(name)) break;
  }
  let stillRunning = false;
  try {
    stillRunning = (await foxRunning(base)).includes(name);
  } catch (_) { /* 查不到就当没在跑 */ }
  if (stillRunning) out.killed = await killCamoufoxFor(name);
  // Firefox 的 profile 锁：进程被强杀后不会自己清，留着会让下一次启动永远等不到握手
  try {
    const lock = path.join(foxDataDir(), String(name), 'parent.lock');
    if (fs.existsSync(lock)) {
      fs.rmSync(lock, { force: true });
      out.lockRemoved = true;
    }
  } catch (_) { /* 删不掉就交给下一次尝试 */ }
  return out;
}

/** 按命令行里的 profile 路径杀掉某个环境残留的 camoufox（只杀这一个环境，别误伤） */
async function killCamoufoxFor(name) {
  if (process.platform !== 'win32') return 0;
  const seg = String(name).replace(/['"]/g, '');
  const ps = [
    `$n='${seg}';`,
    "$p = Get-CimInstance Win32_Process -Filter \"Name='camoufox.exe'\" |",
    "  Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape(\"camoufox_data\\\" + $n) };",
    'foreach ($x in $p) { try { Stop-Process -Id $x.ProcessId -Force -ErrorAction Stop; $c++ } catch {} }',
    'if ($c) { Write-Output $c }',
  ].join(' ');
  return await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 20000 },
      (err, stdout) => resolve(err ? 0 : (Number(String(stdout).trim()) || 0)));
  });
}

/**
 * 这次的失败是不是"启动超时"这一类（卡住的 profile）？
 *
 * 只认超时/还在启动 —— 别把 `Launch failed: cannot start browser`（配置/环境问题）
 * 也算进来：那种清理一百遍也没用，应该立刻把错误抛给调用方。
 */
function isLaunchTimeout(d) {
  if (!d || d.success !== false) return false;
  const m = String(d.message || d.detail || '');
  return /timeout|timed out|still starting|starting up/i.test(m);
}

/** 把"LAUNCH_FAILED: TimeoutError: … Timeout 180000ms exceeded"缩成一行好读的 */
function brief(msg, max = 60) {
  const s = String(msg || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 启动环境，等它**真的能用**（不是"进程起来了"）。
 *
 * ⚠️ 2026-10-20 23:31 实测：`launch?wait=true` 仍可能立刻返回
 * `{"success":false,"message":"Browser is still starting"}`，或者等满
 * `FOXPROFILE_LAUNCH_TIMEOUT`（默认 90s）后返回 202 + `"Browser for 'X' is still starting"`
 * —— 上一步刚 stop 掉别的环境时，Camoufox 还在收尾，下一个环境就抢不到。
 * 旧代码把"进程在 running 列表里"当成就绪，于是第一个页面动作直接撞 503（见 foxPageReady）。
 * 现在统一等 `foxPageReady` 通过才返回，调用方拿到的一定是能点能读的浏览器。
 * 2026-10-22 起发布/采集/养号都走这一个函数，别再各写一份。
 *
 * @param {number} readySeconds 等页面通道就绪的上限（默认 150s：留够 11 个号串行的余量）
 * @param {number} pollMs 轮询间隔（单测里调小，别真等 2 秒）
 */
export async function launchAndWait(name, base, { focus = false, readySeconds = 150, pollMs = 2000, hardResetAfterMs = 60000 } = {}) {
  let d = await foxLaunch(name, base, { focus }).catch((e) => ({ success: false, message: e.message }));

  // 「启动超时」这一类失败 = 卡住的 profile（残留 camoufox / runner 占着，parent.lock 还在）。
  // ⚠️ 2026-10-30 20:18 实测：TK09/TK10 各自耗满 FoxProfile 的 180 秒超时后才报
  // `LAUNCH_FAILED: ... Timeout 180000ms exceeded` —— 这场等待把整个就绪窗口都吃掉了，
  // 而旧代码把这类失败当"真失败"直接返回，于是整轮判「没养成」。
  // 现在先清理（停环境 + 杀该环境残留 camoufox + 删 parent.lock）再重开**一次**。
  if (isLaunchTimeout(d)) {
    console.log(`  🔧 ${name} 启动超时（${brief(d && d.message)}）—— 清理残留进程和 profile 锁后重开一次`);
    const r = await foxHardReset(name, base).catch(() => null);
    console.log(`  🧹 已停环境${r && r.killed ? `、杀掉 ${r.killed} 个残留 camoufox` : ''}`
      + `${r && r.lockRemoved ? '、删掉 parent.lock' : ''}，重新启动`);
    d = await foxLaunch(name, base, { focus }).catch((e) => ({ success: false, message: e.message }));
  }
  // 其它真失败（端口/配置/环境不存在）立刻报，别拿 150 秒去等一个起不来的东西
  if (d && d.success === false && !isLaunchTimeout(d)) return d;
  if (await foxPageReady(name, base)) return { success: true };

  // 就绪窗口从"启动动作返回之后"开始算：启动本身可能已经等了 180 秒
  const t0 = Date.now();
  console.log(`  ⏳ ${name} 进程已起、页面通道还没就绪，等它（最多 ${readySeconds} 秒）...`);
  let relaunched = 0;
  let hardResetDone = false;
  while (Date.now() - t0 < readySeconds * 1000) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (await foxPageReady(name, base)) {
      console.log(`  ✅ ${name} 已就绪（等了 ${Math.round((Date.now() - t0) / 1000)} 秒）`);
      return { success: true };
    }
    // 「进程在、控制通道一直不上来」= 卡住的启动（残留进程占着 profile），清理后重开一次。
    // 只做一次，别把就绪窗口全花在反复清理上。
    if (!hardResetDone && Date.now() - t0 > hardResetAfterMs) {
      hardResetDone = true;
      console.log(`  🔧 ${name} 的页面通道 ${Math.round(hardResetAfterMs / 1000)} 秒没上来 —— 清理残留进程和 profile 锁后重开`);
      const r = await foxHardReset(name, base).catch(() => null);
      console.log(`  🧹 已停环境${r && r.killed ? `、杀掉 ${r.killed} 个残留 camoufox` : ''}`
        + `${r && r.lockRemoved ? '、删掉 parent.lock' : ''}，重新启动`);
      try {
        await foxLaunch(name, base, { focus });
      } catch (_) { /* 继续等到超时 */ }
      continue;
    }
    // 进程根本没在跑（被上一轮的 stop 挤掉了）→ 补一次 launch，最多 3 次
    if (relaunched < 3 && Date.now() - t0 > 8000) {
      let running = [];
      try {
        running = await foxRunning(base);
      } catch (_) { /* 查不到就继续等 */ }
      if (!running.includes(name)) {
        relaunched++;
        console.log(`  🔄 ${name} 不在运行列表里，补启动一次（第 ${relaunched} 次）`);
        try {
          await foxLaunch(name, base, { focus });
        } catch (_) { /* 继续等 */ }
      }
    }
  }
  return {
    success: false,
    message: `环境 ${name} 的浏览器进程起来了，但页面 ${readySeconds} 秒都没就绪`
      + `（已清理残留进程并重开过一次；这一轮跳过它，下一轮会重新开）。`,
  };
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
  // 关完别立刻开下一个：Camoufox 进程还在收尾时 launch 会被挤掉，
  // 表现为"Browser is still starting"（2026-10-29 14:00 那轮 6/11 就是这么废的）。
  // 这里最多等 15 秒，等它真的从 running 列表里消失。
  if (stopped.length) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      let still = [];
      try {
        still = await foxRunning(base);
      } catch (_) {
        break; // 查不到就别死等
      }
      if (!still.some((n) => stopped.some((s) => String(s).trim().toLowerCase() === String(n).trim().toLowerCase()))) break;
    }
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



