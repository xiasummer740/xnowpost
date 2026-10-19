/**
 * 助手在**弹确认框之前**就把非法配置改动拦下来 —— 单测。
 *
 * 这条红线很重要：如果预览卡片里出现「把 deepseekApiKey 改成 sk-xxx」，
 * 用户很可能顺手点「执行」。所以"能不能改"必须在校验阶段就判死，
 * 而不是等执行器再拦（那时用户已经点过确认了）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAssistantSession } from '../../electron/assistant.js';

function sessionWith(calls, execLog = []) {
  const scripts = [
    { role: 'assistant', content: '', tool_calls: calls },
    { role: 'assistant', content: '收到' },
  ];
  return createAssistantSession({
    callModel: async () => ({ message: scripts.shift() }),
    exec: async (name, args) => {
      execLog.push({ name, args });
      return { ok: true, summary: 'done' };
    },
    systemPrompt: 'sys',
    previewCtx: () => ({ config: { deepseekModel: 'deepseek-flash' } }),
  });
}

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('改 API Key 的请求在校验阶段就被拒，不会弹出确认卡片', async () => {
  const execLog = [];
  const s = sessionWith([call('a', 'update_config', { patch: { deepseekApiKey: 'sk-evil' } })], execLog);
  const r = await s.send('把 key 换成 sk-evil');
  assert.equal(r.pending.length, 0, '危险改动不该出现在确认列表里');
  assert.equal(execLog.length, 0);
  // 模型看到的是一条错误结果
  const toolMsg = s._messages().filter((m) => m.role === 'tool').pop();
  assert.match(toolMsg.content, /不允许改|error/);
});

test('改数据目录同样被拒', async () => {
  const execLog = [];
  const s = sessionWith([call('b', 'update_config', { patch: { dataDir: 'D:\\elsewhere' } })], execLog);
  const r = await s.send('换个数据目录');
  assert.equal(r.pending.length, 0);
  assert.equal(execLog.length, 0);
});

test('合法改动正常弹确认卡片，且预览里只有白名单字段', async () => {
  const execLog = [];
  const s = sessionWith([call('c', 'update_config', { patch: { deepseekModel: 'deepseek-v4-pro' } })], execLog);
  const r = await s.send('换模型');
  assert.equal(r.pending.length, 1);
  assert.match(r.pending[0].preview, /deepseek-flash/);
  assert.match(r.pending[0].preview, /deepseek-v4-pro/);
  const r2 = await s.answer([{ id: r.pending[0].id, approve: true }]);
  assert.equal(r2.ok, true);
  assert.deepEqual(execLog[0], { name: 'update_config', args: { patch: { deepseekModel: 'deepseek-v4-pro' } } });
});

test('多个动作里混进一个非法改动 → 非法的当错误、合法的照样等确认', async () => {
  const execLog = [];
  const s = sessionWith([
    call('d1', 'update_config', { patch: { deepseekApiKey: 'sk-x' } }),
    call('d2', 'update_config', { patch: { heroI2V: true } }),
  ], execLog);
  const r = await s.send('顺手改两个');
  assert.equal(r.pending.length, 1, '只有合法那条进确认列表');
  assert.match(r.pending[0].preview, /开场镜/);
});
