import fs from 'fs-extra';
import path from 'path';

const OUTPUT_ROOT = path.resolve('output');

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

// 每次生成放在时段子文件夹，避免混淆
export function getSessionDir() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const label = now.getHours() < 12 ? 'am' : 'pm';
  return path.join(OUTPUT_ROOT, todayStr(), `${label}_${hh}${mm}`);
}

export async function createItemDir(titleEn, index) {
  const dirName = String(index).padStart(2, '0');
  const dirPath = path.join(getTodayDir(), dirName);
  await fs.ensureDir(dirPath);
  return dirPath;
}

export async function saveContentMarkdown(dirPath, content, type) {
  const { title_zh, title_en, strategy } = content;

  const mdBody = type === 'video'
    ? content.scenes.map((s, i) => `### 分镜 ${i + 1}\n${s.scene_text_zh}`).join('\n\n')
    : content.body_zh || '';

  const mdBodyEn = type === 'video'
    ? content.scenes.map((s, i) => `### Scene ${i + 1}\n${s.scene_text_en}`).join('\n\n')
    : content.body_en || '';

  const md = [
    `# ${title_zh}`,
    `# ${title_en}`,
    ``,
    `- 类型: ${type === 'video' ? '视频' : '图文'}`,
    `- 策略: ${strategy.label}`,
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

  await fs.writeFile(path.join(dirPath, 'content.md'), md, 'utf-8');
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

  await fs.writeFile(
    path.join(dirPath, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
    'utf-8'
  );
}

export async function updateIndex(item) {
  const todayDir = getTodayDir();
  const indexPath = path.join(todayDir, 'index.json');

  let index = [];
  if (await fs.pathExists(indexPath)) {
    index = await fs.readJson(indexPath);
  }

  index.push(item);

  await fs.writeJson(indexPath, index, { spaces: 2 });
}

export { todayStr, slugify };
