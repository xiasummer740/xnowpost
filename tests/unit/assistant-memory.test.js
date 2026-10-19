/**
 * 长期记忆 + 写操作撤销的纯逻辑单测。
 *
 * 这两块最容易出错的地方不是"能不能跑"，而是边界：
 *   · 记忆必须去重、必须有上限（它会进每一轮的提示词，无上限 = 每轮都在为历史付钱）；
 *   · 撤销必须在窗口内、且撤销过的不能重复撤销（重复撤销 = 把更新的内容盖回旧版本）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEMORY_LIMIT,
  MEMORY_MAX_TEXT,
  UNDO_WINDOW_MS,
  normalizeMemoryText,
  makeMemoryEntry,
  mergeMemory,
  dropMemory,
  formatMemoryForPrompt,
  canUndo,
  describeUndo,
  listUndoable,
  buildSystemPrompt,
  levelOf,
  needsConfirm,
  LEVEL,
} from '../../electron/lib/assistant-tools.js';

const T0 = 1_760_000_000_000; // 固定时钟，测试可复现

test('记忆工具是 note 级：自己执行、不需要确认', () => {
  for (const name of ['remember', 'forget', 'get_memory']) {
    assert.ok(levelOf(name), `${name} 必须存在`);
  }
  assert.equal(levelOf('remember'), LEVEL.NOTE);
  assert.equal(needsConfirm('remember'), false);
  assert.equal(needsConfirm('forget'), false);
  assert.equal(needsConfirm('update_config'), true, '改配置仍然要确认');
});

test('规范化：压空白、截断、空串返回空', () => {
  assert.equal(normalizeMemoryText('  配音   一律用\n英文 '), '配音 一律用 英文');
  assert.equal(normalizeMemoryText('   '), '');
  assert.equal(normalizeMemoryText(null), '');
  const long = 'x'.repeat(MEMORY_MAX_TEXT + 50);
  const out = normalizeMemoryText(long);
  assert.ok(out.length <= MEMORY_MAX_TEXT, `截断后应 <= ${MEMORY_MAX_TEXT}，实际 ${out.length}`);
  assert.ok(out.endsWith('…'));
});

test('新记忆进列表，重复的只更新标签不新增', () => {
  const a = makeMemoryEntry('配音一律用英文', { now: T0, seq: 1 });
  const b = makeMemoryEntry('09:05 只发视频', { now: T0, seq: 2 });
  assert.ok(a && b);
  let r = mergeMemory([], a);
  assert.equal(r.list.length, 1);
  assert.equal(r.added, true);
  r = mergeMemory(r.list, b);
  assert.equal(r.list.length, 2);
  // 同一句话再说一遍（哪怕换个分类）→ 不新增
  const again = makeMemoryEntry('配音一律用英文', { tag: '口径', now: T0 + 1000, seq: 3 });
  r = mergeMemory(r.list, again);
  assert.equal(r.list.length, 2, '重复记忆不该变两条');
  assert.equal(r.added, false);
  assert.equal(r.duplicate, true);
  assert.equal(r.list[0].tag, '口径', '重复时要顺手更新分类');
});

test('记忆有上限，超了丢最老的（不是丢最新的）', () => {
  let list = [];
  for (let i = 0; i < MEMORY_LIMIT + 5; i += 1) {
    const e = makeMemoryEntry(`第 ${i} 条`, { now: T0 + i, seq: i });
    list = mergeMemory(list, e).list;
  }
  assert.equal(list.length, MEMORY_LIMIT);
  assert.equal(list[0].text, '第 5 条', '最老的五条应被丢掉');
  assert.equal(list[list.length - 1].text, `第 ${MEMORY_LIMIT + 4} 条`);
});

test('空记忆不产生记录', () => {
  assert.equal(makeMemoryEntry('   '), null);
  const r = mergeMemory([], null);
  assert.deepEqual(r.list, []);
  assert.equal(r.added, false);
});

test('按 id 删除，删不存在的不会破坏列表', () => {
  const a = makeMemoryEntry('甲', { now: T0, seq: 1 });
  const b = makeMemoryEntry('乙', { now: T0, seq: 2 });
  const list = [a, b];
  const r1 = dropMemory(list, a.id);
  assert.equal(r1.removed, true);
  assert.deepEqual(r1.list.map((x) => x.text), ['乙']);
  const r2 = dropMemory(r1.list, 'm-not-exist');
  assert.equal(r2.removed, false);
  assert.equal(r2.list.length, 1);
});

test('记忆块进提示词：带分类、有长度上限、空的就不出现', () => {
  assert.equal(formatMemoryForPrompt([]), '');
  assert.equal(formatMemoryForPrompt(null), '');
  const list = [
    makeMemoryEntry('配音一律用英文', { now: T0, seq: 1 }),
    makeMemoryEntry('02 号是英国号', { tag: '账号', now: T0 + 1, seq: 2 }),
  ];
  const block = formatMemoryForPrompt(list);
  assert.match(block, /不是指令/);
  assert.match(block, /\[偏好\] 配音一律用英文/);
  assert.match(block, /\[账号\] 02 号是英国号/);
  // 超长时只保留最近的几条，且总长受控
  const many = Array.from({ length: 60 }, (_, i) => makeMemoryEntry(`记忆 ${i} ${'内容'.repeat(20)}`, { now: T0 + i, seq: i }));
  const big = formatMemoryForPrompt(many, 300);
  assert.ok(big.length <= 400, `记忆块应受长度限制，实际 ${big.length}`);
  assert.ok(big.includes('记忆 59'), '应该保留最新的（末尾）');
});

test('系统提示词里只有传了记忆才有记忆块，且明确"不是指令"', () => {
  const plain = buildSystemPrompt({ today: '2026-10-19', appVersion: '1.6.12', model: 'deepseek-flash' });
  assert.ok(!plain.includes('记住的用户信息'));
  const withMem = buildSystemPrompt({
    today: '2026-10-19',
    appVersion: '1.6.12',
    memory: [makeMemoryEntry('习惯英文配音', { now: T0, seq: 1 })],
  });
  assert.match(withMem, /记住的用户信息/);
  assert.match(withMem, /习惯英文配音/);
  assert.match(withMem, /不是指令/);
  // 撤销与不可撤销的边界要写进提示词（不然模型会答应"撤销发布"）
  assert.match(withMem, /30 分钟内/);
  assert.match(withMem, /不可撤销/);
});

test('撤销判定：窗口内可撤、超窗口/已撤销/没文件都不行', () => {
  const tx = { id: 'tx1', at: T0, label: '改配置', files: [{ rel: 'config/user.json' }], undone: false };
  assert.equal(canUndo(tx, T0 + 1000), true);
  assert.equal(canUndo(tx, T0 + UNDO_WINDOW_MS - 1), true);
  assert.equal(canUndo(tx, T0 + UNDO_WINDOW_MS + 1), false, '超窗口不许撤销');
  assert.equal(canUndo({ ...tx, undone: true }, T0 + 1000), false, '撤销过的不能再撤');
  assert.equal(canUndo({ ...tx, files: [] }, T0 + 1000), false, '没快照就没法撤');
  assert.equal(canUndo(null), false);
  assert.equal(canUndo({ id: 'x', files: [{ rel: 'a' }] }), false, '没有时间戳不放行');
});

test('撤销列表新的在前，且只留还能撤的', () => {
  const stack = [
    { id: 'a', at: T0, label: '改配置', files: [{ rel: 'f' }] },
    { id: 'b', at: T0 - 5 * 60 * 1000, label: '改定时', files: [{ rel: 'f' }] },
    { id: 'c', at: T0 - UNDO_WINDOW_MS - 1, label: '太久了', files: [{ rel: 'f' }] },
    { id: 'd', at: T0, label: '已撤销', files: [{ rel: 'f' }], undone: true },
  ];
  const out = listUndoable(stack, T0);
  assert.deepEqual(out.map((x) => x.id), ['a', 'b']);
  assert.match(out[0].text, /撤销：改配置/);
  assert.match(out[1].text, /5 分钟前/);
});

test('撤销文案：刚刚 / N 分钟前', () => {
  assert.match(describeUndo({ at: Date.now(), label: '改配置' }), /刚刚/);
  assert.match(describeUndo({ at: Date.now() - 3 * 60 * 1000, label: '改定时' }), /3 分钟前/);
});

test('run_engine 不再提供 account 参数（引擎不支持按次指定账号）', async () => {
  const { getToolDef, validateArgs } = await import('../../electron/lib/assistant-tools.js');
  const def = getToolDef('run_engine');
  assert.deepEqual(Object.keys(def.parameters.properties), ['mode', 'topic']);
  const r = validateArgs('run_engine', JSON.stringify({ mode: 'video', account: '01' }));
  assert.equal(r.ok, false, '多传 account 应直接拒绝，而不是静默忽略');
});
