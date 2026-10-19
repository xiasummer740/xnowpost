/**
 * 原子写工具的真实单元测试（直接 import src/fs-atomic.js）
 *
 * 这个模块的价值在于「进程被杀时不留半截文件」，
 * 所以测试必须验证：写入后目标内容完整、临时文件不残留、覆盖写不损坏旧文件。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';

import {
  writeFileAtomicSync,
  writeJsonAtomicSync,
  writeFileAtomic,
  writeJsonAtomic,
} from '../../src/fs-atomic.js';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xnowpost-atomic-')); });
after(() => { try { fs.removeSync(tmp); } catch (_) { /* ignore */ } });

/** 目录里除了给定文件外，不应残留 .tmp 临时文件 */
function assertNoTempLeftovers(dir) {
  const leftovers = fs.readdirSync(dir).filter(f => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], `残留临时文件: ${leftovers}`);
}

describe('writeFileAtomicSync', () => {
  test('新建文件内容正确', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'a-'));
    const f = path.join(dir, 'x.txt');
    writeFileAtomicSync(f, 'hello 世界');
    assert.equal(fs.readFileSync(f, 'utf-8'), 'hello 世界');
    assertNoTempLeftovers(dir);
  });

  test('覆盖已有文件（Windows 上 rename 也能覆盖）', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'b-'));
    const f = path.join(dir, 'x.txt');
    fs.writeFileSync(f, 'old-content-that-is-longer');
    writeFileAtomicSync(f, 'new');
    assert.equal(fs.readFileSync(f, 'utf-8'), 'new');
    assertNoTempLeftovers(dir);
  });

  test('自动创建不存在的父目录', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'c-'));
    const f = path.join(dir, 'deep', 'nested', 'x.txt');
    writeFileAtomicSync(f, 'ok');
    assert.equal(fs.readFileSync(f, 'utf-8'), 'ok');
  });

  test('Buffer 内容按二进制写入', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'd-'));
    const f = path.join(dir, 'x.bin');
    const buf = Buffer.from([0x00, 0xff, 0x10, 0x20]);
    writeFileAtomicSync(f, buf);
    assert.deepEqual(fs.readFileSync(f), buf);
    assertNoTempLeftovers(dir);
  });

  test('目标路径是目录时抛错且不残留临时文件', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'e-'));
    const asDir = path.join(dir, 'iamadir');
    fs.ensureDirSync(asDir);
    assert.throws(() => writeFileAtomicSync(asDir, 'x'));
    assertNoTempLeftovers(dir);
  });
});

describe('writeJsonAtomicSync', () => {
  test('写入可被 JSON.parse 读回，且格式化缩进', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'f-'));
    const f = path.join(dir, 'x.json');
    const obj = { a: 1, b: '中文', c: [1, 2, { d: true }] };
    writeJsonAtomicSync(f, obj);
    assert.deepEqual(fs.readJsonSync(f), obj);
    assert.ok(fs.readFileSync(f, 'utf-8').includes('\n  '), '应为 2 空格缩进');
    assertNoTempLeftovers(dir);
  });

  test('覆盖损坏的旧 JSON 能恢复', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'g-'));
    const f = path.join(dir, 'x.json');
    fs.writeFileSync(f, '{ this is not json');
    writeJsonAtomicSync(f, { ok: true });
    assert.deepEqual(fs.readJsonSync(f), { ok: true });
  });

  test('空对象/空数组', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'h-'));
    const f1 = path.join(dir, 'o.json');
    const f2 = path.join(dir, 'a.json');
    writeJsonAtomicSync(f1, {});
    writeJsonAtomicSync(f2, []);
    assert.deepEqual(fs.readJsonSync(f1), {});
    assert.deepEqual(fs.readJsonSync(f2), []);
  });
});

describe('异步版本', () => {
  test('writeFileAtomic 内容正确且无残留', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'i-'));
    const f = path.join(dir, 'x.txt');
    await writeFileAtomic(f, 'async 内容');
    assert.equal(fs.readFileSync(f, 'utf-8'), 'async 内容');
    assertNoTempLeftovers(dir);
  });

  test('writeJsonAtomic 往返一致', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'j-'));
    const f = path.join(dir, 'x.json');
    const obj = { n: 42, s: '文本', nested: { arr: [1, 2, 3] } };
    await writeJsonAtomic(f, obj);
    assert.deepEqual(fs.readJsonSync(f), obj);
    assertNoTempLeftovers(dir);
  });

  test('并发写同一文件不产生残留，最终是某一次完整内容', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'k-'));
    const f = path.join(dir, 'x.json');
    const payloads = Array.from({ length: 20 }, (_, i) => ({ i, data: 'x'.repeat(500 + i) }));
    await Promise.all(payloads.map(p => writeJsonAtomic(f, p)));
    const final = fs.readJsonSync(f);   // 必须是完整可解析的 JSON（撕裂就会抛错）
    assert.ok(payloads.some(p => p.i === final.i));
    assert.equal(final.data.length, 500 + final.i);
    assertNoTempLeftovers(dir);
  });
});
