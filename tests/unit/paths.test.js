/**
 * 数据目录解析的真实单元测试（直接 import src/paths.js）
 *
 * 这个模块是 P1-3（数据目录不一致）的收敛点，
 * 所以测试重点是「环境变量优先级」与「不依赖 cwd」。
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'fs-extra';

import { resolveDataDir, dataPath, resolveCodeRoot } from '../../src/paths.js';

const ORIGINAL = process.env.XNOWPOST_DATA_DIR;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.XNOWPOST_DATA_DIR;
  else process.env.XNOWPOST_DATA_DIR = ORIGINAL;
});

describe('resolveDataDir', () => {
  test('优先使用 XNOWPOST_DATA_DIR（这是打包版注入数据目录的唯一通道）', () => {
    const custom = process.platform === 'win32' ? 'D:\\xnowpost-data' : '/data/xnowpost';
    process.env.XNOWPOST_DATA_DIR = custom;
    assert.equal(resolveDataDir(), custom);
  });

  test('未设置时回退到项目根目录（等价于 path.resolve(".")）', () => {
    delete process.env.XNOWPOST_DATA_DIR;
    assert.equal(resolveDataDir(), path.resolve('.'));
  });

  test('空字符串视为未设置', () => {
    process.env.XNOWPOST_DATA_DIR = '';
    assert.equal(resolveDataDir(), path.resolve('.'));
  });

  test('返回值一定是绝对路径', () => {
    for (const v of ['D:\\x', '/tmp/x', 'relative-data', '']) {
      process.env.XNOWPOST_DATA_DIR = v;
      assert.ok(path.isAbsolute(resolveDataDir()), `不是绝对路径: ${resolveDataDir()}`);
    }
  });
});

describe('dataPath', () => {
  test('拼接在数据目录之下', () => {
    const base = process.platform === 'win32' ? 'D:\\xnowpost-data' : '/data/xnowpost';
    process.env.XNOWPOST_DATA_DIR = base;
    assert.equal(dataPath('config', 'user.json'), path.join(base, 'config', 'user.json'));
  });

  test('无参数时等于数据目录本身', () => {
    process.env.XNOWPOST_DATA_DIR = process.platform === 'win32' ? 'D:\\d' : '/d';
    assert.equal(dataPath(), resolveDataDir());
  });

  test('常见子路径都落在数据目录内', () => {
    const base = path.resolve('F:', 'fake-root');
    process.env.XNOWPOST_DATA_DIR = base;
    for (const p of [
      dataPath('output', 'history.json'),
      dataPath('data', 'analytics.db'),
      dataPath('logs', 'app.log'),
      dataPath('config', 'schedule.json'),
    ]) {
      const rel = path.relative(base, p);
      assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel), `逃出数据目录: ${p}`);
    }
  });
});

describe('resolveCodeRoot', () => {
  test('返回当前工作目录的绝对路径', () => {
    const r = resolveCodeRoot();
    assert.ok(path.isAbsolute(r));
    assert.equal(r, path.resolve('.'));
  });

  test('代码根目录与数据目录是两个独立概念', () => {
    // 打包版：代码在 app.asar.unpacked，数据在 %APPDATA%。两者必须能不同。
    const custom = process.platform === 'win32' ? 'E:\\xnowpost-data' : '/e/xnowpost-data';
    process.env.XNOWPOST_DATA_DIR = custom;
    assert.notEqual(resolveDataDir(), resolveCodeRoot());
    // 且不应因为数据目录不存在而抛错
    assert.equal(fs.existsSync(resolveDataDir()), false);
  });
});
