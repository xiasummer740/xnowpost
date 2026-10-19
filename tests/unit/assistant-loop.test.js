/**
 * AI 助手执行循环 —— 单测（不需要网络、不需要 Electron）。
 *
 * 用"剧本式"假模型（按顺序返回预设的 tool_calls）+ 假执行器，
 * 把最容易出事的行为钉住：
 *   ① 只读工具自动跑；② 写/花钱工具**必须**停下来等确认；
 *   ③ 用户拒绝 = 不执行（工具结果里明确写 skipped）；
 *   ④ 参数错的调用不会执行、但会按顺序回一条错误结果；
 *   ⑤ 同一轮多个工具的 tool 结果顺序必须与 tool_calls 一致（否则服务端 400）；
 *   ⑥ 模型绕圈有上限；⑦ 审计账本只记执行过的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAssistantSession, MAX_STEPS } from '../../electron/assistant.js';

/** 剧本式假模型：每次调用返回 scripts[i] */
function makeModel(scripts) {
  const seen = [];
  const callModel = async (messages) => {
    seen.push(JSON.parse(JSON.stringify(messages)));
    const next = scripts.shift();
    if (!next) throw new Error('剧本用完了');
    if (next instanceof Error) throw next;
    return { message: next, usage: { total_tokens: 10 } };
  };
  callModel.seen = seen;
  return callModel;
}

const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const assistantWithCalls = (calls, content = '') => ({ role: 'assistant', content, tool_calls: calls });
const assistantText = (text) => ({ role: 'assistant', content: text });

function makeSession(scripts, execImpl, extra = {}) {
  const executed = [];
  const ledger = [];
  const callModel = makeModel(scripts);
  const session = createAssistantSession({
    callModel,
    exec: async (name, args) => {
      executed.push({ name, args });
      return execImpl ? execImpl(name, args) : { ok: true, summary: `${name} 结果` };
    },
    systemPrompt: 'sys',
    onLedger: (line) => ledger.push(line),
    ...extra,
  });
  return { session, callModel, executed, ledger };
}

test('只读工具自动执行，然后把结果喂回模型，最后给出答复', async () => {
  const { session, callModel, executed, ledger } = makeSession([
    assistantWithCalls([toolCall('a1', 'get_status', {})]),
    assistantText('今天 10 条已发，1 条失败。'),
  ], (name) => (name === 'get_status' ? { ok: true, published: 10, failed: 1 } : {}));

  const r = await session.send('今天怎么样？');
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.reply, /^$/);
  assert.equal(r.pending.length, 0);
  assert.deepEqual(executed.map((e) => e.name), ['get_status']);

  // 模型收到的第二轮里，assistant(tool_calls) 后面紧跟 tool 结果
  const second = callModel.seen[1];
  const idx = second.findIndex((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(second[idx + 1].role, 'tool');
  assert.equal(second[idx + 1].tool_call_id, 'a1');
  assert.match(second[idx + 1].content, /published/);

  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].tool, 'get_status');
  assert.equal(ledger[0].level, 'read');
});

test('写操作必须停下来等确认，且确认前一次都不许执行', async () => {
  const { session, executed, ledger } = makeSession([
    assistantWithCalls([toolCall('w1', 'run_engine', { mode: 'video' })], '我准备跑一轮视频生成。'),
    assistantText('已经开跑了。'),
  ]);

  const r = await session.send('生成一条');
  assert.equal(r.needsConfirm, true);
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].name, 'run_engine');
  assert.match(r.pending[0].preview, /会花钱/);
  assert.equal(executed.length, 0, '确认前不许执行');
  assert.equal(ledger.length, 0);

  // 用户同意 → 执行，并继续把结果喂回去
  const r2 = await session.answer([{ id: r.pending[0].id, approve: true }]);
  assert.equal(r2.ok, true);
  assert.deepEqual(executed.map((e) => e.name), ['run_engine']);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].confirmed, true);
  assert.equal(r2.pending.length, 0);
});

