/**
 * AI 助手的**执行循环**（agent loop）。
 *
 * 职责边界：
 *   - 这里只做「问模型 → 拿到 tool_calls → 校验参数 → 执行 → 把结果喂回去 → 再问」；
 *   - 具体"怎么执行"由外部注入的 `exec` 决定（main.js 里接真实数据/动作）；
 *   - 具体"怎么问模型"由外部注入的 `callModel` 决定（main.js 里用 axios，原因见 CLAUDE.md：
 *     Electron 主进程里 OpenAI SDK 的 fetch 必挂）。
 *
 * 因此本文件**不 import electron**，可以用假的 exec / callModel 完整单测。
 *
 * 写操作（改配置/改闹钟/花钱/发布）走「人确认」流程：
 *   send() 遇到写操作就停在 `pending`，把"要做什么"交给界面；
 *   answer([{id, approve}]) 才真正执行，然后继续同一轮对话。
 */
import {
  publicTools,
  levelOf,
  needsConfirm,
  validateArgs,
  validateConfigPatch,
  describeToolCall,
  stringifyToolResult,
  trimHistory,
  ledgerLine,
  redactDeep,
  MAX_HISTORY_MESSAGES,
} from './lib/assistant-tools.js';

/** 一轮对话里最多问几次模型（防止模型自己绕圈把费用刷上去） */
export const MAX_STEPS = 6;

/**
 * @param {object} opts
 * @param {(name:string, args:object)=>Promise<any>} opts.exec 真正执行工具
 * @param {(messages:object[])=>Promise<{message:object, usage?:object}>} opts.callModel
 * @param {string} opts.systemPrompt
 * @param {(line:object)=>void} [opts.onLedger]
 * @param {(msg:string)=>void} [opts.log]
 */
