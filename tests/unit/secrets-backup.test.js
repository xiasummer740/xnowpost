/**
 * 凭据加密备份的纯逻辑单测。
 *
 * 守的口径：
 *  - 空包不许写（写了等于假备份，用户会以为有备份）；
 *  - 敏感文件（账号凭据）只能进加密包，不许被当成明文备份对象；
 *  - 坏包必须返回 null，不能抛异常把启动流程带崩；
 *  - 恢复只补"丢了/坏了"的文件，绝不覆盖好的那份。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SECRET_FILES,
  BUNDLE_FILE,
  buildBundle,
  summarizeBundle,
  isEmptyBundle,
  missingSecretLabels,
  parseBundle,
  mergeCookies,
  planRestore,
  describeBytes,
  isSensitiveRel,
} from '../../src/secrets-backup.js';

const FILES = {
  'data/env-accounts.json': '{"TK01":{"username":"a","password":"p","totpSecret":"ABC"}}',
  'data/account-profiles.json': '{"TK01":{"followers":"0"}}',
  'data/account-meta.json': '{"TK01":{}}',
  'config/schedule.json': '[{"id":1,"time":"08:30"}]',
  'data/publish-ledger.jsonl': '{"env":"TK01"}\n',
};

test('buildBundle 收齐 5 个文件，摘要数字对得上', () => {
  const b = buildBundle({ files: FILES, cookies: { TK01: [{ name: 'sessionid' }] }, version: '1.6.9' });
  const s = summarizeBundle(b);
  assert.equal(s.fileCount, 5);
  assert.deepEqual(s.cookieEnvs, ['TK01']);
  assert.ok(s.bytes > 100);
  assert.equal(b.version, '1.6.9');
});

test('buildBundle 丢掉非字符串内容与空 cookie 数组', () => {
  const b = buildBundle({ files: { 'a.json': 'x', 'b.json': 123, '': 'y' }, cookies: { TK01: [], TK02: null } });
  assert.deepEqual(Object.keys(b.files), ['a.json']);
  assert.deepEqual(Object.keys(b.cookies), []);
});

test('空包必须被判空（禁止写"假备份"）', () => {
  assert.equal(isEmptyBundle(buildBundle({})), true);
  assert.equal(isEmptyBundle(buildBundle({ files: {} })), true);
  assert.equal(isEmptyBundle(buildBundle({ files: FILES })), false);
});

test('missingSecretLabels 指出缺了哪些（2FA 那条最要紧）', () => {
  const b = buildBundle({ files: { 'config/schedule.json': '[]' } });
  const missing = missingSecretLabels(b);
  assert.equal(missing.length, SECRET_FILES.length - 1);
  // 账号凭据文件缺失时，日志必须点名"2FA"——否则用户不知道换机器将无法重登
  assert.ok(missing.some((m) => m.includes('2FA')));
});

test('parseBundle 对坏包一律返回 null，不抛异常', () => {
  assert.equal(parseBundle(''), null);
  assert.equal(parseBundle('不是 json'), null);
  assert.equal(parseBundle('{"v":99,"files":{}}'), null);
  assert.equal(parseBundle('{"v":1}'), null);
  assert.equal(parseBundle('{"v":1,"files":[]}'), null);
  assert.equal(parseBundle(null), null);
  // 正常包能解回原文（含文件内容逐字节一致）
  const b = buildBundle({ files: FILES });
  const back = parseBundle(JSON.stringify(b));
  assert.ok(back);
  assert.equal(back.files['data/env-accounts.json'], FILES['data/env-accounts.json']);
  assert.ok(back.files['data/env-accounts.json'].includes('totpSecret'));
});

test('mergeCookies 只并有效结果，同环境覆盖', () => {
  let b = buildBundle({ files: FILES, cookies: { TK01: [1] } });
  b = mergeCookies(b, 'TK01', [2, 3]);
  b = mergeCookies(b, 'TK02', []);
  b = mergeCookies(b, '', [4]);
  assert.deepEqual(b.cookies.TK01, [2, 3]);
  assert.equal(b.cookies.TK02, undefined);
  assert.equal(Object.keys(b.cookies).length, 1);
});

test('planRestore 只补丢了/坏了的，好文件不动', () => {
  const b = buildBundle({ files: FILES });
  const plan = planRestore(b, (rel) => (rel.endsWith('env-accounts.json') ? 'missing' : rel.endsWith('schedule.json') ? 'corrupt' : 'ok'));
  assert.deepEqual(plan.map((p) => p.rel).sort(), ['config/schedule.json', 'data/env-accounts.json']);
  assert.ok(plan.find((p) => p.rel.includes('env-accounts')).label.includes('2FA'));
});

test('planRestore 遇到探测异常按损坏处理（宁可多补一个）', () => {
  const b = buildBundle({ files: FILES });
  const plan = planRestore(b, () => {
    throw new Error('读不了');
  });
  assert.equal(plan.length, 5);
  assert.ok(plan.every((p) => p.reason === 'corrupt'));
});

test('敏感文件判定：账号凭据/备份目录/用户配置都算敏感', () => {
  assert.equal(isSensitiveRel('data/env-accounts.json'), true);
  assert.equal(isSensitiveRel('data\\env-accounts.json'), true);
  assert.equal(isSensitiveRel('config/user.json'), true);
  assert.equal(isSensitiveRel('backups/cookies/2026-10-19/TK01.json'), true);
  assert.equal(isSensitiveRel('data/account-profiles.json'), false);
});

test('describeBytes 三档都读得懂', () => {
  assert.equal(describeBytes(512), '512 B');
  assert.equal(describeBytes(2048), '2.0 KB');
  assert.equal(describeBytes(3 * 1024 * 1024), '3.0 MB');
  assert.ok(BUNDLE_FILE.endsWith('.enc'), '备份文件必须是加密后缀，防止误当明文');
});
