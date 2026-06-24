import 'dotenv/config';
import { generateVideoContent, generatePostContent } from './engine/text.js';
import { generateImageToFile } from './engine/image.js';
import { synthesizeAllPlatforms } from './engine/video.js';
import { pushVideoContent, pushPostContent } from './notifier.js';
import { getSessionDir } from './organizer.js';
import { saveCostLog, getSessionCost } from './engine/cost.js';
import path from 'path';
import fs from 'fs-extra';

const TIME_LABEL = new Date().getHours() < 12 ? '早上' : '晚上';

async function runVideoPipeline(sessionDir, index, topic) {
  let workDir;
  try {
    console.log(`\n🎬 === 视频 ===`);
    const c = await generateVideoContent(topic);
    console.log(`  ✅ ${c.title_zh}`);

    await fs.ensureDir(sessionDir);

    // 先保存文案
    const tags = [...(c.tags_zh||[]), ...(c.tags_en||[])].map(t => '#'+t).join(' ');
    const desc = `${c.title_zh}\n${c.title_en}\n\n${c.scenes.map((s,i)=>`${i+1}. ${s.scene_text_zh}`).join('\n')}\n\n${tags}\nxnow.taikon.top`;
    await fs.writeFile(path.join(sessionDir, '文案.txt'), desc, 'utf-8');

    workDir = path.join(sessionDir, '_video');
    const slidesDir = path.join(workDir, 'slides');
    await fs.ensureDir(slidesDir);

    // 并发生成（每批3张，9张约2分钟，比串行快3倍）
    const BATCH = 3;
    console.log(`  🎨 ${c.scenes.length} 张分镜图（并发${BATCH}）...`);
    for (let i = 0; i < c.scenes.length; i += BATCH) {
      const batch = c.scenes.slice(i, i + BATCH);
      await Promise.all(batch.map((s, j) =>
        generateImageToFile({
          prompt: s.image_desc,
          filepath: path.join(slidesDir, `scene_${String(i+j+1).padStart(2,'0')}.png`),
          width: 1080, height: 1920, index: i + j + 1,
          title: s.scene_text_zh, subtitle: s.scene_text_en,
          shotType: s.shot_type, cameraMove: s.camera_move, mood: s.mood,
        }).catch(err => console.log(`  ⚠️ 第${i+j+1}张失败: ${err.message}`))
      ));
    }

    // 独立封面（失败不阻塞）
    console.log('  🎨 封面...');
    try {
      await generateImageToFile({
        prompt: `${c.title_en}, dramatic lighting, movie poster style, bold composition`,
        filepath: path.join(sessionDir, '封面.png'),
        width: 1080, height: 1920, index: 0,
        title: c.title_zh, subtitle: c.title_en,
        tags: [...(c.tags_zh||[]), ...(c.tags_en||[])],
      });
    } catch (err) {
      console.log('  ⚠️ 封面失败: ' + err.message);
    }

    // 合成视频（FFmpeg 直接输出到 sessionDir/video.mp4，不经过临时目录）
    try {
      console.log('  🎬 合成...');
      const videoOut = path.join(sessionDir, 'video.mp4');
      const vr = await synthesizeAllPlatforms(workDir, c, videoOut);
      if (vr && await fs.pathExists(vr)) {
        const size = (await fs.stat(vr)).size;
        console.log(`  ✅ video.mp4 (${(size/1024/1024).toFixed(1)}MB)`);
      } else {
        console.log('  ⚠️ 未产出视频');
      }
    } catch (err) {
      console.log('  ⚠️ 合成异常: ' + err.message);
    }

    console.log('  ✅ 完成');
    return { content: c };
  } finally {
    // 无论成功还是崩溃，都清理工作目录，只保留 4 个产出文件
    if (workDir) await fs.remove(workDir).catch(() => {});
  }
}

