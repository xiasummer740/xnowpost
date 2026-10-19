import test from 'node:test';
import assert from 'node:assert/strict';
import { pickLogsToPrune, pickLogsByDate } from '../../electron/lib/log-prune.js';

const NOW = new Date('2026-10-19T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;

const dayMs = (n) => NOW - n * DAY;

test('只删超过保留天数的日志文件', () => {
  const out = pickLogsToPrune([
    { name: 'app-2026-10-19.log', mtimeMs: dayMs(0) },
    { name: 'app-2026-10-10.log', mtimeMs: dayMs(9) },
    { name: 'app-2026-09-01.log', mtimeMs: dayMs(48) },
    { name: 'scheduler-2026-08-01.log', mtimeMs: dayMs(79) },
  ], { nowMs: NOW, days: 30 });
  assert.deepEqual(out.sort(), ['app-2026-09-01.log', 'scheduler-2026-08-01.log']);
});

test('别的文件一概不碰（备份/证据/其它日志）', () => {
  const out = pickLogsToPrune([
    { name: 'app-2026-01-01.log', mtimeMs: dayMs(300) },      // 该删
    { name: 'cookies-backup.json', mtimeMs: dayMs(300) },     // 不删
    { name: 'collect-1048.json', mtimeMs: dayMs(300) },       // 不删
    { name: 'app-2026-01-01.log.bak', mtimeMs: dayMs(300) },  // 名字不符，不删
    { name: 'scheduler.log', mtimeMs: dayMs(300) },           // 没有日期，不删
  ], { nowMs: NOW, days: 30 });
  assert.deepEqual(out, ['app-2026-01-01.log']);
});

test('保留 0 天/负数 = 不清理（防止把自己刚写的日志删掉）', () => {
  const files = [{ name: 'app-2025-01-01.log', mtimeMs: dayMs(600) }];
  assert.deepEqual(pickLogsToPrune(files, { nowMs: NOW, days: 0 }), []);
  assert.deepEqual(pickLogsToPrune(files, { nowMs: NOW, days: -1 }), []);
});

test('脏数据不炸：空数组 / 缺字段 / 非数字 mtime', () => {
  assert.deepEqual(pickLogsToPrune([]), []);
  assert.deepEqual(pickLogsToPrune(null), []);
  assert.deepEqual(pickLogsToPrune([{ name: 'app-2020-01-01.log' }], { nowMs: NOW }), []);
  assert.deepEqual(pickLogsToPrune([{ mtimeMs: 0 }], { nowMs: NOW }), []);
});

test('按文件名日期清理（拷贝过的文件 mtime 不可靠）', () => {
  const files = [
    { name: 'app-2026-10-19.log' },
    { name: 'app-2026-09-20.log' },
    { name: 'app-2026-09-18.log' },   // 比 30 天前更早 → 删
    { name: 'scheduler-2026-06-17.log' },
    { name: 'notes.txt' },
  ];
  const out = pickLogsByDate(files, { today: '2026-10-19', days: 30 });
  assert.deepEqual(out.sort(), ['app-2026-09-18.log', 'scheduler-2026-06-17.log']);
});
