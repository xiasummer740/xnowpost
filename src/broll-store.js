/**
 * 素材库存储层（2026-10-20 v1.6.52）。
 *
 * 只负责「库在哪、怎么读写、用了几次、哪句话没搜到」，
 * 不做搜索/下载/闸门判定 —— 那些在 `broll-auto.js`，
 * 挑片在 `engine/material.js`。这样三个模块是单向依赖，不会循环引用。
 *
 * 位置策略：**库放在数据目录**（%APPDATA%\xnowpost\assets\broll-library），
 * 因为自动补库会往里写文件，而安装目录/asar 是只读的，升级还会被覆盖。
 * 首版把 14 段放在代码目录 assets/ 下，首次运行时自动搬到数据目录（之后只认数据目录）。
 */
import fs from 'fs-extra';
import path from 'path';
import { dataPath } from './paths.js';
import { fileURLToPath } from 'url';

// ⚠️ 用模块相对路径，不能用 process.cwd()：
// 打包版的 cwd 是安装目录，而 assets 实际在 app.asar.unpacked/assets 下，
// 用 cwd 会找不到那 14 段人挑素材 → 安装版显示"库里 0 段"（2026-10-20 差点踩到）。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODE_DIR = path.join(__dirname, '..', 'assets', 'broll-library');

/** 库目录（必要时把旧位置的那份搬过来） */
export function ensureLibraryDir() {
  const dir = path.join(dataPath('assets'), 'broll-library');
  const indexFile = path.join(dir, 'library.json');
  if (!fs.existsSync(indexFile)) {
    // 旧位置有就搬（只搬一次；搬完旧目录保留，出问题还能回退）
    if (fs.existsSync(path.join(CODE_DIR, 'library.json'))) {
      try {
        fs.copySync(CODE_DIR, dir, { overwrite: false, errorOnExist: false });
      } catch (_) { /* 搬不动就用空库，不影响出片 */ }
    } else {
      fs.ensureDirSync(dir);
    }
  }
  return dir;
}

export function libraryPath() {
  const dir = ensureLibraryDir();
  return { dir, file: path.join(dir, 'library.json') };
}

/** 读片段列表（坏文件/不存在都返回 []，绝不抛） */
export function loadClips() {
  try {
    const { file } = libraryPath();
    if (!fs.existsSync(file)) return [];
    const j = fs.readJsonSync(file);
    return Array.isArray(j?.clips) ? j.clips : [];
  } catch (_) {
    return [];
  }
}

export function saveClips(clips) {
  const { file } = libraryPath();
  fs.ensureDirSync(path.dirname(file));
  fs.writeJsonSync(file, { version: 1, updatedAt: new Date().toISOString(), clips }, { spaces: 2 });
}

/**
 * 标记一次使用（给淘汰策略用：长期没人用的自动素材先删）。
 * 写失败绝不影响出片。
 */
export function markLibraryUse(file) {
  try {
    const clips = loadClips();
    const hit = clips.find((c) => c.file === file);
    if (!hit) return;
    hit.used = (hit.used || 0) + 1;
    hit.lastUsedAt = new Date().toISOString();
    saveClips(clips);
  } catch (_) { /* 忽略 */ }
}

/** 记一次「这个关键词没找到素材」，供自动补库优先处理 */
export function recordMiss(keywords) {
  try {
    const file = dataPath('data', 'broll-misses.jsonl');
    fs.ensureDirSync(path.dirname(file));
    fs.appendFileSync(
      file,
      JSON.stringify({ at: new Date().toISOString(), keywords: String(keywords || '') }) + '\n',
      'utf-8',
    );
  } catch (_) { /* 忽略 */ }
}

/** 读未命中统计（按次数降序） */
export function readMisses(limit = 300) {
  try {
    const file = dataPath('data', 'broll-misses.jsonl');
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    const counts = new Map();
    for (const line of lines.slice(-limit)) {
      try {
        const kw = String(JSON.parse(line).keywords || '').trim();
        if (kw) counts.set(kw, (counts.get(kw) || 0) + 1);
      } catch (_) { /* 坏行跳过 */ }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([keywords, count]) => ({ keywords, count }));
  } catch (_) {
    return [];
  }
}

/** 今天是否已经自动补过库 */
export function grownToday() {
  try {
    const j = fs.readJsonSync(dataPath('data', 'broll-auto-stamp.json'));
    return j.date === new Date().toLocaleDateString('sv-SE');
  } catch (_) {
    return false;
  }
}

export function markGrownToday(info = {}) {
  try {
    const file = dataPath('data', 'broll-auto-stamp.json');
    fs.ensureDirSync(path.dirname(file));
    fs.writeJsonSync(file, { date: new Date().toLocaleDateString('sv-SE'), ...info }, { spaces: 2 });
  } catch (_) { /* 忽略 */ }
}
