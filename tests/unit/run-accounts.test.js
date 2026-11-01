import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAccountLine, parseAccountResults, summarizeAccountResults } from '../../src/run-accounts.js';

// 这些字符串全部来自真实日志（2026-11-01 那天的 scheduler-<日期>.log）
const WARM_OK = '✅ TK01 看了 40 条（真播 40 条，共 562 秒） · 赞4';
const WARM_WARN = '⚠️ TK05 看了 4 条（真播 3 条，共 38 秒） · 无动作 · 卡住11次';
const WARM_ERR = '❌ TK09 养号失败：环境 TK09 的浏览器进程起来了，但页面 150 秒都没就绪（上一轮可能还在收尾）。';
const BATCH_OK = '✅ 批量 · 账号 01（1/11） 完成';
const BATCH_ERR = '❌ 批量 · 账号 02（2/11） 失败：退出码 3';
const COLLECT_OK = '✅ 01: {"views":4,"profile_views":3,"likes":4,"shares":0} (@xnow.matrix)';
const COLLECT_ERR = '❌ 03: 打不开环境';

test('养号三种结论都能认出来（✅ / ⚠️ / ❌）', () => {
  assert.deepEqual(
    [parseAccountLine(WARM_OK), parseAccountLine(WARM_WARN), parseAccountLine(WARM_ERR)].map((r) => [r.env, r.level]),
    [['TK01', 'ok'], ['TK05', 'warn'], ['TK09', 'error']],
  );
});

test('批量轮「账号 NN」按图标判成败，环境名补成 TKNN', () => {
  assert.equal(parseAccountLine(BATCH_OK).env, 'TK01');
  assert.equal(parseAccountLine(BATCH_OK).level, 'ok');
  assert.equal(parseAccountLine(BATCH_ERR).env, 'TK02');
  assert.equal(parseAccountLine(BATCH_ERR).level, 'error');
});

test('采集轮的「01: {json}」也能认出账号', () => {
  assert.equal(parseAccountLine(COLLECT_OK).env, 'TK01');
  assert.equal(parseAccountLine(COLLECT_OK).level, 'ok');
  assert.equal(parseAccountLine(COLLECT_ERR).env, 'TK03');
  assert.equal(parseAccountLine(COLLECT_ERR).level, 'error');
});

test('环境开关行不算「这个号跑了什么」（否则失败会被覆盖成成功）', () => {
  assert.equal(parseAccountLine('✅ 指纹环境 TK05 已启动'), null);
  assert.equal(parseAccountLine('✅ 指纹环境 TK05 已关闭'), null);
  assert.equal(parseAccountLine('🗕 已把 TK05 的窗口缩到任务栏'), null);
});

test('没有行首图标的行一律不认（措辞变了也不会误判）', () => {
  assert.equal(parseAccountLine('ℹ️ TK01 已登录（4 个 session cookie）'), null);
  assert.equal(parseAccountLine('⚠️ 点「下一个」后内容没变'), null);   // 没有 TKxx
  assert.equal(parseAccountLine(''), null);
  assert.equal(parseAccountLine(null), null);
});

test('同一账号出现多次以最后一次为准（重试后那次才是真的）', () => {
  const out = parseAccountResults([
    BATCH_ERR,
    '✅ 批量 · 账号 02（2/11） 完成',
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].level, 'ok');
});

test('一轮 11 个号：解析成 11 条，按环境名排好序', () => {
  const lines = [];
  for (let i = 1; i <= 11; i++) {
    const env = 'TK' + String(i).padStart(2, '0');
    lines.push(i === 5 ? WARM_WARN.replace('TK05', env) : WARM_OK.replace('TK01', env));
  }
  const out = parseAccountResults(lines);
  assert.equal(out.length, 11);
  assert.equal(out[0].env, 'TK01');
  assert.equal(out[10].env, 'TK11');
  assert.deepEqual(summarizeAccountResults(out), { total: 11, ok: 10, warn: 1, error: 0 });
});

test('日志时间戳前缀会被去掉再解析', () => {
  assert.equal(parseAccountLine('[2026-11-01 02:12:08] ✅ TK01 看了 40 条 · 赞4').env, 'TK01');
});
