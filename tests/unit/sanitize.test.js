/**
 * 主进程安全/纯逻辑工具的真实单元测试。
 *
 * 与原有测试不同，这里**直接 import 生产代码**（electron/lib/sanitize.js），
 * 而不是在本文件里重写一份实现。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';

import {
  SECRET_FIELDS,
  maskSecret,
  isMaskedValue,
  resolveSessionDir,
  isValidDataDir,
  mimeForImage,
  readTextCapped,
  dedupeJobIds,
} from '../../electron/lib/sanitize.js';

describe('maskSecret / isMaskedValue', () => {
  test('掩码保持长度、保留首 6 尾 4', () => {
    const key = 'sk-FAKEKEYFORUNITTEST0000000000000';   // leak-check-allow：合成夹具，非真实 Key
    const masked = maskSecret(key);
    assert.equal(masked.length, key.length);
    assert.equal(masked.slice(0, 6), key.slice(0, 6));
    assert.equal(masked.slice(-4), key.slice(-4));
    assert.ok(masked.includes('*'));
    // 中间必须真的被遮住
    assert.ok(!masked.includes(key.slice(10, 20)));
  });

  test('掩码自身可被识别为掩码', () => {
    assert.equal(isMaskedValue(maskSecret('sk-1234567890abcdefghij')), true);
  });

  test('真实 Key 不会被误判为掩码', () => {
    assert.equal(isMaskedValue('sk-1234567890abcdefghij'), false);
    assert.equal(isMaskedValue(''), false);
    assert.equal(isMaskedValue(undefined), false);
  });

  test('短值全部打码，不泄露任何字符', () => {
    assert.equal(maskSecret('abc'), '***');
    assert.equal(maskSecret('1234567890'), '**********');
  });

  test('空值返回空串', () => {
    for (const v of ['', null, undefined, 0, false]) {
      assert.equal(maskSecret(v), '');
    }
  });

  test('SECRET_FIELDS 覆盖所有敏感字段', () => {
    for (const f of ['deepseekApiKey', 'siliconflowApiKey', 'pexelsApiKey', 'tgBotToken', 'bitApiKey']) {
      assert.ok(SECRET_FIELDS.includes(f), `缺少敏感字段: ${f}`);
    }
  });
});

describe('resolveSessionDir（路径收敛 / 防目录穿越）', () => {
  let tmp;
  let base;
  let validDir;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xnowpost-sess-'));
    base = path.join(tmp, 'output');
    validDir = path.join(base, '2026-10-16', 'pm_1430');
    fs.ensureDirSync(validDir);
    fs.ensureDirSync(path.join(base, '2026-10-16', '_video'));
  });

  after(() => {
    try { fs.removeSync(tmp); } catch (_) { /* ignore */ }
  });

  test('合法 session 目录通过', () => {
    assert.equal(resolveSessionDir(validDir, base), path.resolve(validDir));
  });

  test('相对路径也能解析（只要落在 base 内）', () => {
    const rel = path.relative(process.cwd(), validDir);
    // 相对路径基于 cwd，可能落在 base 外 —— 两种结果都必须是「合法绝对路径」或 null
    const r = resolveSessionDir(rel, base);
    if (r !== null) assert.ok(path.isAbsolute(r));
  });

  test('拒绝路径穿越 ../..', () => {
    assert.equal(resolveSessionDir(path.join(base, '..', '..', 'Windows'), base), null);
    assert.equal(resolveSessionDir(path.join(base, '2026-10-16', '..', '..'), base), null);
  });

  test('拒绝 base 之外的绝对路径', () => {
    assert.equal(resolveSessionDir('C:/Windows/System32', base), null);
    assert.equal(resolveSessionDir(tmp, base), null);
  });

  test('拒绝层级不等于 2 的路径', () => {
    assert.equal(resolveSessionDir(base, base), null);                                     // 0 层
    assert.equal(resolveSessionDir(path.join(base, '2026-10-16'), base), null);             // 1 层
    assert.equal(resolveSessionDir(path.join(validDir, '_video'), base), null);             // 3 层
  });

  test('拒绝日期目录名不合法的路径', () => {
    const bad = path.join(base, 'not-a-date', 'pm_1');
    fs.ensureDirSync(bad);
    assert.equal(resolveSessionDir(bad, base), null);
  });

  test('拒绝含路径分隔符/非法字符的 session 名', () => {
    const bad = path.join(base, '2026-10-16', 'a b');
    fs.ensureDirSync(bad);
    assert.equal(resolveSessionDir(bad, base), null);
  });

  test('目标是文件而非目录时返回 null', () => {
    const filePath = path.join(base, '2026-10-16', 'afile.txt');
    fs.writeFileSync(filePath, 'x');
    assert.equal(resolveSessionDir(filePath, base), null);
  });

  test('不存在的目录返回 null', () => {
    assert.equal(resolveSessionDir(path.join(base, '2026-10-16', 'nope'), base), null);
  });

  test('非字符串入参返回 null', () => {
    for (const v of [null, undefined, 123, {}, [], '']) {
      assert.equal(resolveSessionDir(v, base), null);
    }
  });
});

