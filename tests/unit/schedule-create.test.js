/**
 * 「新建定时任务」能力的边界测试（2026-10-19 用户反馈「让 AI 新建闹钟都做不了，级别有点低」）。
 *
 * 为什么值得单测：`create` 是本项目里第一个「无中生有」的写操作 ——
 * 改配置/启停都只是动已有对象，新建会往 schedule.json 里塞一条新记录，
 * 参数错（坏时间、不存在的账号）或重复插入都会直接变成"到点跑不起来"或"同一分钟发两次"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_DEFS,
  getToolDef,
  levelOf,
  needsConfirm,
  validateArgs,
  describeToolCall,
  SCHEDULE_MODE_LABEL,
  normalizeJobTime,
  LEVEL,
} from '../../electron/lib/assistant-tools.js';

const def = getToolDef('schedule_action');

test('schedule_action 支持 create，且 id 不再是必填', () => {
  assert.ok(def, 'schedule_action 必须存在');
  assert.deepEqual(def.parameters.properties.op.enum, ['create', 'enable', 'disable', 'delete', 'update']);
  assert.deepEqual(def.parameters.required, ['op'], 'create 不需要 id，所以 required 只有 op');
  for (const k of ['time', 'mode', 'account']) {
    assert.ok(def.parameters.properties[k], `缺参数定义：${k}`);
  }
});

test('新建仍是「写」级：必须人点执行', () => {
  assert.equal(levelOf('schedule_action'), LEVEL.WRITE);
  assert.equal(needsConfirm('schedule_action'), true);
});

test('op 之外的枚举一律拒绝（不许模型自造 check/reset 之类）', () => {
  assert.equal(validateArgs('schedule_action', { op: 'create' }).ok, true);
  assert.equal(validateArgs('schedule_action', { op: 'rename' }).ok, false);
  assert.equal(validateArgs('schedule_action', {}).ok, false, '缺 op 必须拒绝');
  assert.equal(validateArgs('schedule_action', { op: 'create', extra: 1 }).ok, false, '多余字段拒绝');
});

test('create 的参数类型也要过关', () => {
  const ok = validateArgs('schedule_action', { op: 'create', time: '01:10', mode: 'video', account: '09' });
  assert.equal(ok.ok, true);
  assert.equal(validateArgs('schedule_action', { op: 'create', mode: 'music' }).ok, false, '枚举外类型');
  // 校验层会把 830 转成字符串 "830"（宽松），真正的守门在 executor 的 normalizeJobTime
  const coerced = validateArgs('schedule_action', { op: 'create', time: 830 });
  assert.equal(coerced.ok, true);
  assert.equal(normalizeJobTime(coerced.args.time), null, '"830" 不是合法时间，必须被拦住');
});

test('确认卡文案说清「新建」什么（时间/类型/账号）', () => {
  const text = describeToolCall('schedule_action', { op: 'create', time: '01:10', mode: 'video', account: '09' });
  assert.match(text, /新建定时任务/);
  assert.match(text, /01:10/);
  assert.match(text, /仅视频/);
  assert.match(text, /账号 09/);
  assert.match(text, /默认启用/, '要告诉用户新建出来的任务是开着的');
  assert.match(text, /编号自动分配/);
});

test('create 的文案随类型变化（auto/post）', () => {
  assert.match(describeToolCall('schedule_action', { op: 'create', time: '19:00', mode: 'auto', account: '02' }), /视频\+图文/);
  assert.match(describeToolCall('schedule_action', { op: 'create', time: '19:00', mode: 'post', account: '02' }), /仅图文/);
  // 不传 mode 时默认「仅视频」
  assert.match(describeToolCall('schedule_action', { op: 'create', time: '19:00', account: '02' }), /仅视频/);
});

test('原有的 enable/disable/delete/update 文案没被 create 分支挤掉', () => {
  const ctx = { jobs: [{ id: 8, time: '09:05', mode: 'video', account: '08' }] };
  assert.match(describeToolCall('schedule_action', { op: 'disable', id: '8' }, ctx), /停用定时任务：#8/);
  assert.match(describeToolCall('schedule_action', { op: 'delete', id: '8' }, ctx), /删除定时任务/);
  assert.match(describeToolCall('schedule_action', { op: 'update', id: '8', patch: { time: '09:20' } }, ctx), /09:20/);
});

test('模式中文名和界面口径一致', () => {
  assert.deepEqual(SCHEDULE_MODE_LABEL, {
    auto: '视频+图文',
    video: '仅视频',
    post: '仅图文',
    collect: '数据采集',
  });
  // 每个模式都得有中文名，否则确认卡会露出英文 key
  for (const t of TOOL_DEFS) {
    if (t.name === 'schedule_action') {
      for (const m of t.parameters.properties.mode.enum) {
        assert.ok(SCHEDULE_MODE_LABEL[m], `模式 ${m} 缺中文名`);
      }
    }
  }
});

test('时间规范化：宽容输入、严格落盘（8:30 → 08:30，超范围一律拒绝）', () => {
  assert.equal(normalizeJobTime('8:30'), '08:30');
  assert.equal(normalizeJobTime('08:30'), '08:30');
  assert.equal(normalizeJobTime('8：30'), '08:30', '全角冒号也要认');
  assert.equal(normalizeJobTime(' 09:05 '), '09:05');
  assert.equal(normalizeJobTime('1:05'), '01:05');
  assert.equal(normalizeJobTime('0:00'), '00:00');
  assert.equal(normalizeJobTime('23:59'), '23:59');
  for (const bad of ['24:00', '08:60', '830', 'abc', '', null, undefined, '08:5', '8:3']) {
    assert.equal(normalizeJobTime(bad), null, `${bad} 不该被接受`);
  }
});

test('批量新建：items 里的对象要保留结构（不能被校验层拍成字符串）', () => {
  const r = validateArgs('schedule_action', {
    op: 'create',
    items: [
      { time: '08:30', account: '01' },
      { time: '08:35', account: '02', mode: 'auto' },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(Array.isArray(r.args.items), true);
  assert.equal(typeof r.args.items[0], 'object');
  assert.equal(r.args.items[0].time, '08:30');
  assert.equal(r.args.items[1].mode, 'auto');
});

test('批量新建的确认卡逐条列出时间/账号，太多就省略', () => {
  const items = Array.from({ length: 15 }, (_, i) => ({ time: `08:${String(30 + i).padStart(2, '0')}`, account: String(i + 1).padStart(2, '0') }));
  const text = describeToolCall('schedule_action', { op: 'create', items });
  assert.match(text, /新建 15 个定时任务/);
  assert.match(text, /每天 08:30 · 仅视频 · 账号 01/);
  assert.match(text, /还有 3 条/);
  // 只列 12 条，不能把 15 行全塞进确认卡
  assert.equal(text.split('\n').filter((l) => l.includes('每天 08:')).length, 12);
});