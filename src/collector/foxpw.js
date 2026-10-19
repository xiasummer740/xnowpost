/**
 * Playwright 形状的代理（发布器专用）
 *
 * 背景：发布器（src/publisher/tiktok.js，800+ 行）是用 Playwright 写的，
 * 依赖 locator 链式调用、键盘鼠标、文件上传、对话框处理。但 Camoufox 是
 * Firefox 内核，没有 CDP 端口，Playwright 连不上去。
 *
 * 解法：浏览器仍由 FoxProfile 启动（指纹/代理才是对的），FoxProfile 那边
 * 新增了 /page/pw 通道，可以把「一串 Playwright 调用」在它自己的 page 对象上
 * 依次执行。这里就做一个长得像 Playwright 的代理，把这些调用翻译过去：
 *
 *   page.locator('#x').first().click({ timeout: 5000 })
 *     → POST /page/pw { chain: [ {locator}, {first}, {click} ] }
 *
 * 这样发布器的业务逻辑（等视频处理完、填标题、开 AIGC 开关、点发布…）一行都不用重写。
 */
import axios from 'axios';
import { foxBase, listFoxProfiles, foxLaunch, foxStop, foxStopOthers } from './foxprofile.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

/** JS 选项名 → Python 关键字名（waitUntil → wait_until、hasText → has_text） */
function toKw(opts) {
  const out = {};
  for (const [k, v] of Object.entries(opts || {})) {
    if (v === undefined) continue;
    out[k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())] = v;
  }
  return out;
}

/** 把函数或字符串变成可执行的 JS 表达式（带参数时包成 IIFE） */
function toScript(fn, arg) {
  if (typeof fn !== 'function') return String(fn);
  const src = `(${fn.toString()})`;
  return arg === undefined ? `${src}()` : `${src}(${JSON.stringify(arg)})`;
}

class FoxClient {
  constructor(name, base) {
    this.name = name;
    this.base = base;
  }

