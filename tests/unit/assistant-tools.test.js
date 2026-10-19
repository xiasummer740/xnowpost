/**
 * AI 助手的安全边界 —— 单测。
 *
 * 这一层是唯一能拦住"模型乱来"的地方，所以每条红线都要有用例钉住：
 *   ① 没有任意命令/任意文件工具；② 写操作必须确认；③ 参数白名单；
 *   ④ 发布条数夹死；⑤ 配置只能改白名单键；⑥ 密钥永不外泄。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEVEL,
  TOOL_DEFS,
  PUBLIC_TOOLS_NAMES,
  CONFIG_WHITELIST,
  PUBLISH_MAX_PER_TURN,
  MAX_HISTORY_MESSAGES,
  publicTools,
  getToolDef,
  levelOf,
  needsConfirm,
  validateArgs,
  validateConfigPatch,
  describeToolCall,
  clampPublishCount,
  redactDeep,
  ledgerLine,
  trimHistory,
  stringifyToolResult,
  buildSystemPrompt,
} from '../../electron/lib/assistant-tools.js';

test('工具白名单里没有「执行命令 / 读写任意文件」这类能力', () => {
  const names = TOOL_DEFS.map((t) => t.name);
  assert.ok(names.length >= 12, `工具太少：${names.length}`);
  for (const bad of ['exec', 'shell', 'run_command', 'read_file', 'write_file', 'spawn', 'eval', 'http_get']) {
    assert.ok(!names.includes(bad), `不许出现 ${bad}`);
  }
  // 每个工具都必须有中文说明和合法的 JSON Schema 根
  for (const t of TOOL_DEFS) {
    assert.ok(t.description && t.description.length > 6, `${t.name} 缺说明`);
    assert.equal(t.parameters.type, 'object', `${t.name} 的参数根必须是 object`);
    assert.equal(t.parameters.additionalProperties, false, `${t.name} 必须禁止多余字段`);
  }
});

test('发给模型的工具与内置定义一致（不能偷偷多塞）', () => {
  const sent = publicTools().map((t) => t.function.name);
  assert.deepEqual(sent, PUBLIC_TOOLS_NAMES);
  assert.deepEqual(sent.sort(), TOOL_DEFS.map((t) => t.name).sort());
});

test('读操作不需要确认，写/花钱操作必须确认', () => {
  // note 级（助手自己的笔记本：remember/forget）只动它自己的文件，不需要确认；
  // 业务写操作（改配置/改定时）和花钱动作（跑生成/发布/采集）一律必须确认。
  for (const t of TOOL_DEFS) {
    const auto = t.level === LEVEL.READ || t.level === LEVEL.NOTE;
    assert.equal(needsConfirm(t.name), !auto, `${t.name}（${t.level}）确认判定不对`);
  }
  assert.equal(needsConfirm('remember'), false);
  assert.equal(needsConfirm('forget'), false);
  assert.equal(needsConfirm('update_config'), true);
  assert.equal(needsConfirm('schedule_action'), true);
  assert.equal(needsConfirm('run_engine'), true);
  assert.equal(needsConfirm('run_publish'), true);
  assert.equal(needsConfirm('get_status'), false);
});

test('未知工具一律不认（防止模型自造工具名）', () => {
  assert.equal(getToolDef('nope'), null);
  assert.equal(levelOf('nope'), null);
  assert.equal(needsConfirm('nope'), false);
  assert.equal(validateArgs('nope', {}).ok, false);
});

test('参数校验：多余字段 / 缺必填 / 类型不对 全部拒绝', () => {
  assert.equal(validateArgs('get_status', { evil: 1 }).ok, false);
  assert.equal(validateArgs('run_engine', {}).ok, false);               // 缺 mode
  assert.equal(validateArgs('run_engine', { mode: 'music' }).ok, false); // 枚举外
  assert.equal(validateArgs('get_logs', { limit: 'abc' }).ok, false);    // 非数字
  assert.equal(validateArgs('get_schedule', { onlyEnabled: 'yes' }).ok, false);

  const ok = validateArgs('run_engine', '{"mode":"video"}');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.args, { mode: 'video' });
  // account 已经不是合法参数：引擎不支持按次指定账号，静默忽略会变成"预览说账号 01、实际按配置跑"
  assert.equal(validateArgs('run_engine', '{"mode":"video","account":"01"}').ok, false);
  // 空参数也能过（全部可选）
  assert.equal(validateArgs('get_status', '').ok, true);
  assert.equal(validateArgs('get_status', undefined).ok, true);
});

test('坏 JSON 参数不会抛异常，只报错', () => {
  const r = validateArgs('run_engine', '{"mode":');
  assert.equal(r.ok, false);
  assert.match(r.error, /JSON/);
});

test('发布条数被夹死：模型传 99 也只发 3 条', () => {
  assert.equal(clampPublishCount(99), PUBLISH_MAX_PER_TURN);
  assert.equal(clampPublishCount(3), 3);
  assert.equal(clampPublishCount(0), 1);
  assert.equal(clampPublishCount(-5), 1);
  assert.equal(clampPublishCount('abc'), 1);
  assert.equal(clampPublishCount(undefined), 1);
});

test('配置只能改白名单键，改 Key / 数据目录一律拒绝', () => {
  assert.equal(validateConfigPatch({ deepseekApiKey: 'sk-x' }).ok, false);
  assert.equal(validateConfigPatch({ dataDir: 'D:\\x' }).ok, false);
  assert.equal(validateConfigPatch({ tgBotToken: 'x' }).ok, false);
  assert.equal(validateConfigPatch({}).ok, false);

  const ok = validateConfigPatch({ deepseekModel: 'deepseek-v4-pro', 'dailyLimit.videos': 3 });
  assert.equal(ok.ok, true);
  assert.equal(ok.patch.deepseekModel, 'deepseek-v4-pro');
  assert.equal(ok.patch.dailyLimit.videos, 3);   // 点号路径被还原成嵌套对象
});

test('配置值范围检查：输出上限不能设成 1 或 99999', () => {
  assert.equal(validateConfigPatch({ deepseekMaxTokens: 1 }).ok, false);
  assert.equal(validateConfigPatch({ deepseekMaxTokens: 99999 }).ok, false);
  assert.equal(validateConfigPatch({ deepseekMaxTokens: 8000 }).ok, true);
  assert.equal(validateConfigPatch({ heroI2V: 'yes' }).ok, false);
  assert.equal(validateConfigPatch({ voiceLang: 'jp' }).ok, false);
});

test('动作预览说清「从什么改成什么」', () => {
  const text = describeToolCall('update_config',
    { patch: { deepseekModel: 'deepseek-v4-pro' }, reason: '试试旗舰' },
    { config: { deepseekModel: 'deepseek-flash' } });
  assert.match(text, /文案模型/);
  assert.match(text, /deepseek-flash/);
  assert.match(text, /deepseek-v4-pro/);
  assert.match(text, /试试旗舰/);

  const sched = describeToolCall('schedule_action',
    { op: 'disable', id: 'job-3' },
    { jobs: [{ id: 'job-3', time: '09:05', type: '仅视频', account: '05' }] });
  assert.match(sched, /停用/);
  assert.match(sched, /09:05/);

  // 发布预览必须提醒"会真的发出去"
  assert.match(describeToolCall('run_publish', { maxCount: 2 }), /真的发到 TikTok/);
  assert.match(describeToolCall('run_engine', { mode: 'video' }), /会花钱/);
  assert.match(describeToolCall('run_collect', {}), /浏览器/);
});

test('密钥永不进上下文/预览/账本', () => {
  const dirty = {
    deepseekApiKey: 'sk-abcdef1234567890',
    siliconflowApiKey: 'sf-xyz',
    accounts: [{ name: '01', password: 'p@ssw0rd', emailPassword: 'mail-pass', totpSecret: 'JBSWY3DP' }],
    nested: { tgBotToken: '123:AAxxx' },
    ok: 1,
  };
  const clean = redactDeep(dirty);
  const text = JSON.stringify(clean);
  for (const secret of ['sk-abcdef1234567890', 'sf-xyz', 'p@ssw0rd', 'mail-pass', 'JBSWY3DP', '123:AAxxx']) {
    assert.ok(!text.includes(secret), `泄漏了：${secret}`);
  }
  assert.equal(clean.ok, 1);

  const line = ledgerLine({ tool: 'update_config', args: dirty, level: 'write', ok: true, ms: 12, brief: 'ok' });
  assert.ok(!JSON.stringify(line).includes('sk-abcdef'));
});

test('审计行结构固定，长度有上限', () => {
  const line = ledgerLine({ tool: 'get_status', args: {}, level: 'read', ok: true, ms: 3.7, brief: 'x'.repeat(900) });
  assert.equal(line.tool, 'get_status');
  assert.equal(line.level, 'read');
  assert.equal(line.ms, 4);
  assert.equal(line.confirmed, false);
  assert.ok(line.brief.length <= 300);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(line.at));
});

test('上下文裁剪：保留 system、丢掉最老的、不以 tool 结果开头', () => {
  const msgs = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 40; i++) {
    msgs.push({ role: 'user', content: `u${i}` });
    msgs.push({ role: 'tool', content: `t${i}` });
  }
  const out = trimHistory(msgs);
  assert.ok(out.length <= MAX_HISTORY_MESSAGES, `裁完还有 ${out.length}`);
  assert.equal(out[0].role, 'system');
  assert.notEqual(out[1].role, 'tool');
  assert.equal(out[out.length - 1].content, 't39');   // 最新一条保留
  // 短对话原样返回
  assert.equal(trimHistory([{ role: 'user', content: 'hi' }]).length, 1);
});

test('工具结果太长会被截断并明确告知', () => {
  const s = stringifyToolResult({ blob: 'x'.repeat(9000) });
  assert.ok(s.length < 7000, `长度 ${s.length}`);
  assert.match(s, /已截断/);
  assert.equal(stringifyToolResult('short'), 'short');
  // 循环引用不许抛异常
  const cyc = {}; cyc.self = cyc;
  assert.equal(typeof stringifyToolResult(cyc), 'string');
});

test('系统提示词把关键口径写清楚（未确认 / — / 只发当天）', () => {
  const p = buildSystemPrompt({ today: '2026-10-19', appVersion: '1.6.10', model: 'deepseek-flash' });
  assert.match(p, /2026-10-19/);
  assert.match(p, /未确认/);
  assert.match(p, /不是 0/);
  assert.match(p, /只发当天/);
  assert.match(p, /中文/);
});

test('白名单键都有中文标签（给预览用）', () => {
  for (const [k, spec] of Object.entries(CONFIG_WHITELIST)) {
    assert.ok(spec.label && spec.label.length >= 2, `${k} 缺中文标签`);
  }
});
