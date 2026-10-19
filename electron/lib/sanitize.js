/**
 * 主进程纯逻辑工具
 *
 * 为什么单独一个文件：`electron/main.js` 是入口文件，一被 require/import 就会
 * 去加载 electron 并注册生命周期钩子，**无法在 node --test 里导入**。
 * 把这些纯函数抽出来后就能真正被单元测试覆盖（原先 68 个测试零覆盖生产代码）。
 */
import path from 'path';
import fs from 'fs-extra';
// id 发号/自愈的唯一实现（界面、主进程、迁移脚本共用；单测 tests/unit/job-ids.test.js）
import { reconcileJobIds } from '../../src/job-ids.js';

// === 密钥掩码 ===

/** 需要掩码处理的配置字段 */
export const SECRET_FIELDS = [
  'deepseekApiKey',
  'siliconflowApiKey',
  'pexelsApiKey',
  'tgBotToken',
  'bitApiKey',
];

/** 保留前 6 位 + 后 4 位，中间用 * 填充（长度保持不变，便于用户核对是哪一把） */
export function maskSecret(value) {
  if (!value || typeof value !== 'string') return '';
  if (value.length <= 10) return '*'.repeat(value.length);
  return value.slice(0, 6) + '*'.repeat(value.length - 10) + value.slice(-4);
}

/** 判断是不是掩码（真实 Key 绝不会含连续两个 *） */
export function isMaskedValue(v) {
  return typeof v === 'string' && /\*{2,}/.test(v);
}

/**
 * 把渲染进程传来的 session 目录收敛到 `<baseOutputDir>/<date>/<session>`。
 * 返回合法绝对路径，或 null。
 *
 * 原实现直接对**任意绝对路径**做 fs 操作 —— 渲染进程被注入后即可读盘上任意文件。
 */
export function resolveSessionDir(raw, baseOutputDir) {
  if (typeof raw !== 'string' || !raw) return null;
  if (typeof baseOutputDir !== 'string' || !baseOutputDir) return null;

  const base = path.resolve(baseOutputDir);
  const resolved = path.resolve(raw);
  const rel = path.relative(base, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;

  const parts = rel.split(path.sep);
  if (parts.length !== 2) return null;                     // 必须正好是 <date>/<session>
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parts[0])) return null;
  if (!/^[A-Za-z0-9_.\-]+$/.test(parts[1])) return null;    // 目录名不含路径分隔符
  try {
    if (!fs.statSync(resolved).isDirectory()) return null;
  } catch (_) {
    return null;
  }
  return resolved;
}

/**
 * 自定义数据目录的合法性校验。
 * `config:save` 允许渲染进程传任意字符串，而启动时只要 `<dataDir>/config/user.json`
 * 存在就会切换 DATA_DIR —— 等于渲染进程能把之后所有数据 I/O 重定向到任意位置。
 */
export function isValidDataDir(dir, root) {
  if (dir === undefined || dir === null || dir === '') return true;  // 空 = 用默认目录
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
  const resolved = path.resolve(dir);
  // 安装目录会随自动升级被覆盖，绝不能作为数据目录
  if (root && (resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep))) {
    return false;
  }
  return true;
}

/** 按扩展名给出正确的 MIME（原来硬编码 png，jpg 会被浏览器按 png 解析而显示失败） */
export function mimeForImage(file) {
  const ext = path.extname(String(file)).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

/** 带体积上限的文本读取：日志可能涨到几十 MB，直接 readFileSync 会吃满内存。超限时只取尾部。 */
export function readTextCapped(file, maxBytes = 5 * 1024 * 1024) {
  const stat = fs.statSync(file);
  if (stat.size <= maxBytes) return fs.readFileSync(file, 'utf-8');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
    return buf.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 定时任务 id 自愈（主进程侧的护栏，`schedule:list` / `schedule:save` 都会过一遍）。
 *
 * 实现只有一份：`src/job-ids.js` 的 `reconcileJobIds()`（界面、主进程、迁移脚本共用）。
 * 这里只负责两件主进程特有的事：
 *   ① 纯函数 —— 先浅拷贝再交给它（它会原地改 id，不能让调用方的对象被改）；
 *   ② 返回 `{jobs, changed}`，`changed` 用改前改后的 id 字符串比对得出。
 *
 * 口径（和 job-ids 一致）：合法 id（1~999 的正整数）**永远保留**，重复/非法/越界
 * （历史上用过 `Date.now()`，留下 1783852240727 这类 13 位数字）才重新发号。
 * 所以老配置第一次被这个函数碰到时，13 位 id 会自动变成小序号 —— 那是刻意的自愈。
 */
export function dedupeJobIds(jobs) {
  if (!Array.isArray(jobs)) return { jobs, changed: false };
  const out = jobs.map((j) => (j && typeof j === 'object' ? { ...j } : j));
  const before = jobs.map((j) => (j && typeof j === 'object' ? String(j.id) : ''));
  reconcileJobIds(out);
  let changed = false;
  for (let i = 0; i < out.length; i += 1) {
    const j = out[i];
    if (j && typeof j === 'object' && String(j.id) !== before[i]) {
      changed = true;
      break;
    }
  }
  return { jobs: out, changed };
}