  async chain(steps) {
    const url = `${foxBase(this.base)}/browser/${encodeURIComponent(this.name)}/page/pw`;
    let resp;
    try {
      resp = await axios.post(url, { chain: steps }, {
        timeout: 180000,
        validateStatus: () => true,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      if (e.code === 'ECONNREFUSED') throw new Error('FoxProfile 未运行（127.0.0.1:8000 连不上）');
      throw new Error(`浏览器调用失败: ${e.message}`);
    }
    if (resp.status !== 200) {
      const detail = resp.data?.detail || resp.data?.error || `HTTP ${resp.status}`;
      throw new Error(String(detail));
    }
    return resp.data;
  }

  async post(path, body) {
    const url = `${foxBase(this.base)}/browser/${encodeURIComponent(this.name)}${path}`;
    const resp = await axios.post(url, body || {}, {
      timeout: 180000,
      validateStatus: () => true,
      headers: { 'Content-Type': 'application/json' },
    });
    if (resp.status !== 200) {
      throw new Error(String(resp.data?.detail || resp.data?.error || `HTTP ${resp.status}`));
    }
    return resp.data;
  }

  async get(path, params) {
    const url = `${foxBase(this.base)}/browser/${encodeURIComponent(this.name)}${path}`;
    const resp = await axios.get(url, {
      params: params || {},
      timeout: 180000,
      validateStatus: () => true,
    });
    if (resp.status !== 200) {
      throw new Error(String(resp.data?.detail || resp.data?.error || `HTTP ${resp.status}`));
    }
    return resp.data;
  }
}

/** Locator 代理：累积调用链，真正执行时才发请求 */
class Locator {
  constructor(page, steps) {
    this._page = page;
    this._steps = steps;
  }

  _with(step) {
    return new Locator(this._page, [...this._steps, step]);
  }

  async _call(method, args = [], opts = null) {
    const step = { m: method, a: args };
    if (opts && Object.keys(opts).length) step.k = toKw(opts);
    const data = await this._page._client.chain([...this._steps, step]);
    this._page._touch(data);
    return data.result;
  }

  // --- 结构 ---
  first() { return this._with({ m: 'first' }); }
  last() { return this._with({ m: 'last' }); }
  nth(i) { return this._with({ m: 'nth', a: [i] }); }
  locator(sel) { return this._with({ m: 'locator', a: [String(sel)] }); }
  filter() {
    throw new Error('locator.filter() 尚未在 FoxProfile 通道里实现');
  }

  // --- 动作 ---
  click(opts) { return this._call('click', [], opts); }
  dblclick(opts) { return this._call('dblclick', [], opts); }
  hover(opts) { return this._call('hover', [], opts); }
  focus() { return this._call('focus'); }
  fill(text, opts) { return this._call('fill', [String(text)], opts); }
  press(key, opts) { return this._call('press', [String(key)], opts); }
  pressSequentially(text, opts) { return this._call('press_sequentially', [String(text)], opts); }
  dispatchEvent(type, eventInit) {
    return this._call('dispatch_event', eventInit === undefined ? [String(type)] : [String(type), eventInit]);
  }
  scrollIntoViewIfNeeded(opts) { return this._call('scroll_into_view_if_needed', [], opts); }
  check(opts) { return this._call('check', [], opts); }
  uncheck(opts) { return this._call('uncheck', [], opts); }
  selectOption(values, opts) { return this._call('select_option', [values], opts); }
  waitFor(opts) { return this._call('wait_for', [], opts); }

  // --- 取值（Python 侧这些方法不吃 timeout，去掉避免 TypeError） ---
  innerText() { return this._call('inner_text'); }
  textContent() { return this._call('text_content'); }
  inputValue() { return this._call('input_value'); }
  getAttribute(name) { return this._call('get_attribute', [String(name)]); }
  isVisible(opts) { return this._call('is_visible', [], opts); }
  isChecked(opts) { return this._call('is_checked', [], opts); }
  isEnabled(opts) { return this._call('is_enabled', [], opts); }
  isDisabled(opts) { return this._call('is_disabled', [], opts); }
  count() { return this._call('count'); }
  allTextContents() { return this._call('all_text_contents'); }
  evaluate(fn, arg) { return this._call('evaluate', [toScript(fn, arg)]); }

  /** 直接给 <input type=file> 塞文件 */
  async setInputFiles(filePath) {
    const sel = this._selector();
    if (!sel) throw new Error('setInputFiles 需要先用 locator(选择器) 定位');
    await this._page.uploadFile(sel, filePath);
  }

  _selector() {
    for (let i = this._steps.length - 1; i >= 0; i--) {
      if (this._steps[i].m === 'locator') return this._steps[i].a[0];
    }
    return '';
  }
}

class Keyboard {
  constructor(page) { this._page = page; }
  async press(key) {
    const d = await this._page._client.chain([{ m: 'keyboard' }, { m: 'press', a: [String(key)] }]);
    this._page._touch(d);
  }
  async type(text) {
    const d = await this._page._client.chain([{ m: 'keyboard' }, { m: 'type', a: [String(text)] }]);
    this._page._touch(d);
  }
  /** 一次性插入整段文本（一个 input 事件，富文本编辑器最认这个） */
  async insertText(text) {
    const d = await this._page._client.chain([{ m: 'keyboard' }, { m: 'insert_text', a: [String(text)] }]);
    this._page._touch(d);
  }
}

class Mouse {
  constructor(page) { this._page = page; }
  async click(x, y) {
    const d = await this._page._client.chain([{ m: 'mouse' }, { m: 'click', a: [x, y] }]);
    this._page._touch(d);
  }
  async move(x, y) {
    const d = await this._page._client.chain([{ m: 'mouse' }, { m: 'move', a: [x, y] }]);
    this._page._touch(d);
  }
}

class FoxPage {
  constructor(name, base) {
    this._client = new FoxClient(name, base);
    this._name = name;
    this._url = '';
    this._title = '';
    this._viewport = { width: 1280, height: 720 };
    this.keyboard = new Keyboard(this);
    this.mouse = new Mouse(this);
  }

  /** 每次调用后顺手刷新 url/title（发布器多处靠 page.url() 判断状态） */
  _touch(data) {
    if (!data) return;
    if (data.url) this._url = data.url;
    if (data.title) this._title = data.title;
  }

  async init() {
    const d = await this._client.chain([{ m: 'url' }]);
    if (typeof d?.result === 'string') this._url = d.result;
    try {
      const vp = await this._client.chain([{ m: 'viewport_size' }]);
      if (vp?.result?.width) this._viewport = vp.result;
    } catch (_) { /* 取不到就用默认值，只影响 debug trace */ }
  }

  // --- 导航与页面信息 ---
  async goto(url, opts = {}) {
    const body = { url: String(url), wait_until: opts.waitUntil || 'load' };
    const d = await this._client.post('/page/navigate', body);
    this._touch(d);
    return d;
  }
  url() { return this._url; }
  async title() {
    const d = await this._client.chain([{ m: 'title' }]);
    if (typeof d?.result === 'string') this._title = d.result;
    return this._title;
  }
  viewportSize() { return this._viewport; }
  async close() { /* 环境由调用方统一关闭 */ }
  async reload(opts = {}) {
    const d = await this._client.chain([{ m: 'reload', k: toKw(opts) }]);
    this._touch(d);
  }
  async content() {
    const d = await this._client.chain([{ m: 'content' }]);
    return d?.result || '';
  }

  /** 截图：给了 path 就写文件，否则返回 Buffer（与 Playwright 行为一致） */
  async screenshot(opts = {}) {
    const data = await this._client.get('/page/screenshot', {
      format: 'json',
      full_page: opts.fullPage === true,
    });
    const buf = Buffer.from(data.png_base64 || '', 'base64');
    if (opts.path) {
      const fsp = await import('fs');
      fsp.writeFileSync(opts.path, buf);
      return null;
    }
    return buf;
  }

  // --- 定位 ---
  locator(sel) { return new Locator(this, [{ m: 'locator', a: [String(sel)] }]); }
  getByText(text, opts = {}) {
    const q = opts.exact ? `text=${JSON.stringify(String(text))}` : `text=${text}`;
    return this.locator(q);
  }
  getByRole(role, opts = {}) {
    const name = opts.name ? `[name=${JSON.stringify(String(opts.name))}]` : '';
    const exact = opts.exact ? '[exact]' : '';
    return this.locator(`role=${role}${name}${exact}`);
  }
  getByTestId(id) { return this.locator(`[data-testid="${id}"]`); }

  // --- 执行 ---
  async evaluate(fn, arg) {
    // 参数必须拼进脚本里（FoxProfile 的 /page/evaluate 只接受一个 script 字段），
    // 之前把 arg 当第二个位置参数传，结果是脚本拿到 undefined、读回值永远为空。
    const d = await this._client.chain([{ m: 'evaluate', a: [toScript(fn, arg)] }]);
    return d?.result;
  }

  waitForTimeout(ms) {
    // 等待期间页面状态会变，睡完顺手刷一次 url
    return sleep(ms).then(async () => {
      try {
        const d = await this._client.chain([{ m: 'url' }]);
        if (typeof d?.result === 'string') this._url = d.result;
      } catch (_) { /* 忽略 */ }
    });
  }

  // --- 对话框：由服务端按策略自动应答（客户端回调拿不到） ---
  on(event) {
    if (event === 'dialog') {
      // 兼容旧写法；真正的策略用 setDialogPolicy 控制
      this.setDialogPolicy('pre').catch(() => {});
    }
  }
  async setDialogPolicy(policy) {
    return this._client.post('/page/dialogs', { policy: String(policy || 'pre') });
  }

  // --- 文件上传 ---
  async uploadFile(selector, filePath) {
    return this._client.post('/page/upload', { input_selector: selector, file_path: filePath });
  }
  async uploadViaButton(selector, filePath) {
    return this._client.post('/page/upload', { click_selector: selector, file_path: filePath });
  }
}

/**
 * 打开一个 FoxProfile 环境，返回 Playwright 形状的 page
 * @param {string} envName 环境名（如 TK01）
 * @param {string} [base]  FoxProfile 接口地址
 */
export async function openFoxPage(envName, base) {
  const name = String(envName || '').trim();
  if (!name) throw new Error('未配置浏览器环境名');

  const profiles = await listFoxProfiles(base);
  if (!profiles.some((p) => p.name === name)) {
    const names = profiles.slice(0, 10).map((p) => p.name).join(', ');
    throw new Error(`FoxProfile 里没有名为「${name}」的环境（现有: ${names || '无'}）`);
  }

  // 同 IP 只跑一个环境：发布前先收掉其它还开着的环境，避免被平台关联
  const others = await foxStopOthers(name, base);
  if (others.length) {
    console.log(`  🧹 已关闭其它还在运行的环境: ${others.join(', ')}（同 IP 只跑一个）`);
  }

  const launched = await foxLaunch(name, base);
  if (launched && launched.success === false) {
    throw new Error(launched.message || `环境 ${name} 启动失败`);
  }

  const page = new FoxPage(name, base);
  await page.init();
  return { page, name, context: null, browser: null };
}

/** 关闭环境 */
export async function closeFoxPage(envName, base) {
  const name = String(envName || '').trim();
  if (!name) return;
  try {
    await foxStop(name, base);
  } catch (_) { /* 关闭失败不致命 */ }
}

/**
 * 接管一个「已经开着」的环境（不启动、不关闭别人）。
 * 用于需要在用户已经打开的窗口里继续操作的场景。
 */
export async function attachFoxPage(envName, base) {
  const name = String(envName || '').trim();
  if (!name) throw new Error('未指定浏览器环境名');
  const page = new FoxPage(name, base);
  await page.init();
  return { page, name, context: null, browser: null };
}