test('用户拒绝 → 一次都不执行，但模型知道被拒了', async () => {
  const { session, callModel, executed } = makeSession([
    assistantWithCalls([toolCall('w2', 'update_config', { patch: { deepseekModel: 'deepseek-v4-pro' } })]),
    assistantText('好的，那就不改。'),
  ]);

  const r = await session.send('把模型换成 v4-pro');
  assert.equal(r.pending.length, 1);
  const r2 = await session.answer([{ id: r.pending[0].id, approve: false }]);

  assert.equal(executed.length, 0);
  assert.match(r2.reply, /不改/);
  // 第三轮请求里那条 tool 结果要明确写 skipped
  const last = callModel.seen[callModel.seen.length - 1];
  const toolMsg = last.filter((m) => m.role === 'tool').pop();
  assert.match(toolMsg.content, /skipped/);
});

test('没表态的动作按拒绝处理（宁可少做）', async () => {
  const { session, executed } = makeSession([
    assistantWithCalls([toolCall('w3', 'schedule_action', { op: 'delete', id: 'j1' })]),
    assistantText('ok'),
  ]);
  const r = await session.send('删掉那个闹钟');
  await session.answer([]);   // 什么都没点
  assert.equal(executed.length, 0);
  assert.equal(r.pending.length, 1);
});

test('同一轮多个工具：tool 结果顺序必须与 tool_calls 一致', async () => {
  const { session, callModel } = makeSession([
    assistantWithCalls([
      toolCall('x1', 'get_status', {}),
      toolCall('x2', 'get_today_publish', {}),
      toolCall('x3', 'get_schedule', {}),
    ]),
    assistantText('都查到了。'),
  ]);

  await session.send('全都看一下');
  const second = callModel.seen[1];
  const start = second.findIndex((m) => m.role === 'assistant' && m.tool_calls);
  const ids = second.slice(start + 1).filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.deepEqual(ids, ['x1', 'x2', 'x3']);
});

test('参数错的调用不执行，但会回一条错误结果让模型自我纠正', async () => {
  const { session, callModel, executed } = makeSession([
    assistantWithCalls([toolCall('e1', 'run_engine', { mode: 'music' })]),   // mode 不在枚举里
    assistantText('我改正一下。'),
  ]);

  const r = await session.send('跑个音乐模式');
  assert.equal(executed.length, 0);
  assert.equal(r.ok, true);
  const second = callModel.seen[1];
  const toolMsg = second.filter((m) => m.role === 'tool').pop();
  assert.match(toolMsg.content, /error/);
  assert.match(toolMsg.content, /mode/);
  // 视图里能看到这条失败，界面上不会假装成功
  const failed = r.view.filter((v) => v.role === 'tool' && v.ok === false);
  assert.equal(failed.length, 1);
});

test('未知工具名一律拒绝执行', async () => {
  const { session, executed } = makeSession([
    assistantWithCalls([toolCall('u1', 'exec_shell', { cmd: 'rm -rf /' })]),
    assistantText('这个我不能做。'),
  ]);
  await session.send('帮我删点东西');
  assert.equal(executed.length, 0);
});

test('模型自己绕圈有上限，不会无限烧钱', async () => {
  // 每一步都要求再查一次
  const scripts = [];
  for (let i = 0; i < MAX_STEPS + 3; i++) {
    scripts.push(assistantWithCalls([toolCall(`l${i}`, 'get_status', {})]));
  }
  const { session, executed } = makeSession(scripts);
  const r = await session.send('一直查');
  assert.equal(r.ok, false);
  assert.match(r.error, /收敛|停手/);
  assert.equal(executed.length, MAX_STEPS);
});

test('模型请求失败不会让界面崩，只回错误文案', async () => {
  const { session } = makeSession([new Error('Premature close')]);
  const r = await session.send('今天怎么样');
  assert.equal(r.ok, false);
  assert.match(r.error, /模型请求失败/);
  assert.match(r.error, /Premature close/);
});

