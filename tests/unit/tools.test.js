/**
 * 外部工具解析的真实单元测试（直接 import src/engine/tools.js）
 *
 * 注意：这里不假设机器上装了 FFmpeg / edge-tts ——
 * 这两个工具是可选环境依赖，测试只验证「解析逻辑的契约」：
 *   - 永远返回非空字符串（找不到时返回裸命令名，交给 verifyMediaTools 报错）
 *   - 返回绝对路径时，该文件必须真的存在
 *   - ffprobe 与 ffmpeg 同目录（这是 P0-2 修的「正则推导」缺陷的回归测试）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'fs-extra';

import {
  findFFmpeg,
  findFFprobe,
  findEdgeTTS,
  verifyTool,
  verifyMediaTools,
} from '../../src/engine/tools.js';

describe('findFFmpeg / findFFprobe / findEdgeTTS', () => {
  test('三者都返回非空字符串', () => {
    for (const [name, fn] of [['findFFmpeg', findFFmpeg], ['findFFprobe', findFFprobe], ['findEdgeTTS', findEdgeTTS]]) {
      const r = fn();
      assert.equal(typeof r, 'string', `${name} 应返回字符串`);
      assert.ok(r.length > 0, `${name} 不应返回空串`);
    }
  });

  test('返回绝对路径时该文件必须真实存在（不能凭空编路径）', () => {
    for (const [name, fn] of [['findFFmpeg', findFFmpeg], ['findFFprobe', findFFprobe], ['findEdgeTTS', findEdgeTTS]]) {
      const r = fn();
      if (path.isAbsolute(r)) {
        assert.ok(fs.existsSync(r), `${name} 返回了不存在的路径: ${r}`);
      }
    }
  });

  test('ffprobe 应与 ffmpeg 同目录（回归：原先用正则从 ffmpeg 路径推导，回退时静默失效）', () => {
    const ff = findFFmpeg();
    const fp = findFFprobe();
    if (path.isAbsolute(ff) && path.isAbsolute(fp)) {
      assert.equal(
        path.dirname(path.resolve(fp)).toLowerCase(),
        path.dirname(path.resolve(ff)).toLowerCase(),
        `ffprobe 与 ffmpeg 不在同一目录:\n  ffmpeg=${ff}\n  ffprobe=${fp}`
      );
    }
  });

  test('findFFprobe 不会返回把 ffmpeg 简单替换后的假路径', () => {
    const fp = findFFprobe();
    if (path.isAbsolute(fp)) {
      assert.ok(fs.existsSync(fp));
      assert.ok(/ffprobe/i.test(path.basename(fp)), `意外文件名: ${fp}`);
    }
  });

  test('多次调用结果稳定（不依赖随机/时序）', () => {
    assert.equal(findFFmpeg(), findFFmpeg());
    assert.equal(findFFprobe(), findFFprobe());
  });
});

describe('verifyTool', () => {
  test('对不存在的可执行文件返回 ok:false 并带 error，不抛异常', () => {
    const r = verifyTool('definitely-not-a-real-binary-xyz-123');
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0);
  });

  test('对真实存在的解释器返回 ok:true 并给出 version 首行', () => {
    // 当前进程可执行文件必然存在且支持 --version
    const r = verifyTool(process.execPath, '--version');
    assert.equal(r.ok, true, `verifyTool 失败: ${r.error}`);
    assert.ok(/v\d+\./.test(r.version), `version 首行异常: ${r.version}`);
  });
});

describe('verifyMediaTools', () => {
  test('返回 ffmpeg / ffprobe / edgeTts 三项，每项含 path 与 ok', () => {
    const t = verifyMediaTools();
    for (const key of ['ffmpeg', 'ffprobe', 'edgeTts']) {
      assert.ok(t[key], `缺少 ${key}`);
      assert.equal(typeof t[key].path, 'string', `${key}.path 应为字符串`);
      assert.equal(typeof t[key].ok, 'boolean', `${key}.ok 应为布尔`);
      if (t[key].ok) {
        assert.ok(fs.existsSync(t[key].path), `${key} 报告可用但路径不存在: ${t[key].path}`);
        assert.equal(typeof t[key].version, 'string');
      } else {
        assert.equal(typeof t[key].error, 'string');
      }
    }
  });

  test('三项结果与单项查找函数一致', () => {
    const t = verifyMediaTools();
    assert.equal(t.ffmpeg.path, findFFmpeg());
    assert.equal(t.ffprobe.path, findFFprobe());
    assert.equal(t.edgeTts.path, findEdgeTTS());
  });
});
