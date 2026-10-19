/**
 * 发布器入口
 * 遍历产出目录，把未发布的视频/图文发布到各平台
 */
import path from 'path';
import fs from 'fs-extra';
import { publishToTikTok } from './tiktok.js';
import { envBudgetMs } from './waits.js';
import { resolveDataDir } from '../paths.js';
import { writeJsonAtomicSync } from '../fs-atomic.js';
import { closeFoxProfile } from '../collector/foxprofile.js';

// 数据目录统一走 paths.js（打包版 = %APPDATA%/xnowpost）
// —— 不要再自己拼 path.resolve('.')，否则安装版会读写安装目录
function outputDir() {
  return path.join(resolveDataDir(), 'output');
}

/**
 * 查找未发布的产出
 * 返回所有没有 .published 标记的 session 目录
 */
export function findUnpublished() {
  const unpublished = [];
  const OUTPUT_DIR = outputDir();

  // 强制刷新路径
  const cwd = process.cwd();
  console.log(`  [PUB] DATA_DIR=${resolveDataDir()} cwd=${cwd} OUTPUT_DIR=${OUTPUT_DIR}`);
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
 * 标记已发布（原子写，避免半截 JSON 让下一轮误判为未发布 → 重复上传）
 */
function markPublished(sessionPath, platform, url = '') {
  const data = {
    publishedAt: new Date().toISOString(),
    platform,
    url,
  };
  writeJsonAtomicSync(path.join(sessionPath, '.published'), data, 2);
}

/**
 * 发布所有未发布的内容
 * @param {object} options
 * @param {string} [options.envId] - 指纹浏览器环境名，如 TK01（不传则跳过浏览器操作）
 * @param {string} [options.apiKey] - 已废弃：FoxProfile 不需要 API 密钥
 * @param {string} [options.platform] - 指定平台（默认全部）
 * @param {number} [options.maxCount] - 最多发布几个（默认全部）
 * @param {number} [options.budgetMs] - 单条内容的发布耗时预算（P2-5，默认取环境变量/30 分钟）
 */
export async function publishAll(options = {}) {
  const { envId, apiKey, platform = 'tiktok', maxCount, budgetMs } = options;
  const items = findUnpublished();

  if (items.length === 0) {
    console.log('📭 没有未发布的内容');
    return { published: 0, total: 0, failed: 0, skipped: 0 };
  }

  console.log(`📦 找到 ${items.length} 个未发布内容`);
  const toPublish = maxCount ? items.slice(0, maxCount) : items;
  let published = 0;
  let failed = 0;
  let skipped = 0;

  try {
  for (const item of toPublish) {
    console.log(`\n📤 发布: ${item.date}/${item.session}`);
    console.log(`   ${item.title}`);

    try {
      if (platform === 'tiktok') {
        if (!envId) {
          console.log('  ⚠️ 未配置指纹浏览器环境名，跳过浏览器发布');
          skipped++;
          continue;
        }
        const url = await publishToTikTok({
          sessionPath: item.path,
          videoFile: item.videoFile ? path.join(item.path, item.videoFile) : null,
          imageFiles: item.imageFiles.map(f => path.join(item.path, f)),
          titleFile: item.txtFile,
          envId,
          apiKey,
          budgetMs,
        });
        // ⚠️ .published 是 tiktok.js 在「确认点到发布按钮」时写的。
        //    这里只在标记缺失时兜底写入，绝不覆盖已有标记 ——
        //    覆盖会把 "post-clicked-unconfirmed"（结果未确认）这类证据抹掉，
        //    变成看起来"完全成功"。
        const markerPath = path.join(item.path, '.published');
        if (!fs.existsSync(markerPath)) {
          markPublished(item.path, 'tiktok', typeof url === 'string' ? url : '');
        } else {
          let marker = {};
          try { marker = fs.readJsonSync(markerPath); } catch (_) { /* ignore */ }
          if (marker.note === 'post-clicked-unconfirmed' || marker.confirmed === false) {
            console.log(`  ⚠️ 已点击发布按钮，但结果未确认（标记 note=${marker.note || '-'}）`);
          }
        }
        console.log(`  ✅ 发布成功: ${url || '(链接未知)'}`);
      } else {
        console.log(`  ⚠️ 不支持的平台: ${platform}`);
        skipped++;
        continue;
      }

      published++;
    } catch (err) {
      // 图文 session 没有 mp4 → 发布器只支持视频，这是"已知不支持"而非故障，
      // 计入 skipped，避免调度器每轮都因为图文目录告警
      if (/没有视频可发布/.test(err.message || '')) {
        console.log(`  ⏭️ 跳过（发布器目前只支持视频）: ${err.message}`);
        skipped++;
      } else if (/演练模式/.test(err.message || '')) {
        // 演练模式在点发布前主动停止：既没发布也不算失败，更不能写 .published
        console.log(`  🧪 演练完成（未发布）: ${err.message}`);
        skipped++;
      } else {
        console.error(`  ❌ 发布失败: ${err.message}`);
        failed++;
      }
      // 继续发布下一个，不中断
    }
  }

  console.log(`\n📊 发布完成: ${published}/${toPublish.length}${skipped ? `（跳过 ${skipped}）` : ''}${failed ? `（失败 ${failed}）` : ''}`);
  return { published, total: items.length, failed, skipped };
  } finally {
    // 发完把指纹浏览器窗口关掉（发布器原来从头到尾**没有**关环境的地方，
    // 每跑一轮就留一个 camoufox 窗口，越跑越多、还占着 cookie 库）。
    // 调试想留窗口看现场：设 XNOWPOST_KEEP_BROWSER=1。
    if (envId && platform === 'tiktok' && process.env.XNOWPOST_KEEP_BROWSER !== '1') {
      console.log('  🧹 关闭指纹浏览器窗口...');
      await closeFoxProfile(envId).catch((e) => console.warn(`  ⚠️ 关闭环境失败: ${e.message}`));
      const left = await import('../collector/foxprofile.js')
        .then((m) => m.foxRunning())
        .catch(() => []);
      if (Array.isArray(left) && left.length) {
        console.log(`  ⚠️ 仍有环境在运行: ${left.join(', ')}`);
      } else {
        console.log('  ✅ 已确认没有残留环境');
      }
    }
  }
}

// 直接运行时
const isMain = process.argv[1] && (
  process.argv[1].includes('publisher') ||
  process.argv[1].includes('publish')
);

if (isMain) {
  const args = process.argv.slice(2);
  const options = { budgetMs: envBudgetMs() };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env') options.envId = args[++i];
    else if (args[i] === '--platform') options.platform = args[++i];
    else if (args[i] === '--max') options.maxCount = parseInt(args[++i]);
    else if (args[i] === '--all') { /* 默认发布全部 */ }
  }

  // 从 config 读取指纹浏览器环境名（走数据目录，打包后才不会读到安装目录里的模板配置）
  const configPath = path.join(resolveDataDir(), 'config', 'user.json');
  if (!options.envId && fs.existsSync(configPath)) {
    try {
      const cfg = fs.readJsonSync(configPath);
      options.envId = cfg.accounts?.[0]?.browserEnv || cfg.accounts?.[0]?.bitEnvId;
      options.apiKey = cfg.bitApiKey || '';
    } catch (_) {}
  }

  publishAll(options).then(r => {
    console.log(`\n✅ 发布器完成 (${r.published}/${r.total})`);
    // 有失败就给出非零退出码，否则调度器"✅ 完成"把失败也当成功（与 P1-4 同源）
    process.exit(r.failed > 0 ? 1 : 0);
  }).catch(err => {
    console.error('\n❌ 发布器失败:', err);
    process.exit(1);
  });
}
