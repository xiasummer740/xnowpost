/**
 * 发布器入口
 * 遍历产出目录，把未发布的视频/图文发布到各平台
 */
import path from 'path';
import fs from 'fs-extra';
import { publishToTikTok } from './tiktok.js';

const DATA_DIR = process.env.XNOWPOST_DATA_DIR || path.resolve('.');
const OUTPUT_DIR = path.join(DATA_DIR, 'output');

/**
 * 查找未发布的产出
 * 返回所有没有 .published 标记的 session 目录
 */
export function findUnpublished() {
  const unpublished = [];

  // 强制刷新路径
  const cwd = process.cwd();
  console.log(`  [PUB] DATA_DIR=${DATA_DIR} cwd=${cwd} OUTPUT_DIR=${OUTPUT_DIR}`);
  console.log(`  [PUB] exists=${fs.existsSync(OUTPUT_DIR)}`);

  if (!fs.existsSync(OUTPUT_DIR)) {
    console.log(`  ⚠️ 目录不存在: ${OUTPUT_DIR}`);
    return unpublished;
  }

  const dateDirs = fs.readdirSync(OUTPUT_DIR)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();
  console.log(`  📅 找到 ${dateDirs.length} 个日期目录`);

  for (const dateDir of dateDirs) {
    const datePath = path.join(OUTPUT_DIR, dateDir);
    const sessions = fs.readdirSync(datePath)
      .filter(s => fs.statSync(path.join(datePath, s)).isDirectory())
      .sort()
      .reverse();

    for (const session of sessions) {
      const sessionPath = path.join(datePath, session);
      const publishedFile = path.join(sessionPath, '.published');

      if (fs.existsSync(publishedFile)) { console.log(`  ⏭️ ${session} 已发布`); continue; }

      const files = fs.readdirSync(sessionPath);
      const hasVideo = files.some(f => f.endsWith('.mp4'));
      const hasImages = files.some(f => /\.(png|jpg|jpeg)$/i.test(f) && f !== '封面.png');
      const txtFile = files.find(f => f === '文案.txt');
      console.log(`  🔍 ${session}: video=${hasVideo} img=${hasImages} txt=${!!txtFile} files=[${files.join(',')}]`);

      if ((hasVideo || hasImages) && txtFile) {
        const txt = fs.readFileSync(path.join(sessionPath, txtFile), 'utf-8');
        const firstLine = txt.split('\n')[0] || '';

        unpublished.push({
          date: dateDir,
          session,
          path: sessionPath,
          title: firstLine.substring(0, 80),
          hasVideo,
          hasImages,
          txtFile: path.join(sessionPath, txtFile),
          videoFile: hasVideo ? files.find(f => f.endsWith('.mp4')) : null,
          imageFiles: hasImages
            ? files.filter(f => /\.(png|jpg|jpeg)$/i.test(f) && f !== '封面.png')
            : [],
        });
      }
    }
  }

  return unpublished;
}

/**
 * 标记已发布
 */
function markPublished(sessionPath, platform, url = '') {
  const data = {
    publishedAt: new Date().toISOString(),
    platform,
    url,
  };
  fs.writeJsonSync(path.join(sessionPath, '.published'), data, { spaces: 2 });
}

/**
 * 发布所有未发布的内容
 * @param {object} options
 * @param {string} [options.envId] - 比特环境 ID（不传则跳过浏览器操作）
 * @param {string} [options.apiKey] - 比特 API 密钥
 * @param {string} [options.platform] - 指定平台（默认全部）
 * @param {number} [options.maxCount] - 最多发布几个（默认全部）
 */
export async function publishAll(options = {}) {
  const { envId, apiKey, platform = 'tiktok', maxCount } = options;
  const items = findUnpublished();

  if (items.length === 0) {
    console.log('📭 没有未发布的内容');
    return { published: 0, total: 0 };
  }

  console.log(`📦 找到 ${items.length} 个未发布内容`);
  const toPublish = maxCount ? items.slice(0, maxCount) : items;
  let published = 0;

  for (const item of toPublish) {
    console.log(`\n📤 发布: ${item.date}/${item.session}`);
    console.log(`   ${item.title}`);

    try {
      if (platform === 'tiktok') {
        if (!envId) {
          console.log('  ⚠️ 未配置比特环境 ID，跳过浏览器发布');
          continue;
        }
        const url = await publishToTikTok({
          sessionPath: item.path,
          videoFile: item.videoFile ? path.join(item.path, item.videoFile) : null,
          imageFiles: item.imageFiles.map(f => path.join(item.path, f)),
          titleFile: item.txtFile,
          envId,
          apiKey,
        });
        markPublished(item.path, 'tiktok', url);
        console.log(`  ✅ 发布成功: ${url || '(链接未知)'}`);
      } else {
        console.log(`  ⚠️ 不支持的平台: ${platform}`);
        continue;
      }

      published++;
    } catch (err) {
      console.error(`  ❌ 发布失败: ${err.message}`);
      // 继续发布下一个，不中断
    }
  }

  console.log(`\n📊 发布完成: ${published}/${toPublish.length}`);
  return { published, total: items.length };
}

// 直接运行时
const isMain = process.argv[1] && (
  process.argv[1].includes('publisher') ||
  process.argv[1].includes('publish')
);

if (isMain) {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env') options.envId = args[++i];
    else if (args[i] === '--platform') options.platform = args[++i];
    else if (args[i] === '--max') options.maxCount = parseInt(args[++i]);
    else if (args[i] === '--all') { /* 默认发布全部 */ }
  }

  // 从 config 读取比特环境 ID
  const configPath = path.resolve('config/user.json');
  if (!options.envId && fs.existsSync(configPath)) {
    try {
      const cfg = fs.readJsonSync(configPath);
      options.envId = cfg.accounts?.[0]?.bitEnvId;
      options.apiKey = cfg.bitApiKey || '';
    } catch (_) {}
  }

  publishAll(options).then(r => {
    console.log(`\n✅ 发布器完成 (${r.published}/${r.total})`);
    process.exit(0);
  }).catch(err => {
    console.error('\n❌ 发布器失败:', err);
    process.exit(1);
  });
}
