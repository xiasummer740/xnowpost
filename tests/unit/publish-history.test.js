/**
 * 发布账本 / 「每个账号最后一次发布成功时间」
 *
 * 这些用例守的是账号页那一列的口径：
 *   · 只认「点了 Post 且确认」的记录（confirmed:false 不算成功）；
 *   · 同一环境多条记录取最新；
 *   · 账本（publish-ledger.jsonl）与老会话的 .published 合并时，账本里的时间更准，取较新的那个。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  scanPublishHistory,
  latestByEnv,
  appendLedger,
  readLedger,
  latestPublishByEnv,
  dataDirOfSession,
} from '../../src/publish-history.js';

function makeDataDir({ sessions = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xnp-hist-'));
  for (const s of sessions) {
    const dir = path.join(root, 'output', s.date, s.session);
    fs.mkdirSync(dir, { recursive: true });
    if (s.published) {
      fs.writeFileSync(path.join(dir, '.published'), JSON.stringify(s.published), 'utf8');
    }
    if (s.publishLog) fs.writeFileSync(path.join(dir, 'publish.log'), s.publishLog, 'utf8');
    if (s.title) fs.writeFileSync(path.join(dir, '文案.txt'), `${s.title}\n英文标题\n`, 'utf8');
  }
  return root;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('dataDirOfSession 从 <数据目录>/output/<日期>/<会话> 反推数据目录', () => {
  const root = path.join(os.tmpdir(), 'xnp-x');
  const session = path.join(root, 'output', '2026-10-18', 'pm_2316');
  assert.equal(dataDirOfSession(session), root);
});

test('scanPublishHistory 只收有 .published 的会话，并按时间倒序（按日期目录倒序扫描）', () => {
  const root = makeDataDir({
    sessions: [
      { date: '2026-10-18', session: 'pm_2316', published: { publishedAt: '2026-10-18T15:17:47.259Z', env: 'TK02' }, title: '网速慢' },
      { date: '2026-10-17', session: 'pm_1010', published: { publishedAt: '2026-10-17T02:10:00.000Z', env: 'TK01' } },
      { date: '2026-10-18', session: 'pm_2400' },   // 没发布，应被跳过
    ],
  });
  try {
    const list = scanPublishHistory(path.join(root, 'output'));
    assert.equal(list.length, 2);
    assert.equal(list[0].env, 'TK02');           // 最新日期目录在前
    assert.equal(list[0].title, '网速慢');        // 文案.txt 兜底标题
    assert.ok(list.every((r) => r.confirmed));
  } finally { cleanup(root); }
});

test('老会话没有 env 字段时，从 publish.log 里解析「打开指纹环境 TKxx」', () => {
  const root = makeDataDir({
    sessions: [{
      date: '2026-10-18', session: 'pm_2227',
      published: { publishedAt: '2026-10-18T14:29:31.657Z' },
      publishLog: '+   0.0s  Δ     2ms    📝 标题: x\n+   2.1s  Δ  2100ms    🌐 打开指纹环境 TK08...\n',
    }],
  });
  try {
    const list = scanPublishHistory(path.join(root, 'output'));
    assert.equal(list[0].env, 'TK08');
  } finally { cleanup(root); }
});

test('latestByEnv 对同一环境取最新一条，且跳过 confirmed:false', () => {
  const root = makeDataDir({
    sessions: [
      { date: '2026-10-18', session: 'pm_1000', published: { publishedAt: '2026-10-18T02:00:00.000Z', env: 'TK02' } },
      { date: '2026-10-18', session: 'pm_2000', published: { publishedAt: '2026-10-18T12:00:00.000Z', env: 'TK02' } },
      { date: '2026-10-18', session: 'pm_2300', published: { publishedAt: '2026-10-18T15:00:00.000Z', env: 'TK02', confirmed: false } },
    ],
  });
  try {
    const latest = latestByEnv(path.join(root, 'output'));
    assert.equal(latest.TK02.session, 'pm_2000');                       // 未确认的那条被跳过
    assert.equal(latest.TK02.at, '2026-10-18T12:00:00.000Z');
  } finally { cleanup(root); }
});

test('账本追加 / 读取往返一致，坏行被跳过', () => {
  const root = makeDataDir();
  try {
    assert.equal(appendLedger(root, { env: 'TK01', at: '2026-10-18T00:32:05.759Z', session: 'am_0830', title: '多平台运营' }), true);
    assert.equal(appendLedger(root, { env: 'TK03', at: '2026-10-18T01:00:00.000Z', session: 'am_0832' }), true);
    const file = path.join(root, 'data', 'publish-ledger.jsonl');
    fs.appendFileSync(file, '这不是 JSON\n', 'utf8');   // 坏行
    const rows = readLedger(root);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].env, 'TK01');
    assert.equal(rows[0].title, '多平台运营');
  } finally { cleanup(root); }
});

test('latestPublishByEnv 合并账本与 .published，取较新的那个', () => {
  const root = makeDataDir({
    sessions: [
      // .published 说是 20:00，账本说是 21:00（账本更可信/更新）
      { date: '2026-10-18', session: 'pm_2000', published: { publishedAt: '2026-10-18T12:00:00.000Z', env: 'TK05' } },
      // 只有 .published，没有账本记录
      { date: '2026-10-18', session: 'pm_1900', published: { publishedAt: '2026-10-18T11:00:00.000Z', env: 'TK06' } },
    ],
  });
  try {
    appendLedger(root, { env: 'TK05', at: '2026-10-18T13:00:00.000Z', session: 'pm_2100', title: '账本这条更新' });
    const latest = latestPublishByEnv(root);
    assert.equal(latest.TK05.at, '2026-10-18T13:00:00.000Z');
    assert.equal(latest.TK05.title, '账本这条更新');
    assert.equal(latest.TK06.at, '2026-10-18T11:00:00.000Z');   // 没账本也能显示
  } finally { cleanup(root); }
});

test('账本目录不存在时 appendLedger 会自动建目录，不抛异常', () => {
  const root = makeDataDir();
  try {
    assert.equal(fs.existsSync(path.join(root, 'data')), false);
    assert.equal(appendLedger(root, { env: 'TK10', at: '2026-10-18T14:53:48.804Z', session: 'pm_2251' }), true);
    assert.equal(fs.existsSync(path.join(root, 'data', 'publish-ledger.jsonl')), true);
  } finally { cleanup(root); }
});

test('空目录 / 不存在的目录都返回空对象，不抛异常', () => {
  assert.deepEqual(latestByEnv(path.join(os.tmpdir(), 'xnp-not-exist-123')), {});
  const root = makeDataDir();
  try {
    assert.deepEqual(latestPublishByEnv(root), {});
  } finally { cleanup(root); }
});
