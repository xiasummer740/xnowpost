// 「程序自己开的浏览器」要不要最小化？
//
// 2026-10-23 真机 A/B 实测（TK01）：
//   - 最小化后视频**照样在播**（currentTime 一路前进，document.hidden=false）；
//   - 但**鼠标点击失效**：同样点「下一页」，可见时换片 ✅，最小化后不换 ❌。
//     （FoxProfile 的点击是真机鼠标事件，窗口不可见就点不动）
// 所以：
//   - 只读任务（拉资料、采集读页面）→ 可以最小化，免得开 10 个窗口挡屏幕；
//   - 要点击的任务（养号点赞/翻页、发布上传）→ **绝对不能最小化**，否则什么都点不动。
//
// 用法： minimizeEnvWindow('TK04')  →  true 表示已最小化
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 开发：<repo>/src/collector → ../../scripts；打包：app.asar.unpacked/src/collector → ../../scripts
const SCRIPT = path.resolve(HERE, '..', '..', 'scripts', 'minimize-env.ps1');

export function minimizeEnvWindow(env) {
  const name = String(env || '').trim();
  if (!name) return false;
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Env', name],
      { encoding: 'utf8', timeout: 15000, windowsHide: true },
    );
    return /minimized \d+/.test(String(out || '')) && !/minimized 0/.test(String(out || ''));
  } catch {
    // 最小化失败绝不能影响任务本身
    return false;
  }
}
