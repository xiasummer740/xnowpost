/**
 * BrowserTracer — 浏览器操作追踪器（纯文本版）
 *
 * 在 Playwright 自动化每一步操作前/后捕获页面状态，
 * 输出 JSON trace 到 sessionPath，用于复盘哪一步出问题。
 *
 * 不截图，全部输出文字/代码，兼容 DeepSeek 等不支持图片的大模型。
 *
 * 用法:
 *   const trace = new BrowserTracer(page, sessionPath);
 *   await trace.step('打开 AI 开关', async () => {
 *     await page.locator('...').click();
 *   });
 *   await trace.save(); // 写出 trace JSON
 */
import path from 'path';
import fs from 'fs';

export class BrowserTracer {
  constructor(page, sessionPath) {
    this.page = page;
    this.sessionPath = sessionPath;
    /** @type {TraceStep[]} */
    this.steps = [];
    this._stepIndex = 0;
  }

  /**
   * 执行一个操作步骤，自动捕获前后状态
   * @param {string} name      步骤名称
   * @param {() => Promise<any>} fn 操作函数
   * @param {object} [opts]
   * @param {string} [opts.domQuery] 操作前捕获指定区域的 DOM 片段 (CSS selector)
   * @param {string[]} [opts.checkSelectors] 操作后检查这些选择器是否存在/可见
   * @param {number} [opts.waitAfterMs] 操作后等待毫秒
   */
  async step(name, fn, opts = {}) {
    const idx = ++this._stepIndex;
    const step = { idx, name, startedAt: Date.now(), events: [] };
    this.steps.push(step);

    // --- 操作前 ---
    step.before = await this._captureState(opts.domQuery);

    // --- 执行操作，拦截 console.log 记录事件 ---
    const eventLog = [];
    const origLog = console.log;
    console.log = (...args) => {
      eventLog.push(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
      origLog.apply(console, args);
    };

    try {
      step.result = await fn();
      step.success = true;
    } catch (err) {
      step.success = false;
      step.error = err.message;
      eventLog.push(`[ERROR] ${err.message}`);
    } finally {
      console.log = origLog;
    }
    step.events = eventLog;

    // 操作后等待
    if (opts.waitAfterMs) {
      await this.page.waitForTimeout(opts.waitAfterMs);
    }

    // --- 操作后 ---
    step.after = await this._captureState(opts.domQuery);

    // 检查指定选择器
    if (opts.checkSelectors) {
      step.checks = {};
      for (const sel of opts.checkSelectors) {
        try {
          const el = this.page.locator(sel).first();
          step.checks[sel] = {
            visible: await el.isVisible({ timeout: 500 }).catch(() => false),
            count: await el.count().catch(() => 0),
          };
        } catch (_) {
          step.checks[sel] = { error: true };
        }
      }
    }

    step.duration = Date.now() - step.startedAt;
  }

  /**
   * 保存完整 trace 到文件
   */
  async save() {
    const tracePath = path.join(this.sessionPath, 'browser-trace.json');
    const summary = this.steps.map(s => ({
      idx: s.idx,
      name: s.name,
      success: s.success,
      duration: s.duration,
      error: s.error || null,
    }));

    const output = { summary, steps: this.steps };
    fs.writeFileSync(tracePath, JSON.stringify(output, null, 2));
    console.log(`  📊 trace 已保存: ${tracePath}`);
    return tracePath;
  }

  // ========== 内部 ==========

  async _captureState(domQuery) {
    try {
      const state = { url: this.page.url(), title: await this.page.title() };
      const vp = this.page.viewportSize();
      if (vp) state.viewport = vp;

      // DOM 片段
      if (domQuery) {
        state.domSnippet = await this.page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el ? el.outerHTML.slice(0, 3000) : `[NOT FOUND: ${sel}]`;
        }, domQuery).catch(() => '[ERROR] evaluate failed');
      }

      // 全部 switch 的状态
      state.switches = await this.page.evaluate(() => {
        const allSwitches = document.querySelectorAll(
          '[data-e2e="aigc_container"], [data-e2e="disclose_content_container"], ' +
          '[role="switch"], .Switch__root'
        );
        return Array.from(allSwitches).map(el => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            e2e: el.getAttribute('data-e2e') || '',
            class: (el.className || '').slice(0, 60),
            visible: rect.width > 0 && rect.height > 0,
            disabled: el.getAttribute('data-disabled') || el.disabled || false,
            checked: el.getAttribute('aria-checked') || '',
            text: (el.textContent || '').trim().slice(0, 40),
          };
        });
      }).catch(() => '[ERROR]');

      // Post 按钮状态
      state.postButton = await this.page.evaluate(() => {
        const btn = document.querySelector('[data-e2e="post_video_button"], button:has-text("Post")');
        if (!btn) return { found: false };
        return {
          found: true,
          disabled: btn.disabled || btn.getAttribute('aria-disabled') === 'true' || btn.getAttribute('data-disabled') === 'true' || false,
          visible: !!btn.offsetParent,
          text: (btn.textContent || '').trim().slice(0, 30),
        };
      }).catch(() => '[ERROR]');

      // 当前可见的 dialog 数
      state.dialogs = await this.page.evaluate(() => {
        return Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"]')).filter(el => el.offsetWidth > 0).length;
      }).catch(() => -1);

      return state;
    } catch (_) {
      return { error: 'capture failed' };
    }
  }
}
