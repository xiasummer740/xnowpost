/**
 * 结束整个进程树（Windows 上是 `taskkill /PID n /T /F`）。
 *
 * 为什么需要（2026-10-29 审查发现）：
 * `spawnSync({ timeout })` 超时只杀**直接子进程**（node src/index.js），而它自己拉起来的
 * 浏览器（camoufox）、ffmpeg、以及发布器 `finally { closeFoxProfile }` 里的收尾逻辑
 * 全都没机会跑 —— 结果就是：窗口留在桌面上、`cookies.sqlite` 被占着，
 * 下一轮启动就撞 "Browser is still starting" 或 launch 被挤掉，
 * 产物还停在半成品状态（没有 FAILED、没有 .published，看起来像"什么都没发生"）。
 *
 * 主进程早就有等价实现（electron/main.js 的 killProcessTree），调度器这边以前是空白。
 * 纯参数拼装与判定都做成可测函数，单测在 tests/unit/process-tree.test.js。
 */
import { spawn } from 'node:child_process';

/** taskkill 的参数（纯函数，便于单测） */
export function taskkillArgs(pid) {
  return ['/PID', String(pid), '/T', '/F'];
}

/** pid 是否"看起来可以杀"（0/负数/非整数一律拒绝，避免误杀整组进程） */
export function isValidPid(pid) {
  const n = Number(pid);
  return Number.isInteger(n) && n > 0;
}

/**
 * 杀掉 pid 及其所有子孙进程。
 * @returns {Promise<{ok:boolean, how:string, code?:number|null, stderr?:string}>}
 */
export function killTree(pid, opts = {}) {
  const { platform = process.platform, spawnImpl = spawn, onLog } = opts;
  if (!isValidPid(pid)) return Promise.resolve({ ok: false, how: 'invalid-pid' });

  if (platform !== 'win32') {
    // POSIX：子进程是以 detached 方式启动的才杀得了整组；拿不到就退回单进程
    try {
      process.kill(-Number(pid), 'SIGKILL');
      return Promise.resolve({ ok: true, how: 'process-group' });
    } catch (_) {
      try { process.kill(Number(pid), 'SIGKILL'); return Promise.resolve({ ok: true, how: 'process' }); }
      catch (e) { return Promise.resolve({ ok: false, how: 'kill-failed', stderr: e.message }); }
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawnImpl('taskkill', taskkillArgs(pid), {
        windowsHide: true,   // CLAUDE.md 硬规则：绝不允许 CMD 弹窗
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      if (typeof onLog === 'function') onLog(`⚠️ 结束进程树失败（taskkill 起不来）: ${e.message}`);
      return done({ ok: false, how: 'spawn-failed', stderr: e.message });
    }
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', () => done({ ok: false, how: 'spawn-error', stderr }));
    child.on('close', (code) => {
      // taskkill 的退出码：0 成功；128 进程已不在（对我们来说也算结束）
      const ok = code === 0 || code === 128;
      if (!ok && typeof onLog === 'function') {
        onLog(`⚠️ 结束进程树 PID ${pid} 失败（taskkill 退出码 ${code}）${stderr ? `: ${stderr.trim().slice(0, 120)}` : ''}`);
      }
      done({ ok, how: 'taskkill', code, stderr });
    });
    // 保险：taskkill 自己卡住时不拖住调度器
    const guard = setTimeout(() => done({ ok: false, how: 'taskkill-timeout' }), 15000);
    if (typeof guard.unref === 'function') guard.unref();
  });
}
