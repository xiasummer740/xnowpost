/**
 * 超时必须连进程树一起结束（2026-10-29 审查发现：spawnSync 只杀直接子进程，
 * 浏览器/ffmpeg 留在后台占着 cookies.sqlite，下一轮就撞 "Browser is still starting"）。
 * 这里只测纯逻辑（参数拼装 / pid 校验 / taskkill 分支），不真的去杀进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { taskkillArgs, isValidPid, killTree } from '../../src/process-tree.js';

/** 假的 spawn：立刻 close，可指定退出码 */
function fakeSpawn(code = 0, stderrText = '') {
  return (cmd, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killedCmd = { cmd, args };
    setImmediate(() => {
      if (stderrText) child.stderr.emit('data', Buffer.from(stderrText));
      child.emit('close', code);
    });
    return child;
  };
}

test('taskkillArgs 用 /T /F 结束整棵树', () => {
  assert.deepEqual(taskkillArgs(4321), ['/PID', '4321', '/T', '/F']);
});

test('pid 校验：0 和负数不算合法进程', () => {
  assert.equal(isValidPid(4321), true);
  assert.equal(isValidPid('4321'), true);
  assert.equal(isValidPid(0), false, '0 在 Windows 上是"所有进程"，绝不能传');
  assert.equal(isValidPid(-1), false);
  assert.equal(isValidPid('abc'), false);
  assert.equal(isValidPid(null), false);
});

test('Windows 上走 taskkill，命令行是 /PID n /T /F', async () => {
  let capture = null;
  const spawnImpl = (cmd, args) => { capture = { cmd, args }; return fakeSpawn(0)(cmd, args); };
  const r = await killTree(4321, { platform: 'win32', spawnImpl });
  assert.equal(r.ok, true);
  assert.equal(capture.cmd, 'taskkill');
  assert.deepEqual(capture.args, ['/PID', '4321', '/T', '/F']);
});

test('taskkill 退出码 128（进程已不在）也算结束', async () => {
  const r = await killTree(4321, { platform: 'win32', spawnImpl: fakeSpawn(128) });
  assert.equal(r.ok, true, '128 = 该进程已经不在，对我们来说目的已达成');
});

test('taskkill 失败时不抛异常，只回报 + 日志（不能把调度器带崩）', async () => {
  const logs = [];
  const r = await killTree(4321, { platform: 'win32', spawnImpl: fakeSpawn(5, '拒绝访问'), onLog: (m) => logs.push(m) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 5);
  assert.match(logs.join('\n'), /结束进程树 PID 4321 失败/);
});

test('非法 pid 直接返回，绝不调用 taskkill', async () => {
  let called = false;
  const r = await killTree(0, { platform: 'win32', spawnImpl: () => { called = true; } });
  assert.equal(r.ok, false);
  assert.equal(r.how, 'invalid-pid');
  assert.equal(called, false);
});

test('POSIX 上杀进程组', async () => {
  const calls = [];
  const original = process.kill;
  process.kill = (pid, sig) => { calls.push([pid, sig]); };
  try {
    const r = await killTree(4321, { platform: 'linux' });
    assert.equal(r.ok, true);
    assert.deepEqual(calls, [[-4321, 'SIGKILL']]);
  } finally {
    process.kill = original;
  }
});
