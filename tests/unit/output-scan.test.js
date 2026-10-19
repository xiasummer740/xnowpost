/**
 * 发布候选扫描的唯一实现 —— 单测。
 *
 * 这些用例对应的都是**真出事过**的场景（2026-10-19 审查）：
 *   - 积压 57 个未发布会话，其中 14 个带 FAILED、最老 2026-06-18；
 *   - 「发布全部」不确认就能真发；
 *   - 调度器路径把"未确认"当成功。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_MAX_PER_RUN,
  sessionTime,
  classifySession,
  scanUnpublished,
  summarizeSkips,
  isDateDirName,
} from '../../src/output-scan.js';

/** 造一个假 output 目录树 */
function makeTree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xnow-scan-'));
  for (const [rel, files] of Object.entries(spec)) {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files || {})) {
      fs.writeFileSync(path.join(dir, name), body === null ? '' : String(body));
    }
  }
  return root;
}

test('sessionTime 认 am_0830 / pm_1430-2，认不出给空串（不是 undefined:undefined）', () => {
  assert.equal(sessionTime('am_0830'), '08:30');
  assert.equal(sessionTime('pm_2014'), '20:14');
  assert.equal(sessionTime('pm_1430-2'), '14:30');
  assert.equal(sessionTime('job_9999'), '');
  assert.equal(sessionTime('随便一个名字'), '');
  assert.equal(sessionTime(''), '');
});

test('isDateDirName 只认 YYYY-MM-DD', () => {
  assert.equal(isDateDirName('2026-10-19'), true);
  assert.equal(isDateDirName('2026-10-19-backup'), false);
  assert.equal(isDateDirName('am_0830'), false);
});

test('classifySession：正常会话可发', () => {
  const v = classifySession({ files: ['video.mp4', '封面.png', '文案.txt'] });
  assert.equal(v.action, 'publish');
  assert.equal(v.reason, 'ok');
});

test('classifySession：已发布的跳过（含未确认也不许重传）', () => {
  const base = { files: ['video.mp4', '文案.txt'] };
  assert.equal(classifySession({ ...base, published: { confirmed: true } }).action, 'skip');
  const unconfirmed = classifySession({ ...base, published: { confirmed: false } });
  assert.equal(unconfirmed.action, 'skip');
  assert.equal(unconfirmed.reason, 'unconfirmed');
  // 老标记没有 confirmed 字段 → 按已发布处理
  assert.equal(classifySession({ ...base, published: {} }).reason, 'published');
  // 坏标记也按已发布处理（保守）
  assert.equal(classifySession({ ...base, published: { __broken: true } }).reason, 'published');
});

test('classifySession：合成失败的 mp4 不可信，发布失败的可重试', () => {
  const base = { files: ['video.mp4', '文案.txt'] };
  assert.equal(classifySession({ ...base, failed: { stage: '视频合成' } }).reason, 'failed-synthesize');
  assert.equal(classifySession({ ...base, failed: { stage: '合成' } }).reason, 'failed-synthesize');
  const retry = classifySession({ ...base, failed: { stage: '自动发布', reason: '掉登录' } });
  assert.equal(retry.action, 'retry');
  assert.equal(retry.reason, 'retry-publish');
  // 失败标记说"发出去了" → 绝不重发
  assert.equal(classifySession({ ...base, failed: { published: true } }).reason, 'failed-published');
  // FAILED 文件坏了 → 保守跳过
  assert.equal(classifySession({ ...base, failed: { __broken: true } }).reason, 'failed-broken');
});

test('classifySession：缺文案/缺内容都跳过', () => {
  assert.equal(classifySession({ files: ['video.mp4'] }).reason, 'no-txt');
  assert.equal(classifySession({ files: ['文案.txt'] }).reason, 'no-content');
  // 只有封面.png 不算图片帖
  assert.equal(classifySession({ files: ['文案.txt', '封面.png'] }).reason, 'no-content');
});

