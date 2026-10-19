/**
 * 模型/上限的**数据目录覆盖**是否真的生效 —— 单测。
 *
 * 背景：模型名原来只写在代码目录 `config/default.json`（打包后在安装目录里），
 * 想换模型就得改代码重新打包。现在优先级是
 *   数据目录 `config/user.json`（deepseekModel / deepseekMaxTokens）
 *   > 代码目录 `config/default.json`
 *   > 内置 FALLBACK
 * 这里把数据目录指到临时目录来验证这条链路（`dataPath()` 每次调用都读环境变量，可测）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

import { getDeepSeekConfig, REASONING_MIN_MAX_TOKENS } from '../../src/engine/config.js';

/** 把数据目录指到临时目录，跑完恢复（其它用例还会用到真实环境） */
function withDataDir(overrides, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xnowpost-cfg-'));
  const old = process.env.XNOWPOST_DATA_DIR;
  try {
    if (overrides) {
      fs.ensureDirSync(path.join(dir, 'config'));
      fs.writeJsonSync(path.join(dir, 'config', 'user.json'), overrides);
    }
    process.env.XNOWPOST_DATA_DIR = dir;
    return fn(dir);
  } finally {
    if (old === undefined) delete process.env.XNOWPOST_DATA_DIR;
    else process.env.XNOWPOST_DATA_DIR = old;
    fs.removeSync(dir);
  }
}

test('数据目录里没设模型时，用代码目录默认的 deepseek-chat / 4096', () => {
  withDataDir({}, () => {
    const cfg = getDeepSeekConfig();
    assert.equal(cfg.model, 'deepseek-chat');
    assert.equal(cfg.maxTokens, 4096);
  });
});

test('界面选了 v4-pro 且写了 8000 → 引擎就用 v4-pro / 8000', () => {
  withDataDir({ deepseekModel: 'deepseek-v4-pro', deepseekMaxTokens: 8000 }, () => {
    const cfg = getDeepSeekConfig();
    assert.equal(cfg.model, 'deepseek-v4-pro');
    assert.equal(cfg.maxTokens, 8000);
  });
});

test('只选模型不写上限 → 模型生效、上限仍是默认（推理模型会 warnOnce 提醒）', () => {
  withDataDir({ deepseekModel: 'deepseek-flash' }, () => {
    const cfg = getDeepSeekConfig();
    assert.equal(cfg.model, 'deepseek-flash');
    assert.equal(cfg.maxTokens, 4096);
  });
});

test('非法上限（0 / 太小 / 非数字）被忽略，不会把配置改成 0', () => {
  for (const bad of [0, 12, 'abc', null]) {
    withDataDir({ deepseekModel: '', deepseekMaxTokens: bad }, () => {
      assert.equal(getDeepSeekConfig().maxTokens, 4096, `bad=${JSON.stringify(bad)}`);
    });
  }
});

test('坏掉的 user.json 不炸，回退默认', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xnowpost-cfg-'));
  const old = process.env.XNOWPOST_DATA_DIR;
  try {
    fs.ensureDirSync(path.join(dir, 'config'));
    fs.writeFileSync(path.join(dir, 'config', 'user.json'), '{ 这不是 JSON');
    process.env.XNOWPOST_DATA_DIR = dir;
    const cfg = getDeepSeekConfig();
    assert.equal(cfg.model, 'deepseek-chat');
    assert.equal(cfg.maxTokens, 4096);
  } finally {
    if (old === undefined) delete process.env.XNOWPOST_DATA_DIR;
    else process.env.XNOWPOST_DATA_DIR = old;
    fs.removeSync(dir);
  }
});

test('推理模型的上限常量与「选它就该给够」一致', () => {
  withDataDir({ deepseekModel: 'deepseek-v4-pro', deepseekMaxTokens: REASONING_MIN_MAX_TOKENS }, () => {
    assert.equal(getDeepSeekConfig().maxTokens, REASONING_MIN_MAX_TOKENS);
  });
});
