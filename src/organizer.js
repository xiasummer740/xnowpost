import fs from 'fs-extra';
import path from 'path';
import { dataPath } from './paths.js';
import { writeFileAtomic, writeJsonAtomic } from './fs-atomic.js';

// 输出根目录：走 paths.js 这个唯一入口（安装版 = %APPDATA%/xnowpost/output）
// 不要再自己读 XNOWPOST_DATA_DIR 或 path.resolve('.')，否则安装版会读写到安装目录。
const OUTPUT_ROOT = dataPath('output');

/**
 * 本地日期字符串 YYYY-MM-DD
 *
 * 坑：`new Date().toISOString()` 是 **UTC**。北京时间 00:00–08:00 会被算成"昨天"，
 * 造成"会话目录按本地日期、采集按 UTC 日期"的错位（查询昨天时查错天）。
 * 全项目的日期一律走这里（采集、分析、调度日志文件名）。
 */
export function formatLocalDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function todayStr() {
  return formatLocalDate(new Date());
}

/** 在 YYYY-MM-DD 上按本地日历做天数偏移（纯字符串进出，不经过 UTC） */
export function localDateOffset(dateStr, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + Number(days || 0));
  return formatLocalDate(d);
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

export function getTodayDir() {
  return path.join(OUTPUT_ROOT, todayStr());
}

/**
 * 每次生成放在时段子文件夹，避免混淆。
 *
 * 目录名形如 `pm_1430`：
 *   - electron/main.js 用 `/(\d{2})(\d{2})$/` 从目录名里取时间，并按字典序取"最新"，
 *     所以 **必须保持以 HHMM 结尾**（不能把秒/随机串追加在末尾，否则时间显示为空、排序变乱）；
 *   - 同一分钟内的第二次运行改为 `pm_1430-2`、`-3` 后缀，不再互相覆盖
 *     （原先只精确到分钟，同分钟两次运行会共用一个目录，产物互相覆盖）；
 *   - 同进程内已发出的名字记在 handedOut 里，连续调用不会拿到同一个目录。
 * 残留竞态：两个**进程**在同一分钟同时启动时仍可能选中同一个新名字（未做跨进程加锁），
 * 但调用方（src/index.js）拿到名字后立即 ensureDir，实际撞车窗口极小。
 */
const handedOut = new Set();

export function getSessionDir() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const label = now.getHours() < 12 ? 'am' : 'pm';
  const base = path.join(OUTPUT_ROOT, todayStr(), `${label}_${hh}${mm}`);

  for (let n = 1; n <= 99; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (handedOut.has(candidate) || fs.existsSync(candidate)) continue;
    handedOut.add(candidate);
    return candidate;
  }

  const fallback = `${base}-${Date.now()}`;
  handedOut.add(fallback);
  return fallback;
}

export async function createItemDir(titleEn, index) {
  const dirName = String(index).padStart(2, '0');
  const dirPath = path.join(getTodayDir(), dirName);
  await fs.ensureDir(dirPath);
  return dirPath;
}

export async function saveContentMarkdown(dirPath, content, type) {
  const { title_zh, title_en, strategy, scenes } = content;
  const sceneList = Array.isArray(scenes) ? scenes : [];

  const mdBody = type === 'video'
    ? sceneList.map((s, i) => `### 分镜 ${i + 1}\n${s.scene_text_zh || ''}`).join('\n\n')
    : content.body_zh || '';

  const mdBodyEn = type === 'video'
    ? sceneList.map((s, i) => `### Scene ${i + 1}\n${s.scene_text_en || ''}`).join('\n\n')
    : content.body_en || '';

  const md = [
    `# ${title_zh || ''}`,
    `# ${title_en || ''}`,
    ``,
    `- 类型: ${type === 'video' ? '视频' : '图文'}`,
    `- 策略: ${strategy?.label || '未知'}`,
    `- 生成时间: ${new Date().toISOString()}`,
    ``,
    `---`,
    ``,
    `## 中文`,
    mdBody,
    ``,
    `---`,
    ``,
    `## English`,
    mdBodyEn,
    ``,
    `## 标签`,
    [...(content.tags_zh || []), ...(content.tags_en || [])].map(t => `#${t}`).join(' '),
  ].join('\n');

  // 原子写：中断时不会留下半截 content.md
  await writeFileAtomic(path.join(dirPath, 'content.md'), md, 'utf-8');
}

export async function saveMetadata(dirPath, content, type) {
  const metadata = {
    generated_at: new Date().toISOString(),
    type,
    title_zh: content.title_zh,
    title_en: content.title_en,
    strategy: content.strategy,
    tags_zh: content.tags_zh || [],
    tags_en: content.tags_en || [],
    status: 'pending',
  };

  await writeJsonAtomic(path.join(dirPath, 'metadata.json'), metadata, 2);
}

export async function updateIndex(item) {
  const todayDir = getTodayDir();
  const indexPath = path.join(todayDir, 'index.json');

  let index = [];
  if (await fs.pathExists(indexPath)) {
    try {
      index = await fs.readJson(indexPath);
    } catch (e) {
      console.warn(`  ⚠️ index.json 解析失败，从空索引继续: ${e.message}`);
      index = [];
    }
    if (!Array.isArray(index)) index = [];
  }

  index.push(item);

  await writeJsonAtomic(indexPath, index, 2);
}

export { slugify };