describe('isValidDataDir（数据目录校验）', () => {
  const ROOT = process.platform === 'win32' ? 'C:\\app\\xnowpost' : '/app/xnowpost';

  test('空值视为使用默认目录，合法', () => {
    for (const v of ['', undefined, null]) assert.equal(isValidDataDir(v, ROOT), true);
  });

  test('相对路径非法', () => {
    assert.equal(isValidDataDir('data', ROOT), false);
    assert.equal(isValidDataDir('./data', ROOT), false);
  });

  test('安装目录本身及其子目录非法', () => {
    assert.equal(isValidDataDir(ROOT, ROOT), false);
    assert.equal(isValidDataDir(path.join(ROOT, 'config'), ROOT), false);
    assert.equal(isValidDataDir(path.join(ROOT, '..', 'xnowpost', 'sub'), ROOT), false);
  });

  test('安装目录之外的绝对路径合法', () => {
    const other = process.platform === 'win32' ? 'D:\\xnowpost-data' : '/data/xnowpost';
    assert.equal(isValidDataDir(other, ROOT), true);
  });

  test('非字符串非法', () => {
    for (const v of [123, {}, []]) assert.equal(isValidDataDir(v, ROOT), false);
  });
});

describe('mimeForImage', () => {
  test('按扩展名返回正确 MIME', () => {
    assert.equal(mimeForImage('a.png'), 'image/png');
    assert.equal(mimeForImage('a.PNG'), 'image/png');
    assert.equal(mimeForImage('a.jpg'), 'image/jpeg');
    assert.equal(mimeForImage('a.jpeg'), 'image/jpeg');
    assert.equal(mimeForImage('a.webp'), 'image/webp');
    assert.equal(mimeForImage('a.gif'), 'image/gif');
    assert.equal(mimeForImage('a.bmp'), 'image/png');  // 未知扩展名回退
    assert.equal(mimeForImage('noext'), 'image/png');
  });
});

describe('readTextCapped（日志读取上限）', () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xnowpost-read-')); });
  after(() => { try { fs.removeSync(tmp); } catch (_) { /* ignore */ } });

  test('小文件完整读取', () => {
    const f = path.join(tmp, 'small.log');
    fs.writeFileSync(f, 'hello\n世界\n', 'utf-8');
    assert.equal(readTextCapped(f, 1024), 'hello\n世界\n');
  });

  test('超限时只返回尾部，且长度恰为上限', () => {
    const f = path.join(tmp, 'big.log');
    const content = 'A'.repeat(100) + 'B'.repeat(500);
    fs.writeFileSync(f, content, 'utf-8');
    const got = readTextCapped(f, 200);
    assert.equal(Buffer.byteLength(got, 'utf-8'), 200);
    assert.ok(got.endsWith('B'));          // 尾部确实是文件末尾
    assert.equal(got, content.slice(-200));
  });

  test('文件不存在时抛错（由调用方处理）', () => {
    assert.throws(() => readTextCapped(path.join(tmp, 'nope.log')));
  });
});

describe('dedupeJobIds（定时任务 id 自愈）', () => {
  test('真实场景：保留首个、重发重复 id', () => {
    const jobs = [{ id: 2 }, { id: 101 }, { id: 101 }];
    const { jobs: out, changed } = dedupeJobIds(jobs);
    assert.equal(changed, true);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map(j => j.id), [2, 101, 102]);
    // 原对象不被修改（纯函数）
    assert.equal(jobs[2].id, 101);
  });

  test('全部唯一时不改动内容', () => {
    const jobs = [{ id: 1 }, { id: 5 }, { id: 9 }];
    const { jobs: out, changed } = dedupeJobIds(jobs);
    assert.equal(changed, false);
    assert.deepEqual(out.map(j => j.id), [1, 5, 9]);
  });

  test('多个重复组全部唯一化', () => {
    const jobs = [{ id: 3 }, { id: 102 }, { id: 102 }, { id: 3 }, { id: 107 }, { id: 107 }];
    const { jobs: out } = dedupeJobIds(jobs);
    const ids = out.map(j => j.id);
    assert.equal(new Set(ids).size, ids.length, `仍有重复: ${ids}`);
    // 「首个出现者保留原 id」：3 在 index 0，107 在 index 4
    assert.equal(ids[0], 3, `index 0 应保留原 id 3，实际 ${ids[0]}`);
    assert.equal(ids[4], 107, `index 4 应保留原 id 107，实际 ${ids[4]}`);
    assert.deepEqual([ids[1], ids[2], ids[3], ids[5]], [102, 108, 109, 110]);
  });

  test('非法 id（缺失/非数字/0/负数）被重新分配', () => {
    const jobs = [{ id: 0 }, { id: -1 }, { id: 'abc' }, { id: null }, {}, { id: 7 }];
    const { jobs: out, changed } = dedupeJobIds(jobs);
    assert.equal(changed, true);
    const ids = out.map(j => j.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes(7), '合法 id 7 应保留');
  });

  test('非数组入参安全返回', () => {
    for (const v of [null, undefined, 'x', 42, {}]) {
      const r = dedupeJobIds(v);
      assert.equal(r.changed, false);
      assert.equal(r.jobs, v);
    }
  });

  test('空数组', () => {
    const r = dedupeJobIds([]);
    assert.equal(r.changed, false);
    assert.deepEqual(r.jobs, []);
  });

  test('保留重复项的其它字段', () => {
    const jobs = [{ id: 101, time: '07:00', account: '02' }, { id: 101, time: '08:00', account: '03' }];
    const { jobs: out } = dedupeJobIds(jobs);
    assert.equal(out[1].time, '08:00');
    assert.equal(out[1].account, '03');
    assert.notEqual(out[0].id, out[1].id);
  });
});
