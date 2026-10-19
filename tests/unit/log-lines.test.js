import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLevel,
  normalizeTime,
  parseLogText,
  dropEchoedSchedulerLines,
  mergeLogLines,
} from '../../electron/lib/log-lines.js';

test('应用日志：带级别标签，警告必须归一成 warning（界面筛选用这个 key）', () => {
  const lines = parseLogText('[2026/10/19 10:45:07] [WARN] 磁盘快满了\n', 'app');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'warning');
  assert.equal(lines[0].time, '2026-10-19 10:45:07', '斜杠要换成横杠，才好和调度器日志一起排序');
  assert.equal(lines[0].message, '磁盘快满了');
  assert.equal(lines[0].source, 'app');
});

test('调度器日志：没有级别标签，靠内容判类型', () => {
  const text = [
    '[2026-10-19 08:30:00] 🚀 仅视频 任务开始（超时预算 1800s）',
    '[2026-10-19 08:30:00] 🔐 TK01 已登录（4 个 session cookie）',
    '[2026-10-19 10:02:43] ❌ 采集失败: 全部 10 个账号数据不足',
    '[2026-10-19 09:50:00] ✅ 旧草稿已彻底丢弃',
    '[2026-10-19 09:51:00] ⚠️ 重试 1/2',
  ].join('\n');
  const lines = parseLogText(text, 'scheduler');
  assert.deepEqual(lines.map((l) => l.type), ['info', 'info', 'error', 'success', 'warning']);
  assert.equal(lines[0].source, 'scheduler');
});

test('应用日志里回声的调度器行要被丢掉（否则每条出现两次）', () => {
  const app = parseLogText(
    '[2026/10/19 10:45:07] [INFO] ⏰ [2026-10-19 10:45:01]   ⏰ 10:00 → 数据采集 + 日报\n' +
      '[2026/10/19 10:46:00] [INFO] 打开配置页\n',
    'app'
  );
  const kept = dropEchoedSchedulerLines(app);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].message, '打开配置页');
});

test('合并：按时间升序，两种时间格式能对齐', () => {
  const app = parseLogText('[2026/10/19 10:30:05] [INFO] 应用事件\n', 'app');
  const sched = parseLogText(
    '[2026-10-19 10:30:01] 调度事件一\n[2026-10-19 10:30:09] 调度事件二\n',
    'scheduler'
  );
  const merged = mergeLogLines([app, sched]);
  assert.deepEqual(merged.map((l) => l.message), ['调度事件一', '应用事件', '调度事件二']);
});

test('合并：同一秒内保持各自原顺序（app 在前）', () => {
  const app = parseLogText('[2026/10/19 10:30:05] [INFO] A\n', 'app');
  const sched = parseLogText('[2026-10-19 10:30:05] B\n', 'scheduler');
  const merged = mergeLogLines([app, sched]);
  assert.deepEqual(merged.map((l) => l.message), ['A', 'B']);
});

test('合并只保留尾部 N 行（日志上万行时不能把 DOM 撑死）', () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    `[2026-10-19 10:30:${String(i % 60).padStart(2, '0')}] 第 ${i} 行`
  ).join('\n');
  const lines = mergeLogLines([parseLogText(many, 'scheduler')], 10);
  assert.equal(lines.length, 10);
  assert.equal(lines[9].message, '第 49 行');
});

test('脏数据不炸：空文本 / 没有时间戳的行 / 空行', () => {
  assert.deepEqual(parseLogText('', 'app'), []);
  assert.deepEqual(parseLogText('\n\n', 'app'), []);
  const weird = parseLogText('没有时间戳的一行\n', 'app');
  assert.equal(weird.length, 1);
  assert.equal(weird[0].time, '');
  assert.equal(normalizeTime(' 2026/10/19 1:2:3 '), '2026-10-19 1:2:3');
});

test('classifyLevel：未知级别按内容判，什么都没有就是 info', () => {
  assert.equal(classifyLevel('ERROR', ''), 'error');
  assert.equal(classifyLevel('', '✅ 已发布'), 'success');
  assert.equal(classifyLevel('', '普通一行'), 'info');
  assert.equal(classifyLevel(undefined, undefined), 'info');
});

test('「超时预算 1800s」不能算错误（否则每轮任务开头都是红的）', () => {
  assert.equal(classifyLevel('', '🚀 仅视频 任务开始（超时预算 1800s）'), 'info');
  assert.equal(classifyLevel('', '❌ 任务超时（1800s）'), 'error');
});

test('句子里只是提到「失败」的正常行不许判错（2026-10-19 10 轮全被染红的原因）', () => {
  assert.equal(classifyLevel('', '🗣️ 先做配音（失败则一分钱不花在生图上）...'), 'info');
  assert.equal(classifyLevel('', '⚠️ 日报未确认送达：TG 未配置或推送失败（见上方错误日志）'), 'warning');
  assert.equal(classifyLevel('', '🚫 文案含敏感信息（价格/优惠），重写中(1/2)...'), 'warning', '被拦下重写不是失败');
  assert.equal(classifyLevel('', '❌ 仅视频 失败：Locator.click: Timeout 30000ms exceeded'), 'error');
  assert.equal(classifyLevel('', '失败：数据不足'), 'error');
  assert.equal(classifyLevel('', '✅ 数据采集 + 日报 完成'), 'success');
});