export function createAssistantSession({ exec, callModel, systemPrompt, onLedger, log, previewCtx }) {
  const say = typeof log === 'function' ? log : () => {};
  const ledger = typeof onLedger === 'function' ? onLedger : () => {};

  let messages = [{ role: 'system', content: String(systemPrompt || '') }];
  /** 给界面看的对话记录（只含用户/助手/工具条，不含原始 JSON） */
  let view = [];
  /** 等待用户确认的动作 */
  let waiting = null;
  let busy = false;
  let lastUsage = null;
  let seq = 0;

  const nextId = () => `c${++seq}`;

  function reset() {
    messages = [{ role: 'system', content: String(systemPrompt || '') }];
    view = [];
    waiting = null;
    busy = false;
    lastUsage = null;
  }

  /** 界面可见状态 */
  function snapshot(extra = {}) {
    const ctx = typeof previewCtx === 'function' ? previewCtx() || {} : {};
    return {
      view: view.slice(),
      pending: waiting
        ? waiting.calls
            .filter((c) => !c.error && needsConfirm(c.name))
            .map((c) => ({
              id: c.id,
              name: c.name,
              level: levelOf(c.name),
              preview: describeToolCall(c.name, c.args, ctx),
            }))
        : [],
      usage: lastUsage,
      ...extra,
    };
  }

  /** 执行一个工具调用，把结果写回 messages（顺序必须与 tool_calls 一致） */
  async function runCall(call) {
    const started = Date.now();
    let ok = true;
    let result;
    if (call.error) {
      ok = false;
      result = { error: call.error };
    } else {
      try {
        result = await exec(call.name, call.args);
        if (result && result.ok === false) ok = false;
      } catch (e) {
        ok = false;
        result = { error: String((e && e.message) || e) };
      }
    }
    const ms = Date.now() - started;
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: stringifyToolResult(redactDeep(result)),
    });
    const preview = call.error
      ? `${call.name}（参数错误）`
      : describeToolCall(call.name, call.args, typeof previewCtx === 'function' ? previewCtx() || {} : {});
    view.push({
      role: 'tool',
      name: call.name,
      preview,
      ok,
      ms,
      ...(call.error ? { error: call.error } : {}),
    });
    try {
      ledger(ledgerLine({
        tool: call.name,
        args: call.args,
        level: levelOf(call.name) || '',
        ok,
        ms,
        brief: call.error || (result && (result.summary || result.error)) || '',
        confirmed: !!call.confirmed,
      }));
    } catch (e) {
      say(`写审计账本失败：${e.message}`);
    }
    say(`🛠 ${call.name} ${ok ? '✅' : '❌'} ${ms}ms`);
    return ok;
  }

  /** 主循环 */
  async function loop() {
    for (let step = 0; step < MAX_STEPS; step++) {
      let resp;
      try {
        resp = await callModel(trimHistory(messages, MAX_HISTORY_MESSAGES));
      } catch (e) {
        return snapshot({ ok: false, error: `模型请求失败：${String((e && e.message) || e)}`, reply: '' });
      }
      lastUsage = (resp && resp.usage) || lastUsage;
      const msg = (resp && resp.message) || {};
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

      if (msg.content && String(msg.content).trim()) {
        view.push({ role: 'assistant', text: String(msg.content).trim(), step });
      }

      if (!calls.length) {
        messages.push({ role: 'assistant', content: String(msg.content || '') });
        return snapshot({ ok: true, reply: String(msg.content || ''), done: true });
      }

      // 归一化每个调用（先校验参数，坏参数也要按顺序回一条 tool 结果）
      const normalized = calls.map((c) => {
        const name = c.function?.name || '';
        const v = validateArgs(name, c.function?.arguments);
        const item = {
          id: c.id || nextId(),
          name,
          args: v.args || {},
          error: v.ok ? null : v.error,
          level: levelOf(name),
        };
        // 配置改动在**弹确认框之前**就按白名单筛一遍：
        // 这样预览里不可能出现 "把 deepseekApiKey 改成 xxx" 这种卡片，模型也没法诱导用户点。
        if (!item.error && name === 'update_config') {
          const cv = validateConfigPatch(item.args.patch);
          if (!cv.ok) item.error = cv.error;
          else item.args.patch = cv.patch;
        }
        return item;
      });

      // 有写/花钱动作 → 停下来等用户确认（只读的也先不跑，保证 tool 结果顺序不乱）
      const confirmable = normalized.filter((c) => !c.error && needsConfirm(c.name));
      if (confirmable.length) {
        messages.push({
          role: 'assistant',
          content: String(msg.content || ''),
          tool_calls: normalized.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        });
        waiting = { calls: normalized };
        say(`⏸ 等待确认：${confirmable.map((c) => c.name).join('、')}`);
        return snapshot({ ok: true, reply: String(msg.content || ''), needsConfirm: true });
      }

      // 全只读（或参数错）→ 直接跑完继续
      messages.push({
        role: 'assistant',
        content: String(msg.content || ''),
        tool_calls: normalized.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });
      for (const c of normalized) await runCall(c);
    }
    return snapshot({
      ok: false,
      error: `一轮里问了 ${MAX_STEPS} 次模型还没收敛（可能是工具一直报错），已停手。`,
      reply: '',
    });
  }

  /** 用户发一句话 */
  async function send(text) {
    const content = String(text || '').trim();
    if (!content) return snapshot({ ok: false, error: '空消息' });
    if (busy) return snapshot({ ok: false, error: '上一条还在处理' });
    if (waiting) return snapshot({ ok: false, error: '有动作在等确认，请先点「执行」或「跳过」' });
    busy = true;
    try {
      messages.push({ role: 'user', content });
      view.push({ role: 'user', text: content });
      return await loop();
    } finally {
      busy = false;
    }
  }

  /**
   * 用户对 pending 动作表态。
   * @param {Array<{id:string, approve:boolean}>} approvals 没表态的按"拒绝"处理（宁可少做）
   */
  async function answer(approvals) {
    if (!waiting) return snapshot({ ok: false, error: '没有待确认的动作' });
    if (busy) return snapshot({ ok: false, error: '上一条还在处理' });
    const map = new Map((Array.isArray(approvals) ? approvals : []).map((a) => [String(a.id), !!a.approve]));
    const calls = waiting.calls;
    waiting = null;
    busy = true;
    try {
      for (const c of calls) {
        if (c.error) {
          await runCall(c);
          continue;
        }
        if (needsConfirm(c.name)) {
          const approve = map.get(String(c.id)) === true;
          if (!approve) {
            messages.push({
              role: 'tool',
              tool_call_id: c.id,
              content: JSON.stringify({ skipped: true, reason: '用户拒绝执行这个动作' }),
            });
            view.push({ role: 'tool', name: c.name, preview: `用户跳过：${describeToolCall(c.name, c.args, typeof previewCtx === 'function' ? previewCtx() || {} : {})}`, ok: true, ms: 0, skipped: true });
            say(`⏭ 用户跳过了 ${c.name}`);
            continue;
          }
          c.confirmed = true;
        }
        await runCall(c);
      }
      return await loop();
    } finally {
      busy = false;
    }
  }

  return {
    send,
    answer,
    reset,
    snapshot: () => snapshot({ ok: true }),
    /** 单测用：拿到完整 messages（含 tool 结果），验证顺序与裁剪 */
    _messages: () => messages.slice(),
    _view: () => view.slice(),
    get pending() {
      return waiting ? waiting.calls.length : 0;
    },
  };
}