async function runPostPipeline(sessionDir, index, topic) {
  console.log(`\n🟢 === 图文 ===`);
  const c = await generatePostContent(topic);
  console.log(`  ✅ ${c.title_zh}`);

  await fs.ensureDir(sessionDir);

  const zhs = (c.body_zh||'').split(/[。！？\n]/).filter(s=>s.trim().length>4);
  const ens = (c.body_en||'').split(/[.!?\n]/).filter(s=>s.trim().length>4);

  const cards = [
    { idx:1, title:c.title_zh, sub:c.title_en, points:[zhs[0],zhs[1]].filter(Boolean), prompt:c.image_desc },
    { idx:2, title:zhs[0]||c.title_zh, sub:ens[0]||'', points:[zhs[2],zhs[1]].filter(Boolean), prompt:`XNOW service dashboard showing ${c.title_en}, clean modern UI` },
    { idx:3, title:zhs[1]||zhs[0]||'', sub:ens[1]||'', points:[zhs[2],ens[0]].filter(Boolean), prompt:`social media marketing results, ${ens[0]||c.title_en}, success visualization` },
    { idx:4, title:zhs[2]||'立即体验', sub:'xnow.taikon.top', points:[zhs[0],'秒级交付 无需密码'].filter(Boolean), prompt:`XNOW ${c.title_en}, CTA, register now, energetic orange gold` },
  ];

  for (const card of cards) {
    await generateImageToFile({
      prompt: card.prompt,
      filepath: path.join(sessionDir, `p${index}_${String(card.idx).padStart(2,'0')}.png`),
      width: 1080, height: 1920, index: card.idx,
      title: card.title, subtitle: card.sub,
      points: card.points,
      tags: [...(c.tags_zh||[]), ...(c.tags_en||[])],
    });
  }

  const tags = [...(c.tags_zh||[]), ...(c.tags_en||[])].map(t => '#'+t).join(' ');
  const desc = `${c.title_zh}\n${c.title_en}\n\n${c.body_zh}\n\n${c.body_en}\n\n${tags}\nxnow.taikon.top`;
  await fs.writeFile(path.join(sessionDir, '文案.txt'), desc, 'utf-8');

  await pushPostContent(c, index, path.join(sessionDir, `p${index}_01.png`), TIME_LABEL);
  console.log('  ✅ 4张轮播图');
  return { content: c };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--video-only') ? 'video' : args.includes('--post-only') ? 'post' : 'auto';

  // 解析可选参数
  const topicIdx = args.indexOf('--topic');
  const topic = topicIdx !== -1 && topicIdx + 1 < args.length ? args[topicIdx + 1] : '';

  const autoPublish = args.includes('--auto-publish');
  const accountIdx = args.indexOf('--account');
  const accountName = accountIdx !== -1 && accountIdx + 1 < args.length ? args[accountIdx + 1] : '';

  // 统一会话目录（只建一次）
  const sessionDir = getSessionDir();

  console.log(`\n🚀 XNOWPost — ${new Date().toLocaleString('zh-CN')}`);
  console.log(`📅 ${sessionDir} | 模式: ${mode}${topic ? ` | 主题: ${topic}` : ''}\n`);

  // 先保存空费用记录，保证 cost.json 一定存在
  try { await saveCostLog(sessionDir); } catch (_) {}

  try {
    if (mode === 'auto' || mode === 'video') {
      await runVideoPipeline(sessionDir, 1, topic);
    } else {
      await runPostPipeline(sessionDir, 1, topic);
    }

    const cost = getSessionCost();
    await saveCostLog(sessionDir);
    console.log(`\n💰 DeepSeek ¥${cost.deepseek.toFixed(4)} + Kolors ¥${cost.kolors.toFixed(2)} = ¥${cost.total.toFixed(2)}`);
    console.log(`✅ 完成！📁 ${sessionDir}\n`);

    // === 自动发布（闹钟模式：生成后直接发布到指定账号） ===
    if (autoPublish && accountName) {
      console.log(`\n📤 自动发布到账号: ${accountName}`);
      const configPath = path.resolve(process.env.XNOWPOST_DATA_DIR || '.', 'config', 'user.json');
      let config;
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (e) {
        console.error(`  ❌ 读取配置失败: ${e.message}`);
        process.exit(1);
      }

      const account = config.accounts?.find(a => a.name === accountName);
      if (!account) {
        console.error(`  ❌ 配置中找不到账号: ${accountName}`);
        process.exit(1);
      }
      if (!account.bitEnvId) {
        console.error(`  ❌ 账号 ${accountName} 未配置比特环境 ID`);
        process.exit(1);
      }

      // 查找生成的视频/图文文件
      const files = fs.readdirSync(sessionDir);
      const videoFile = files.find(f => f.endsWith('.mp4'));
      const txtFile = files.find(f => f === '文案.txt');

      if (!videoFile) {
        console.error('  ❌ 没有找到生成的视频文件');
        process.exit(1);
      }

      try {
        const { publishToTikTok } = await import('./publisher/tiktok.js');
        const url = await publishToTikTok({
          sessionPath: sessionDir,
          videoFile: path.join(sessionDir, videoFile),
          titleFile: path.join(sessionDir, txtFile),
          envId: account.bitEnvId,
          apiKey: config.bitApiKey || '',
        });
        console.log(`  ✅ 自动发布完成 ${url ? `(${url})` : ''}`);
      } catch (pubErr) {
        // publishToTikTok 在 Post 点击后会写 .published 标记，
        // 并且 postedYet=true 时只警告不抛错。
        // 能走到这里的 catch，说明发布确实没开始（没点 Post 按钮）。
        // 调度器已配置为 auto-publish 模式不重试，避免重跑 engine 浪费钱。
        console.error(`  ❌ 自动发布失败: ${pubErr.message}`);
        process.exit(1);
      }
    }
  } catch (err) {
    console.error('\n❌ ' + err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 3).join('\n'));
    // 报错也保存费用
    try { const cost = getSessionCost(); saveCostLog(sessionDir); } catch (_) {}
    process.exit(1);
  }
}

main();