test('默认只发当天：两个月前的老会话不进候选（本次审查的核心风险）', () => {
  const root = makeTree({
    '2026-10-19/am_0830': { 'video.mp4': 'v', '文案.txt': '今天的内容' },
    '2026-06-18/am_0927': { 'video.mp4': 'v', '文案.txt': '两个月前的内容' },
    '2026-10-18/pm_2014': { 'video.mp4': 'v', '文案.txt': '昨天的内容' },
  });
  const today = scanUnpublished({ outputDir: root, today: '2026-10-19' });
  assert.equal(today.items.length, 1);
  assert.equal(today.items[0].date, '2026-10-19');
  assert.equal(today.items[0].title, '今天的内容');
  assert.equal(today.skipped.filter((s) => s.reason === 'old-date').length, 2);
  // 但界面的"待发布"列表要能看到它们（并标 old）
  assert.equal(today.pending.length, 3);
  assert.ok(today.pending.filter((p) => p.old).length === 2);

  // 显式 includeOld 才会把它们放进来（CLI 的 --any-date）
  const all = scanUnpublished({ outputDir: root, today: '2026-10-19', onlyToday: false });
  assert.equal(all.items.length, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test('待发布列表标出 FAILED 与可重试性', () => {
  const root = makeTree({
    '2026-10-19/am_0835': { 'video.mp4': 'v', '文案.txt': 'A', FAILED: JSON.stringify({ stage: '自动发布' }) },
    '2026-10-19/am_0840': { 'video.mp4': 'v', '文案.txt': 'B', FAILED: JSON.stringify({ stage: '视频合成' }) },
  });
  const r = scanUnpublished({ outputDir: root, today: '2026-10-19' });
  const byTitle = Object.fromEntries(r.pending.map((p) => [p.title, p]));
  assert.equal(byTitle.A.failed, true);
  assert.equal(byTitle.A.retryable, true);
  assert.equal(byTitle.B.failed, true);
  assert.equal(byTitle.B.retryable, false);
  // 只有"发布阶段失败"的进候选
  assert.deepEqual(r.items.map((i) => i.title), ['A']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('maxCount 截断并写进跳过原因（默认 3 条）', () => {
  const spec = {};
  for (let i = 0; i < 5; i++) {
    spec[`2026-10-19/am_08${30 + i * 5}`] = { 'video.mp4': 'v', '文案.txt': `内容${i}` };
  }
  const root = makeTree(spec);
  const r = scanUnpublished({ outputDir: root, today: '2026-10-19', maxCount: DEFAULT_MAX_PER_RUN });
  assert.equal(r.items.length, 3);
  assert.equal(r.skipped.filter((s) => s.reason === 'over-limit').length, 2);
  // 不限（0）= 全给
  const all = scanUnpublished({ outputDir: root, today: '2026-10-19', maxCount: 0 });
  assert.equal(all.items.length, 5);
  fs.rmSync(root, { recursive: true, force: true });
});

test('按日期/会话新→旧排序（先发最新的）', () => {
  const root = makeTree({
    '2026-10-19/am_0830': { 'video.mp4': 'v', '文案.txt': '早' },
    '2026-10-19/pm_2014': { 'video.mp4': 'v', '文案.txt': '晚' },
  });
  const r = scanUnpublished({ outputDir: root, today: '2026-10-19', onlyToday: false });
  assert.deepEqual(r.items.map((i) => i.title), ['晚', '早']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('坏标记不抛异常、目录不存在返回空', () => {
  const root = makeTree({
    '2026-10-19/am_0830': { 'video.mp4': 'v', '文案.txt': 'A', '.published': '{坏 json' },
  });
  const r = scanUnpublished({ outputDir: root, today: '2026-10-19' });
  assert.equal(r.items.length, 0);
  assert.equal(r.skipped[0].reason, 'published');
  assert.deepEqual(scanUnpublished({ outputDir: path.join(root, '不存在'), today: '2026-10-19' }).items, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('summarizeSkips 聚合成一句话', () => {
  const s = summarizeSkips([
    { reason: 'published' },
    { reason: 'published' },
    { reason: 'old-date' },
  ]);
  assert.ok(s.includes('已发布 2'));
  assert.ok(s.includes('旧日期会话 1'));
  assert.equal(summarizeSkips([]), '');
});
