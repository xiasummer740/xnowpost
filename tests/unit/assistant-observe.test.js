/**
 * 「执行结果看不出来」的修复单测（2026-10-19 用户截图反馈）。
 *
 * 用户原话：「AI 助手的执行结果也不明显，也没有告诉我是否发布成功」。
 * 三件事分别钉住：
 *   ① 每个工具行都要带一句人话结论（`detail`）—— 而不是只有工具名和毫秒；
 *   ② `get_last_task` 必须是**只读**、无必填参数，且确认卡/预览不出现写操作措辞；
 *   ③ 推理模型返回的 `reasoning_content` 要单独渲染成「思考」块，不能被丢掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getToolDef,
  levelOf,
  needsConfirm,
  validateArgs,
  describeToolCall,
  summarizeToolResult,
  LEVEL,
} from '../../electron/lib/assistant-tools.js';
import { createAssistantSession } from '../../electron/assistant.js';

const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('get_last_task 是只读工具，不需要确认', () => {
  const def = getToolDef('get_last_task');
  assert.ok(def, 'get_last_task 必须存在');
  assert.equal(levelOf('get_last_task'), LEVEL.READ);
  assert.equal(needsConfirm('get_last_task'), false);
  assert.deepEqual(def.parameters.required || [], [], '不该有必填参数');
  assert.equal(validateArgs('get_last_task', {}).ok, true);
  assert.equal(validateArgs('get_last_task', { minutes: 15 }).ok, true);
  assert.equal(validateArgs('get_last_task', { bogus: 1 }).ok, false);
});

test('get_last_task 的预览说清"往回查多久"，且分钟数被夹在 5~240', () => {
  assert.match(describeToolCall('get_last_task', {}), /40 分钟/);
  assert.match(describeToolCall('get_last_task', { minutes: 10 }), /10 分钟/);
  assert.match(describeToolCall('get_last_task', { minutes: 9999 }), /240 分钟/);
  assert.match(describeToolCall('get_last_task', { minutes: 1 }), /5 分钟/);
});

test('工具结论摘要：优先用执行器给的 summary', () => {
  assert.equal(summarizeToolResult('get_today_publish', { ok: true, summary: '已发 10 / 失败 1' }), '已发 10 / 失败 1');
  // 长的压成一行，别把界面撑爆
  const long = summarizeToolResult('x', { ok: true, summary: `a${'很长的文字'.repeat(40)}` });
  assert.ok(long.length <= 120);
  assert.doesNotMatch(long, /\n/);
});

test('工具结论摘要：失败就说失败，并把原因带出来', () => {
  assert.equal(summarizeToolResult('run_publish', { ok: false, error: '没有可发的内容' }), '失败：没有可发的内容');
  assert.equal(summarizeToolResult('run_publish', { ok: false }), '失败');
});

test('工具结论摘要：没有 summary 时按已知结构兜底', () => {
  assert.equal(
    summarizeToolResult('get_schedule', { ok: true, jobs: [{ enabled: true }, { enabled: false }, {}] }),
    '共 3 个闹钟，启用 2 个',
  );
  assert.equal(summarizeToolResult('get_memory', { ok: true, items: [{}, {}] }), '记住 2 条');
  assert.equal(summarizeToolResult('get_status', { ok: true }), '', '不知道就返回空，不许编');
  assert.equal(summarizeToolResult('get_status', null), '');
});

test('工具行带 detail；verdict=success 的结论能透到界面', async () => {
  const scripts = [
    { role: 'assistant', content: '', tool_calls: [toolCall('a1', 'get_last_task', {})] },
    { role: 'assistant', content: '✅ 已发布：TK01 · 18:20' },
  ];
  const session = createAssistantSession({
    callModel: async () => ({ message: scripts.shift(), usage: {} }),
    exec: async () => ({ ok: true, verdict: 'success', verdictText: '✅ 已发布：TK01', summary: '✅ 已发布：TK01' }),
    systemPrompt: 'sys',
  });
  const r = await session.send('发成功了吗');
  const toolRow = r.view.find((v) => v.role === 'tool');
  assert.ok(toolRow, '应该有工具行');
  assert.equal(toolRow.name, 'get_last_task');
  assert.match(toolRow.detail, /已发布/);
  assert.equal(toolRow.verdict, 'success');
});

test('推理模型的思考过程单独成一条，不混进答复正文', async () => {
  const scripts = [
    { role: 'assistant', content: '', reasoning_content: '先看账本…再看 FAILED 标记…', tool_calls: [toolCall('a1', 'get_last_task', {})] },
    { role: 'assistant', content: '结论：还在跑。', reasoning_content: '工具说 running…' },
  ];
  const session = createAssistantSession({
    callModel: async () => ({ message: scripts.shift(), usage: {} }),
    exec: async () => ({ ok: true, verdict: 'running', summary: '⏳ 还在跑：生成（引擎）' }),
    systemPrompt: 'sys',
  });
  const r = await session.send('好了吗');
  const reasons = r.view.filter((v) => v.role === 'reasoning');
  assert.equal(reasons.length, 2, '两轮模型调用各有一段思考');
  assert.match(reasons[0].text, /先看账本/);
  // 正文里不该混进思考内容
  const said = r.view.filter((v) => v.role === 'assistant').map((v) => v.text).join('\n');
  assert.doesNotMatch(said, /先看账本/);
  assert.match(said, /还在跑/);
});

test('回答正文里不该出现"已启动"就当成"已发布"（系统提示词要钉住这条）', async () => {
  const { buildSystemPrompt } = await import('../../electron/lib/assistant-tools.js');
  const p = buildSystemPrompt({ today: '2026-10-19', appVersion: '1.6.17', model: 'deepseek-chat' });
  assert.match(p, /get_last_task/, '必须告诉模型有这个工具');
  assert.match(p, /不许把.{0,4}已启动.{0,4}说成.{0,4}已发布/);
  assert.match(p, /三态|✅ 已发布/);
});
