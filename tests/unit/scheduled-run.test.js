/**
 * 「定时轮次结果」记录的单测。
 *
 * 这一层守的是三件事（都是踩过 / 明确立过规矩的）：
 *   1. 结果码只能来自 `runWithRetry()` 的返回值 —— 不许靠搜日志文字猜成败；
 *   2. 汇报文案不许把"进程正常退出"说成"已发布"，`confirmed:false` 不算成功；
 *   3. 记录文件的读/写/标记已回报/清理不会把已回报的再说一遍、也不会把老记录灌进对话。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RUN_MODE_LABEL,
  RUN_RESULTS,
  buildRunRecord,
  describeScheduledRun,
  fmtCost,
  fmtDuration,
  listPendingRunRecords,
  localHHMM,
  markRunReported,
  mergePublishedEvidence,
  parseSessionLine,
  pickSession,
  pruneRunRecords,
  publishedText,
  resultFromRunWithRetry,
  runRecordFileName,
  writeRunRecord,
} from '../../src/scheduled-run.js';

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `xnow-run-${tag}-`));
}

// ───────────────────────── 1. 会话行解析 ─────────────────────────

test('parseSessionLine：从引擎的 📅 行取日期 + 会话 + 模式（Windows 路径）', () => {
  const line = '📅 D:\\xnowpost\\output\\2026-10-19\\am_0830 | 模式: video | 主题: 测试';
  assert.deepEqual(parseSessionLine(line), { date: '2026-10-19', session: 'am_0830', mode: 'video' });
});

test('parseSessionLine：不是会话行就返回 null（普通日志不能误判）', () => {
  assert.equal(parseSessionLine('📅 2026/10/19 10:45:07 日报已生成'), null);
  assert.equal(parseSessionLine('🎬 开始合成视频'), null);
  assert.equal(parseSessionLine(''), null);
  assert.equal(parseSessionLine(null), null);
});

test('pickSession：一轮里有多次重试时取最后一条（那才是真正落地的产物）', () => {
  const lines = [
    '📅 F:\\x\\output\\2026-10-19\\am_0830 | 模式: video',
    '❌ 失败：退出码 1',
    '📅 F:\\x\\output\\2026-10-19\\am_0840 | 模式: video',
  ];
  assert.equal(pickSession(lines).session, 'am_0840');
  assert.equal(pickSession([]), null);
  assert.equal(pickSession(['nothing']), null);
});

// ───────────────────────── 2. 结果码映射 ─────────────────────────

test('resultFromRunWithRetry：五个返回值各映射到一个结果码', () => {
  assert.equal(resultFromRunWithRetry({ ok: true }), 'ok');
  assert.equal(resultFromRunWithRetry({ ok: false, insufficient: true }), 'insufficient');
  assert.equal(resultFromRunWithRetry({ ok: false, unconfirmed: true }), 'unconfirmed');
  assert.equal(resultFromRunWithRetry({ ok: false, timeout: true }), 'timeout');
  assert.equal(resultFromRunWithRetry({ ok: false }), 'failed');
  // 拿不到返回值（异常路径）也算失败，绝不当成成功
  assert.equal(resultFromRunWithRetry(null), 'failed');
  assert.equal(resultFromRunWithRetry(undefined), 'failed');
});

test('养号部分成功 = partial，不能记成整轮失败，也不能记成完全成功', () => {
  // 2026-10-23 凌晨真实数据：10 个号里 8 个养成了、TK04/TK05 被拦，脚本退出码 1 →
  // 记录写成「已重试 2 次均失败」，用户以为整晚白跑。
  assert.equal(resultFromRunWithRetry({ ok: true, partial: true }), 'partial');
  assert.notEqual(resultFromRunWithRetry({ ok: true, partial: true }), 'failed');
  assert.notEqual(resultFromRunWithRetry({ ok: true, partial: true }), 'ok');
  const text = describeScheduledRun(
    buildRunRecord({
      job: { id: 23, label: '养号', mode: 'warmup' },
      result: 'partial',
      reason: '有账号没养成（播放被拦或白屏）',
      date: '2026-10-23',
    }),
    {},
  );
  assert.match(text, /部分完成/);
  assert.match(text, /没养成/);
});

test('结果码常量与文案分支对齐（新增结果码必须同时加文案分支）', () => {
  for (const code of RUN_RESULTS) {
    const text = describeScheduledRun(
      buildRunRecord({ job: { id: 1, label: '仅视频' }, result: code, date: '2026-10-19' }),
      {},
    );
    assert.ok(text.length > 8, `${code} 没有对应文案`);
  }
  assert.deepEqual(Object.keys(RUN_MODE_LABEL).sort(), ['auto', 'collect', 'post', 'text', 'video']);
});

// ───────────────────────── 3. 记录组装 ─────────────────────────

test('buildRunRecord：字段齐全、耗时正确、非法结果码回落到 failed', () => {
  const rec = buildRunRecord({
    job: { id: 12, label: '仅视频', mode: 'video', account: ' 01 ' },
    startedAtMs: Date.parse('2026-10-19T00:30:00+08:00'),
    finishedAtMs: Date.parse('2026-10-19T00:34:12+08:00'),
    result: 'ok',
    date: '2026-10-19',
    session: 'am_0030',
    logFile: 'C:\\d\\logs\\scheduler-2026-10-19.log',
  });
  assert.equal(rec.jobId, 12);
  assert.equal(rec.account, '01');                 // 账号两端空格要去掉
  assert.equal(rec.result, 'ok');
  assert.equal(rec.durationMs, 4 * 60 * 1000 + 12 * 1000);
  assert.equal(rec.startedAt, '2026-10-18T16:30:00.000Z');   // 存的是 ISO，显示时才转本地
  assert.equal(localHHMM(rec.startedAtMs), '00:30');          // 本地时间，不许是 UTC 的 16:30

  const bad = buildRunRecord({ result: 'weird' });
  assert.equal(bad.result, 'failed');
});

test('runRecordFileName：按名字排序 = 按时间排序，且带任务 id', () => {
  const mk = (ms) => buildRunRecord({ job: { id: 7 }, startedAtMs: ms, date: '2026-10-19' });
  const a = runRecordFileName(mk(Date.parse('2026-10-19T00:30:00+08:00')));
  const b = runRecordFileName(mk(Date.parse('2026-10-19T09:05:00+08:00')));
  assert.equal(a, '2026-10-19-0030-7.json');
  assert.equal(b, '2026-10-19-0905-7.json');
  assert.ok(a < b);
  assert.match(runRecordFileName(buildRunRecord({ job: {} })), /-x\.json$/);
});

// ───────────────────────── 4. 文案：只说实话 ─────────────────────────

test('describeScheduledRun：成功 + 已发布 → 带环境、标题、用时、花费', () => {
  const rec = buildRunRecord({
    job: { id: 1, label: '仅视频', mode: 'video', account: '01' },
    startedAtMs: Date.parse('2026-10-19T08:30:00+08:00'),
    finishedAtMs: Date.parse('2026-10-19T08:34:12+08:00'),
    result: 'ok',
    session: 'am_0830',
  });
  const text = describeScheduledRun(rec, {
    published: [{ env: 'TK01', title: '矩阵打法', at: '2026-10-19T00:34:00.000Z' }],
    cost: 0.0237,
  });
  assert.match(text, /^✅ 定时轮次完成/);
  assert.match(text, /08:30 · 仅视频 · 账号 01/);
  assert.match(text, /已发布 → TK01《矩阵打法》/);
  assert.match(text, /用时 4 分 12 秒/);
  assert.match(text, /¥0\.024/);          // <¥0.1 保留三位，别写成 ¥0.02
});

test('describeScheduledRun：进程正常退出但没产物 → 绝不说「已发布」', () => {
  const rec = buildRunRecord({
    job: { id: 2, label: '仅视频', mode: 'video' },
    startedAtMs: Date.parse('2026-10-19T08:35:00+08:00'),
    finishedAtMs: Date.parse('2026-10-19T08:36:00+08:00'),
    result: 'ok',
    session: 'am_0835',
  });
  const text = describeScheduledRun(rec, {});
  assert.match(text, /^⚠️ 定时轮次完成/);
  assert.ok(!text.includes('已发布'));
  assert.ok(text.includes('没看到成片也没看到发布记录'));
});

test('describeScheduledRun：确认不到公开 → 说「未确认」，不说成功、不说失败', () => {
  const rec = buildRunRecord({
    job: { id: 3, mode: 'video', account: '02' },
    result: 'ok',
    session: 'am_0840',
  });
  const text = describeScheduledRun(rec, { unconfirmedPublish: true, hasVideo: true });
  assert.match(text, /没确认到公开/);
  assert.ok(!text.includes('✅'));
});

test('describeScheduledRun：成片在但没发 → 说成片好了', () => {
  const rec = buildRunRecord({ job: { id: 4, mode: 'video' }, result: 'ok', session: 'am_0845' });
  const text = describeScheduledRun(rec, { hasVideo: true });
  assert.match(text, /^📦/);
  assert.match(text, /am_0845 成片好了（video\.mp4），这次没发布/);
});

test('describeScheduledRun：失败带原因与卡住的阶段，并指向调度器日志', () => {
  const rec = buildRunRecord({
    job: { id: 5, mode: 'video', account: '03' },
    finishedAtMs: Date.now(),
    result: 'failed',
    reason: '已重试 2 次均失败：退出码 1',
    session: 'am_0850',
    logFile: 'C:\\d\\logs\\scheduler-2026-10-19.log',
  });
  const text = describeScheduledRun(rec, { failed: { stage: '上传视频', reason: '' } });
  assert.match(text, /^❌ 定时轮次失败/);
  assert.match(text, /已重试 2 次均失败/);
  assert.match(text, /卡在「上传视频」/);
  assert.match(text, /日志 scheduler-2026-10-19\.log/);
});

test('describeScheduledRun：超时 / 未确认 / 数据不足 / 跳过 各有各的说法', () => {
  const base = { job: { id: 6, mode: 'video', account: '04' }, session: 'am_0855' };

  const timeout = describeScheduledRun(buildRunRecord({ ...base, result: 'timeout' }), {});
  assert.match(timeout, /^⏱️ 定时轮次超时/);
  assert.match(timeout, /请人工确认/);

  const unconfirmed = describeScheduledRun(buildRunRecord({ ...base, result: 'unconfirmed' }), {});
  assert.match(unconfirmed, /^⚠️ 定时轮次未确认/);
  assert.match(unconfirmed, /不重试、不重发/);

  const insufficient = describeScheduledRun(buildRunRecord({ ...base, result: 'insufficient' }), {});
  assert.match(insufficient, /^ℹ️ 定时轮次结束/);
  assert.match(insufficient, /数据不足/);

  const skipped = describeScheduledRun(
    buildRunRecord({ ...base, result: 'skipped', reason: '账号 04 的环境没登录' }),
    {},
  );
  assert.match(skipped, /^⏭️ 定时轮次跳过/);
  assert.match(skipped, /账号 04 的环境没登录/);
});

test('describeScheduledRun：采集轮次报「采到几个号」，不报成片/发布', () => {
  const rec = buildRunRecord({ job: { id: 11, mode: 'collect', label: '数据采集 + 日报' }, result: 'ok' });
  const text = describeScheduledRun(rec, {
    collect: { total: 10, collected: 8, insufficient: 1, failures: ['05'] },
  });
  assert.match(text, /数据采集/);
  assert.match(text, /采集到 8\/10 个账号的数据/);
  assert.match(text, /1 个数据不足/);
  assert.match(text, /1 个失败/);
  assert.ok(!text.includes('已发布'));
});

test('publishedText：单条带标题，多条带条数和环境去重', () => {
  assert.equal(publishedText([{ env: 'TK01', title: 'A' }]), '已发布 → TK01《A》');
  assert.equal(
    publishedText([{ env: 'TK01', title: 'A' }, { env: 'TK01', title: 'B' }, { env: 'TK05' }]),
    '已发布 3 条 → TK01、TK05（含《A》）',
  );
  assert.equal(publishedText([]), '');
  assert.equal(publishedText(null), '');
});

// ───── 4b. 证据合并：同一次发布不能算成两条（2026-10-19 实测差 1 毫秒） ─────

test('mergePublishedEvidence：.published 与账本差 1 毫秒 → 只算 1 条，字段互补', () => {
  // 真实数据形状（pm_2257 / TK05，2026-10-19 22:59）
  const merged = mergePublishedEvidence([
    // 会话 .published（没有 at 字段，标题在标记里）
    { env: 'TK05', session: 'pm_2257', at: '', title: '' },
    // 账本行（时间戳差 1 毫秒）
    { env: 'TK05', session: 'pm_2257', at: '2026-10-19T14:59:12.422Z', title: '矩阵打法' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].at, '2026-10-19T14:59:12.422Z');
  assert.equal(merged[0].title, '矩阵打法');
  // 说人话：1 条，不是 2 条
  assert.match(publishedText(merged), /^已发布 → TK05《矩阵打法》$/);
});

test('mergePublishedEvidence：不同会话 / 不同环境不合并（publish 轮次真发多条）', () => {
  const merged = mergePublishedEvidence([
    { env: 'TK01', session: 'am_0830', at: 't1', title: 'A' },
    { env: 'TK01', session: 'am_0840', at: 't2', title: 'B' },
    { env: 'TK05', session: 'am_0830', at: 't3', title: 'C' },
    { env: 'TK01', session: 'am_0830', at: 't4', title: 'A2' },   // 重复来源
  ]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].title, 'A');           // 先到的字段保留，不被后来的覆盖
  assert.match(publishedText(merged), /已发布 3 条 → TK01、TK05（含《A》）/);
});

test('mergePublishedEvidence：空数组/坏输入不抛异常', () => {
  assert.deepEqual(mergePublishedEvidence([]), []);
  assert.deepEqual(mergePublishedEvidence(null), []);
  assert.deepEqual(mergePublishedEvidence([null, undefined]), []);
  assert.deepEqual(mergePublishedEvidence([{}]), [{ env: '', session: '', at: '', title: '' }]);
});

test('fmtDuration / fmtCost：小数值不说成 0（11 秒、¥0.004）', () => {
  assert.equal(fmtDuration(11_000), '11 秒');
  assert.equal(fmtDuration(89_000), '89 秒');
  assert.equal(fmtDuration(90_000), '1 分 30 秒');
  assert.equal(fmtDuration(120_000), '2 分钟');
  assert.equal(fmtDuration(0), '');
  assert.equal(fmtCost(0.0039), '¥0.004');
  assert.equal(fmtCost(0.0237), '¥0.024');
  assert.equal(fmtCost(1.236), '¥1.24');
  assert.equal(fmtCost(0), '');
  assert.equal(fmtCost(NaN), '');
});

// ───────────────────────── 5. 落盘：写 / 读未回报 / 标记 / 清理 ─────────────────────────

test('记录落盘：写 → 列出未回报 → 标记已回报 → 不再列出', () => {
  const dir = tmpDir('pending');
  try {
    const rec = buildRunRecord({
      job: { id: 8, mode: 'video', account: '05' },
      startedAtMs: Date.now() - 60_000,
      finishedAtMs: Date.now() - 30_000,
      result: 'ok',
      session: 'am_0830',
    });
    const file = writeRunRecord(dir, rec);
    assert.ok(fs.existsSync(file));

    const pending = listPendingRunRecords(dir);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].record.jobId, 8);

    assert.equal(markRunReported(pending[0]), true);
    assert.equal(listPendingRunRecords(dir).length, 0);
    // 标记后记录本身还在（留证据，只是不再重复说）
    assert.ok(fs.existsSync(file));
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).reportedAt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('记录落盘：6 小时前的记录不再灌进对话（重装/迁移后不会刷屏）', () => {
  const dir = tmpDir('stale');
  try {
    const old = buildRunRecord({
      job: { id: 9 },
      startedAtMs: Date.now() - 8 * 3600 * 1000,
      finishedAtMs: Date.now() - 8 * 3600 * 1000,
      result: 'ok',
    });
    writeRunRecord(dir, old);
    assert.equal(listPendingRunRecords(dir).length, 0);
    // 但记录文件还在，人工排查时能看到
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('记录落盘：坏 JSON 跳过不抛异常；空目录返回空数组', () => {
  const dir = tmpDir('bad');
  try {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ 坏文件');
    assert.deepEqual(listPendingRunRecords(dir), []);
    assert.deepEqual(listPendingRunRecords(path.join(dir, '不存在')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('记录落盘：多条按结束时间正序（老的一轮先说）', () => {
  const dir = tmpDir('order');
  try {
    const now = Date.now();
    writeRunRecord(dir, buildRunRecord({
      job: { id: 2 }, startedAtMs: now - 60_000, finishedAtMs: now - 50_000, result: 'ok',
    }));
    writeRunRecord(dir, buildRunRecord({
      job: { id: 1 }, startedAtMs: now - 20_000, finishedAtMs: now - 10_000, result: 'ok',
    }));
    assert.deepEqual(listPendingRunRecords(dir).map((x) => x.record.jobId), [2, 1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneRunRecords：删 7 天前的记录，7 天内一个不动；days<=0 不清理', () => {
  const dir = tmpDir('prune');
  try {
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    writeRunRecord(dir, buildRunRecord({
      job: { id: 1 }, startedAtMs: now - 30 * day, finishedAtMs: now - 30 * day, result: 'ok', date: '2026-09-01',
    }));
    writeRunRecord(dir, buildRunRecord({
      job: { id: 2 }, startedAtMs: now - 2 * day, finishedAtMs: now - 2 * day, result: 'ok',
    }));
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 2);

    assert.equal(pruneRunRecords(dir, { days: 0 }), 0);      // days<=0 = 不清理
    assert.equal(pruneRunRecords(dir), 1);                    // 默认 7 天
    const left = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(left.length, 1);
    assert.match(left[0], /-2\.json$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