test('执行器抛异常 = 该工具失败，不会把整轮带崩', async () => {
  const { session } = makeSession([
    assistantWithCalls([toolCall('t1', 'get_cost', {})]),
    assistantText('花费查不到。'),
  ], () => { throw new Error('账本文件被占用'); });

  const r = await session.send('花了多少');
  assert.equal(r.ok, true);
  const toolView = r.view.find((v) => v.role === 'tool');
  assert.equal(toolView.ok, false);
  const toolMsg = session._messages().filter((m) => m.role === 'tool').pop();
  assert.match(toolMsg.content, /账本文件被占用/);
});

test('有待确认动作时不许再发新消息（避免两个动作交叉执行）', async () => {
  const { session } = makeSession([
    assistantWithCalls([toolCall('w9', 'run_engine', { mode: 'text' })]),
    assistantText('ok'),
  ]);
  await session.send('生成文案');
  const r = await session.send('顺便再发一条');
  assert.equal(r.ok, false);
  assert.match(r.error, /等确认/);
});

test('reset 清空对话与 pending', async () => {
  const { session } = makeSession([
    assistantWithCalls([toolCall('r1', 'run_engine', { mode: 'video' })]),
  ]);
  await session.send('跑一条');
  assert.equal(session.pending, 1);
  session.reset();
  assert.equal(session.pending, 0);
  assert.equal(session.snapshot().view.length, 0);
  assert.equal(session._messages().length, 1);   // 只剩 system
});

test('密钥不会通过工具结果漏进对话上下文', async () => {
  const { session, callModel } = makeSession([
    assistantWithCalls([toolCall('s1', 'get_accounts', {})]),
    assistantText('查完了。'),
  ], () => ({ ok: true, accounts: [{ name: '01', password: 'p@ssw0rd', totpSecret: 'JBSWY3DP' }] }));

  await session.send('看下账号');
  const second = callModel.seen[1];
  const text = JSON.stringify(second);
  assert.ok(!text.includes('p@ssw0rd'), '密码泄漏进了模型上下文');
  assert.ok(!text.includes('JBSWY3DP'), '2FA 密钥泄漏进了模型上下文');
  assert.ok(text.includes('account') || text.includes('01'));
});

test('预览用得到旧值（改配置时能显示 从什么 → 什么）', async () => {
  const { session } = makeSession([
    assistantWithCalls([toolCall('p1', 'update_config', { patch: { deepseekModel: 'deepseek-v4-pro' } })]),
    assistantText('等你确认'),
  ], null, { previewCtx: () => ({ config: { deepseekModel: 'deepseek-flash' } }) });

  const r = await session.send('换模型');
  assert.match(r.pending[0].preview, /deepseek-flash/);
  assert.match(r.pending[0].preview, /deepseek-v4-pro/);
});

test('notify：助手主动回报会进对话（用户不用守着问 OK 了吗）', async () => {
  const { session } = makeSession([assistantText('已启动，跑完我会自动回报')]);
  const r1 = await session.send('TK04 生成一条');
  assert.equal(r1.view.filter((v) => v.role === 'assistant').length, 1);

  // 程序替助手说话（不是模型生成）
  const snap = session.notify('✅ 好了（4 分钟）：pm_2214 已发布（TK04）');
  assert.ok(snap, '必须返回新快照，界面才能立刻刷新');
  const auto = snap.view.filter((v) => v.role === 'assistant' && v.auto);
  assert.equal(auto.length, 1, '自动回报要带 auto 标记，界面上能和模型回答区分');
  assert.match(auto[0].text, /已发布/);

  // 也要进 messages：用户接着问「那这条数据怎么样」时模型得知道刚发生过什么
  const msgs = session._messages();
  assert.ok(msgs.some((m) => m.role === 'assistant' && /pm_2214/.test(m.content || '')), '自动回报必须写进模型上下文');

  // 空文本不许塞进对话（否则界面上出现空气泡）
  assert.equal(session.notify('   '), null);
  assert.equal(session.notify(''), null);
});
