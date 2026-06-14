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
  console.log(`\n🎬 === 视频 ===`);
  const c = await generateVideoContent(topic);
  console.log(`  ✅ ${c.title_zh}`);

  await fs.ensureDir(sessionDir);

  // 先保存文案
  const tags = [...(c.tags_zh||[]), ...(c.tags_en||[])].map(t => '#'+t).join(' ');
  const desc = `${c.title_zh}\n${c.title_en}\n\n${c.scenes.map((s,i)=>`${i+1}. ${s.scene_text_zh}`).join('\n')}\n\n${tags}\nxnow.taikon.top`;
  await fs.writeFile(path.join(sessionDir, '文案.txt'), desc, 'utf-8');

  const workDir = path.join(sessionDir, '_video');
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

  // 合成视频
  let videoOK = false;
  try {
    console.log('  🎬 合成...');
    const vr = await synthesizeAllPlatforms(workDir, c);
    if (vr && await fs.pathExists(vr)) {
      await fs.copy(vr, path.join(sessionDir, 'video.mp4'));
      const size = (await fs.stat(vr)).size;
      console.log(`  ✅ video.mp4 (${(size/1024/1024).toFixed(1)}MB)`);
      videoOK = true;
    } else {
      console.log('  ⚠️ 未产出视频, 保留: ' + workDir);
    }
  } catch (err) {
    console.log('  ⚠️ 合成异常: ' + err.message);
  }

  if (videoOK) await fs.remove(workDir).catch(() => {});
  console.log('  ✅ 完成');
  return { content: c };
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

  // 解析用户主题（可选）
  const topicIdx = args.indexOf('--topic');
  const topic = topicIdx !== -1 && topicIdx + 1 < args.length ? args[topicIdx + 1] : '';

  // 统一会话目录（只建一次）
  const sessionDir = getSessionDir();

  console.log(`\n🚀 XNOWPost — ${new Date().toLocaleString('zh-CN')}`);
  console.log(`📅 ${sessionDir} | 模式: ${mode}${topic ? ` | 主题: ${topic}` : ''}\n`);

  try {
    if (mode === 'auto') {
      await runVideoPipeline(sessionDir, 1, topic);
      if (new Date().getHours() < 12) await runPostPipeline(sessionDir, 2, topic);
    } else if (mode === 'video') {
      await runVideoPipeline(sessionDir, 1, topic);
    } else {
      await runPostPipeline(sessionDir, 1, topic);
    }

    const cost = getSessionCost();
    await saveCostLog(sessionDir);
    console.log(`\n💰 DeepSeek ¥${cost.deepseek.toFixed(4)} + Kolors ¥${cost.kolors.toFixed(2)} = ¥${cost.total.toFixed(2)}`);
    console.log(`✅ 完成！📁 ${sessionDir}\n`);
  } catch (err) {
    console.error('\n❌ ' + err.message);
    process.exit(1);
  }
}

main();
