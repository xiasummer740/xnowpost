/**
 * 统一数据目录解析 —— 全项目唯一入口
 *
 * 约定：
 *   - 打包版：主进程通过 XNOWPOST_DATA_DIR 注入 %APPDATA%/xnowpost
 *   - 开发版：回退到项目根目录
 *
 * v1.1.4 修 collector 时只改了部分模块，导致安装版读写位置分叉
 * （dedup 的历史、trends 的库、scheduler 的 TG 配置都指到了安装目录）。
 * 这里收敛为单一实现，新代码一律用它，不要再自己拼 `path.resolve('.')`。
 */
import path from 'path';

/** 当前生效的数据目录（**保证是绝对路径**） */
export function resolveDataDir() {
  const dir = process.env.XNOWPOST_DATA_DIR;
  // 统一转成绝对路径：相对值在不同模块里解释可能不同（有的直接用、有的再 join），
  // 这正是 P1-3 路径分叉的成因之一。
  return dir ? path.resolve(dir) : path.resolve('.');
}

/** 数据目录下的路径拼接 */
export function dataPath(...segments) {
  return path.join(resolveDataDir(), ...segments);
}

/**
 * 引擎子进程的 cwd。
 *
 * 注意：数据目录 ≠ 代码目录。打包版代码在 app.asar.unpacked，
 * 数据在 %APPDATA%，因此子进程 cwd 固定为代码根目录，
 * 数据位置只通过 XNOWPOST_DATA_DIR 传递。
 */
export function resolveCodeRoot() {
  return path.resolve('.');
}
