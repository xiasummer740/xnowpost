import 'dotenv/config';
import { generateVideoContent, generatePostContent, setScreenshotContext } from './engine/text.js';
import { describeScreenshots } from './engine/vision.js';
import { maskPromoCodes } from './engine/mask.js';
import { generateImageToFile, generatePlaceholderToFile, imageQuality } from './engine/image.js';
import { getFontStatus } from './engine/fonts.js';
import { synthesizeAllPlatforms, generateVoiceTrack } from './engine/video.js';
import { prependCoverCard } from './engine/covercard.js';
import { fetchBrollForScenes, attachUserMaterials } from './engine/material.js';
import { generateHeroClip } from './engine/i2v.js';
import { pushVideoContent, pushPostContent } from './notifier.js';
import { getSessionDir } from './organizer.js';
import { saveCostLog, getSessionCost, imageUnitPrice } from './engine/cost.js';
import { verifyMediaTools } from './engine/tools.js';
import { validateApiKeys } from './engine/apikey.js';
import { getDeepSeekConfig, getSceneCount, getVideoStyleConfig, getContentPolicy } from './engine/config.js';
import { resolveDataDir } from './paths.js';
import { writeFileAtomic, writeJsonAtomic } from './fs-atomic.js';
import path from 'path';
import fs from 'fs-extra';

const TIME_LABEL = new Date().getHours() < 12 ? '早上' : '晚上';

// 自动发布的耗时预算：必须**小于宿主超时**（调度器 execSync 给 15 分钟），
// 否则进程会在发布中途被强杀 —— 窗口残留、标记可能没写、下一轮重复上传（P2-5）。
const AUTO_PUBLISH_BUDGET_MS = Number(process.env.XNOWPOST_PUBLISH_BUDGET_MS) > 0
  ? Number(process.env.XNOWPOST_PUBLISH_BUDGET_MS)
  : 12 * 60 * 1000;

/**
 * 写 FAILED 标记（P1-4）
 * 合成失败/流程异常时留下可被上层（调度器、GUI）识别的痕迹，
 * 同时由退出码给出非零结果 —— 旧实现只打一条警告然后 exit 0，
 * 调度器因此记录"✅ 完成"，半成品 session 被当成有效产出。
 */
async function markFailed(sessionDir, stage, err, extra = {}) {
  try {
    await writeJsonAtomic(path.join(sessionDir, 'FAILED'), {
      stage,
      reason: err?.message || String(err),
      at: new Date().toISOString(),
      ...extra,
    }, 2);
    console.log(`  🚩 已写入失败标记: ${path.join(sessionDir, 'FAILED')}`);
  } catch (e) {
    console.warn(`  ⚠️ 写入 FAILED 标记失败: ${e.message}`);
  }
}

/** 分镜图路径（01 起编号，与 video.js 的 concat 列表一致） */
function slidePathOf(slidesDir, idx) {
  return path.join(slidesDir, `scene_${String(idx + 1).padStart(2, '0')}.png`);
}

// 品牌官网行：以前硬编码成 "xnow.taikon.top" 拼在每条文案末尾，
// 与「不出现网址」的合规规则自相矛盾。改成 config 里的 content.brandUrl，
// 默认留空；想引流就填上。
function brandLine() {
  const url = (getContentPolicy().brandUrl || '').trim();
  return url ? `\n${url}` : '';
}

// 本次生成时用户当场选的截图（控制台通过环境变量传来）
function readUserImages() {
  const raw = process.env.XNOWPOST_USER_IMAGES;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(p => typeof p === 'string' && p) : [];
  } catch (_) {
    return [];
  }
}

/**
 * 把文案写成 `文案.txt`（发布器当标题用）+ `描述.txt`（中英双语 Description）。
 * 抽成独立函数是为了让「只生成文案」模式（--text-only）和视频流程**共用同一份写法** ——
 * 复制一份迟早会漂移（一边改了标签规则、另一边没改）。
 * @returns {{tagLine:string, bilingual:string}}
 */
async function writeContentFiles(sessionDir, c) {
  // 标签规范化：英文标签原文常带空格（"#secure browsing"），TikTok 只把空格前那段当标签，
  // 后面变成普通文字 → 白写。统一去掉空格（#SecureBrowsing / #securebrowsing 都能被索引），
  // 并按小写去重，避免 #VPN 和 #vpn 重复占位。
  const normTag = (t) => String(t || '').replace(/^#/, '').replace(/\s+/g, '').trim();
  const seenTag = new Set();
  const tagLine = [...(c.tags_zh || []), ...(c.tags_en || [])]
    .map(normTag)
    .filter((t) => {
      if (!t) return false;
      const k = t.toLowerCase();
      if (seenTag.has(k)) return false;
      seenTag.add(k);
      return true;
    })
    .map((t) => '#' + t)
    .join(' ');
  const desc = `${c.title_zh}\n${c.title_en}\n\n${(c.scenes || []).map((s, i) => `${i + 1}. ${s.scene_text_zh}`).join('\n')}\n\n${tagLine}${brandLine()}`;
  await writeFileAtomic(path.join(sessionDir, '文案.txt'), desc, 'utf-8');

  // 发布用 Description（中英双语）：国内用户看中文、海外用户看英文。
  // 在**生成阶段**就定稿，发布器直接原样粘贴，不再临时拼装 —— 这样文案是"一处生成、多处一致"。
  // 只取前两屏字幕，避免描述过长影响完读率（TikTok 上限 2200 字）。
  const pairLines = [];
  for (const s of (c.scenes || []).slice(0, 2)) {
    if (s.scene_text_zh) pairLines.push(s.scene_text_zh);
    if (s.scene_text_en) pairLines.push(s.scene_text_en);
  }
  // 发布用标签不要全量：TikTok 一条挂 14 个标签观感很差，也稀释权重。
  // 中英交替取 6 个（前半英文给海外、后半中文给国内）。
  const asciiTag = (t) => /^[A-Za-z0-9_]+$/.test(t);
  const allTags = tagLine.split(/\s+/).filter(Boolean);
  const enTags = allTags.filter((t) => asciiTag(t.slice(1)));
  const zhTags = allTags.filter((t) => !asciiTag(t.slice(1)));
  const picked = [];
  while (picked.length < 6 && (enTags.length || zhTags.length)) {
    if (picked.length % 2 === 0 && enTags.length) picked.push(enTags.shift());
    else if (zhTags.length) picked.push(zhTags.shift());
    else if (enTags.length) picked.push(enTags.shift());
    else break;
  }
  const postTagLine = picked.join(' ');

  const bilingual = [c.title_zh || '', c.title_en || '', pairLines.join('\n'), postTagLine]
    .filter((s) => String(s || '').trim())
    .join('\n\n');
  await writeFileAtomic(path.join(sessionDir, '描述.txt'), bilingual, 'utf-8');
  return { tagLine, bilingual };
}

async function runVideoPipeline(sessionDir, index, topic) {
  let workDir;
  console.log(`\n🎬 === 视频 ===`);

  // 用户这次上传了截图 → 先读图，再写文案。
  // 顺序很关键：必须在 generateVideoContent 之前，否则文案还是凭空写的，
  // 画面和文案两张皮（这正是之前的问题）。
  const shots = readUserImages();
  if (shots.length) {
    const desc = await describeScreenshots(shots, { apiKey: process.env.SILICONFLOW_API_KEY });
    setScreenshotContext(desc);
    if (desc) console.log(`  🧠 文案将围绕截图内容展开`);
  } else {
    setScreenshotContext('');
  }

  const c = await generateVideoContent(topic);
  console.log(`  ✅ ${c.title_zh}`);

  await fs.ensureDir(sessionDir);

  // 文案与双语描述的写法抽到 writeContentFiles()（--text-only 模式共用同一份）
  await writeContentFiles(sessionDir, c);

  let ok = false;
  try {
    workDir = path.join(sessionDir, '_video');
    const slidesDir = path.join(workDir, 'slides');
    await fs.ensureDir(slidesDir);

    // ⭐ 先配音，再生图（省钱顺序）。
    // 配音免费但最容易坏（微软轮换令牌 → 403，实测过一次）；
    // 生图每张 ≈¥0.02。先配音：坏在配音上只损失 DeepSeek 的 ¥0.0095；
    // 先配图：坏在配音上要烧掉 9 张图 ≈¥0.18 才失败。
    console.log('  🗣️ 先做配音（失败则一分钱不花在生图上）...');
    const voiceTrack = await generateVoiceTrack(workDir, c);

    // 实拍素材（免费）：有 Pexels Key 时优先用真实拍摄的画面，
    // 没有 Key / 搜不到 → 自动回退 AI 静态图 + 运镜，不影响出片。
    // 放在生图之前：它免费，而每张 AI 图 ≈¥0.02。
    const style = getVideoStyleConfig();
    const scenes = c.scenes;

    // 用户自带截图优先于一切素材源 —— 自己的后台/产品截图比图库更贴切，
    // 而且完全免费（只是本地转码）。
    // 来源优先级：控制台当场选的图片（环境变量） > 设置里的素材目录
    let materialSource = style.materialsDir;
    const shotsEnv = readUserImages();
    if (shotsEnv.length) materialSource = shotsEnv;
    // 截图只占少数几镜（默认 2），其余交给实拍 / AI 画面
    const maxShotScenes = Number(style.materialsMaxScenes) > 0
      ? Math.min(Number(style.materialsMaxScenes), 4) : 2;

    // 自动打码：截图里常印着优惠码／邀请码，不该出现在成片里。
    // 只在"本次上传了截图"时触发（素材目录模式不动用户原图）。
    if (Array.isArray(materialSource) && materialSource.length && getContentPolicy().maskPromoCode) {
      try {
        const masked = await maskPromoCodes(materialSource.slice(0, maxShotScenes), {
          apiKey: process.env.SILICONFLOW_API_KEY,
          outDir: path.join(sessionDir, '_masked'),
        });
        if (masked.maskedCount > 0) console.log(`  🔒 已打码 ${masked.maskedCount} 处优惠码`);
        for (const r of masked.reasons || []) console.log(`  ⚠️ ${r}`);
        materialSource = masked.paths;
      } catch (e) {
        console.log(`  ⚠️ 打码流程异常（跳过，不影响出片）: ${e.message}`);
      }
    }

    const materials = await attachUserMaterials(workDir, materialSource, scenes.length, {
      maxScenes: maxShotScenes,
    });
    const materialIdx = new Set(materials.indices || []);
    if (materials.ok) {
      console.log(`  🖼️ 用户素材 ${materials.indices.length}/${scenes.length} 镜` +
        `（${materials.fileCount} 张图，来自 ${materials.source}）`);
    } else if (materialSource) {
      console.log(`  🖼️ 未使用用户素材（${materials.reason}）`);
    }
    // 开场镜图生视频（唯一付费的画面增强，默认关闭）：这几镜不当实拍素材搜索对象
    // 已有用户素材的分镜也跳过 —— 用户给的图比 AI 生成更可信
    const heroCount = style.heroI2V ? Math.min(style.heroScenes, scenes.length) : 0;
    const heroIdx = Array.from({ length: heroCount }, (_, i) => i).filter(i => !materialIdx.has(i));

    const broll = await fetchBrollForScenes(workDir, scenes, { skipIndices: [...heroIdx, ...materialIdx] });
    const brollIdx = new Set(broll.indices || []);
    if (broll.ok) {
      console.log(`  🎞️ 实拍素材 ${broll.fetched}/${broll.total} 镜（Pexels，免费）`);
    } else {
      console.log(`  🎞️ 未使用实拍素材（${broll.reason}）`);
    }

    // === 开场镜：先生成首帧 AI 图，再交给 Wan2.2 让它动起来 ===
    // 用图生视频（不是文生视频）是为了让产品/人物在多镜之间保持一致。
    const generatedImages = new Set();
    for (const idx of heroIdx) {
      const slidePath = slidePathOf(slidesDir, idx);
      try {
        await generateImageToFile({
          prompt: scenes[idx].image_desc,
          filepath: slidePath,
          width: 1080, height: 1920, index: idx + 1,
          title: scenes[idx].scene_text_zh, subtitle: scenes[idx].scene_text_en,
          shotType: scenes[idx].shot_type, cameraMove: scenes[idx].camera_move, mood: scenes[idx].mood,
        });
        generatedImages.add(idx);
      } catch (err) {
        console.log(`  ⚠️ 开场镜第${idx + 1}镜首帧生成失败: ${err.message} → 改用实拍素材`);
        continue;
      }
      const outClip = path.join(workDir, 'broll', `scene_${String(idx + 1).padStart(2, '0')}.mp4`);
      const r = await generateHeroClip({
        imagePath: slidePath,
        prompt: scenes[idx].image_desc,
        outPath: outClip,
        apiKey: process.env.SILICONFLOW_API_KEY,
      });
      if (r.ok) {
        brollIdx.add(idx);
        console.log(`  🎬 第${idx + 1}镜使用 AI 图生视频（首帧 ¥${imageUnitPrice().toFixed(2)} + I2V）`);
      } else {
        console.log(`  ⚠️ 图生视频失败: ${r.reason} → 第${idx + 1}镜回退「AI 图 + 运镜」`);
      }
    }

    // 并发生成（每批3张，比串行快3倍）
    // ⭐ 已有实拍素材的分镜**完全不生图**：一张 ¥0.02，9 镜全有素材就省 ¥0.18，
    // 这才是"实拍素材比 AI 图便宜"真正落地的地方（否则素材免费了、图照旧花钱）。
    const BATCH = 3;
    const needIdx = scenes.map((_, i) => i)
      .filter(i => !brollIdx.has(i) && !generatedImages.has(i) && !materialIdx.has(i));
    const failedIdx = new Set();
    const savedImages = brollIdx.size;
    const savedMoney = savedImages * imageUnitPrice();
    if (needIdx.length === 0) {
      console.log(`  🎨 全部分镜已有实拍素材，跳过生图（省 ¥${savedMoney.toFixed(2)}）`);
    } else {
      console.log(`  🎨 生成 ${needIdx.length}/${scenes.length} 张分镜图（并发${BATCH}）` +
        (savedImages > 0 ? `，另外 ${savedImages} 镜用实拍素材，省 ¥${savedMoney.toFixed(2)}` : '') + '...');
    }
    for (let i = 0; i < needIdx.length; i += BATCH) {
      const batch = needIdx.slice(i, i + BATCH);
      await Promise.all(batch.map((idx) => {
        const s = scenes[idx];
        return generateImageToFile({
          prompt: s.image_desc,
          filepath: slidePathOf(slidesDir, idx),
          width: 1080, height: 1920, index: idx + 1,
          title: s.scene_text_zh, subtitle: s.scene_text_en,
          shotType: s.shot_type, cameraMove: s.camera_move, mood: s.mood,
        }).catch(err => {
          failedIdx.add(idx);
          console.log(`  ⚠️ 第${idx+1}张失败: ${err.message}`);
        });
      }));
    }

    // P2-1：单张分镜图失败不能拖垮整段视频 ——
    // 旧实现只是吞掉异常，而 concat 列表照样引用缺失文件 → 整段合成失败。
    // 这里用**不花钱**的纯 Canvas 占位图补齐，保证画面与配音时间轴一一对应。
    for (const idx of [...failedIdx].sort((a, b) => a - b)) {
      if (await fs.pathExists(slidePathOf(slidesDir, idx))) continue;
      try {
        await generatePlaceholderToFile({
          filepath: slidePathOf(slidesDir, idx),
          width: 1080, height: 1920, index: idx + 1,
          title: scenes[idx]?.scene_text_zh || '',
        });
      } catch (e) {
        console.warn(`  ⚠️ 第${idx+1}张占位图也失败: ${e.message}`);
      }
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

    // 若有限流降级，明确告知：成片能出，但画面是占位图
    if (imageQuality.canvasFallbacks > 0) {
      console.warn(`  ⚠️ ${imageQuality.canvasFallbacks} 张为 Canvas 占位图（非 AI 生成）——成片画面质量下降`);
    }

    // 合成视频（FFmpeg 直接输出到 sessionDir/video.mp4，不经过临时目录）
    // ⚠️ 不再吞异常：合成失败必须让上层拿到非零结果 + FAILED 标记（P1-4）
    console.log('  🎬 合成...');
    const videoOut = path.join(sessionDir, 'video.mp4');
    // 复用上面已经生成好的音轨，不重复合成配音
    const vr = await synthesizeAllPlatforms(workDir, c, videoOut, voiceTrack);
    if (!vr || !(await fs.pathExists(vr))) {
      throw new Error('视频合成未产出文件（video.mp4 不存在）');
    }
    const size = (await fs.stat(vr)).size;
    if (size === 0) throw new Error('视频合成产出了 0 字节文件');
    // 文件大小那行已由 src/engine/video.js 的 synthOne() 打过（✅ video.mp4 (x.xMB)），
    // 这里不再重复 —— 2026-10-19 日志里同一行出现两遍，看着像合成了两次。

    // 🖼️ 开头封面卡：把 封面.png 贴到正片最前面 1.6 秒。
    // 不这么做的话，第一帧是分镜的 fade-in（全黑），平台自动封面也是黑的，
    // 刷到的人根本不知道这条视频讲什么（用户实拍反馈 2026-10-18）。
    // 失败不影响成片：回退成原来的 video.mp4，只记一笔日志。
    const coverPath = path.join(sessionDir, '封面.png');
    if (await fs.pathExists(coverPath)) {
      const tCard = Date.now();
      try {
        await prependCoverCard(vr, coverPath, { seconds: 1.6 });
        const nsize = (await fs.stat(vr)).size;
        console.log(`  ✅ 开头封面卡已加（+1.6s，${((Date.now() - tCard) / 1000).toFixed(1)}s，${(nsize / 1024 / 1024).toFixed(1)}MB）`);
      } catch (err) {
        console.log(`  ⚠️ 封面卡失败（成片照常用）: ${err.message}`);
      }
    } else {
      console.log('  ⚠️ 没有 封面.png，跳过开头封面卡');
    }

    // P2-12：视频产出后推送通知（此前 pushVideoContent 导入了却从未调用）
    const pushRes = await pushVideoContent(c, index, vr, TIME_LABEL);
    // 「未配置 TG」的提示由 notifier.pushVideoContent() 自己打，这里不再打一遍（同义两条）
    if (!pushRes.skipped && !pushRes.ok) console.log(`  ⚠️ 视频推送失败（不影响产出）: ${pushRes.error}`);

    ok = true;
    return { content: c, videoPath: vr };
  } finally {
    // 只有**成功**才清理中间产物。
    // 失败时必须保留 slides/ 和配音 —— 那是已经付过钱的素材（9 张图 ≈¥0.18），
    // 旧实现在 finally 里无条件删除，导致重试要重新付费。
    if (workDir && ok) {
      await fs.remove(workDir).catch(() => {});
    } else if (workDir) {
      console.warn(`  💾 已保留中间产物（已付费素材）: ${workDir}`);
    }
  }
}

async function runPostPipeline(sessionDir, index, topic, textName = '文案.txt') {
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

  // 标签必须去空格：`#social media management` 在 TikTok 里只有 #social 生效，
  // 后面全变成正文（2026-10-18 22:52 图文实测中招）。中文标签同样去空格并按小写去重。
  const normTagP = (t) => String(t || '').replace(/^#/, '').replace(/\s+/g, '').trim();
  const seenP = new Set();
  const postTags = [];
  for (const raw of [...(c.tags_zh || []), ...(c.tags_en || [])]) {
    const t = normTagP(raw);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seenP.has(k)) continue;
    seenP.add(k);
    postTags.push(t);
  }
  const tags = postTags.map((t) => '#' + t).join(' ');
  const desc = `${c.title_zh}\n${c.title_en}\n\n${c.body_zh}\n\n${c.body_en}\n\n${tags}${brandLine()}`;
  // ⚠️ auto 模式会先跑视频再跑图文，两者不能抢同一个 文案.txt：
  //    发布器读的是 文案.txt 作为视频标题，所以图文另存一份
  await writeFileAtomic(path.join(sessionDir, textName), desc, 'utf-8');

  const imagePath = path.join(sessionDir, `p${index}_01.png`);
  const pushRes = await pushPostContent(c, index, imagePath, TIME_LABEL);
  // 同视频：「未配置 TG」由 notifier 自己打，这里不重复
  if (!pushRes.skipped && !pushRes.ok) console.log(`  ⚠️ 图文推送失败（不影响产出）: ${pushRes.error}`);

  console.log('  ✅ 4张轮播图');
  return { content: c, imagePath };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--video-only') ? 'video'
    : args.includes('--post-only') ? 'post'
      : args.includes('--text-only') ? 'text'
        : 'auto';

  // 解析可选参数
  const topicIdx = args.indexOf('--topic');
  const topic = topicIdx !== -1 && topicIdx + 1 < args.length ? args[topicIdx + 1] : '';

  const autoPublish = args.includes('--auto-publish');
  const accountIdx = args.indexOf('--account');
  const accountName = accountIdx !== -1 && accountIdx + 1 < args.length ? args[accountIdx + 1] : '';

  // === 预检 0：图文 + 自动发布的组合不可能成功（P2-2）===
  // TikTok 发布器只支持视频（需要 mp4），旧实现会在**烧完 DeepSeek + 4 张生图费用之后**
  // 才抛"没有视频可发布"。这里提前失败，一分钱都不花。
  if (mode === 'post' && autoPublish && accountName) {
    console.error('\n❌ --post-only 与 --auto-publish 不能同时使用：');
    console.error('   TikTok 自动发布器目前只支持视频（需要 mp4），图文轮播暂无自动发布通道。');
    console.error('   请去掉 --auto-publish，或把该闹钟的模式改为"仅视频"。\n');
    return 1;
  }
  // 只出文案当然没有东西可发（2026-10-19 助手实测：说"约 ¥0.01 只出文案"，
  // 结果跑了整条视频流程 —— 因为 --text-only 当时根本不存在，mode=text 被当成了 auto）。
  if (mode === 'text' && autoPublish && accountName) {
    console.error('\n❌ --text-only 与 --auto-publish 不能同时使用：只出文案，没有成片可发。\n');
    return 1;
  }

  // 插画/视频模式要调用 DeepSeek 与硅基流动，占位符 Key 一定 401。
  // 放在任何花钱步骤之前：仓库里的 .env 是模板（sk-your-api-key-here），
  // 命令行直接跑会拿占位符去请求，报错信息里只有一句看不懂的 401。
  // text 模式只走 DeepSeek，不需要硅基流动（不配音、不生图）。
  if (mode === 'auto' || mode === 'video' || mode === 'text') {
    const keys = [{ value: process.env.DEEPSEEK_API_KEY, label: 'DeepSeek Key（DEEPSEEK_API_KEY）' }];
    // text 模式不配音、不生图，硅基流动的 Key 用不到 → 没配也不该拦
    if (mode !== 'text') keys.push({ value: process.env.SILICONFLOW_API_KEY, label: '硅基流动 Key（SILICONFLOW_API_KEY）' });
    const keyProblems = validateApiKeys(keys);
    if (keyProblems.length > 0) {
      console.error('\n❌ API Key 未正确配置，已中止（未产生任何费用）:');
      keyProblems.forEach(p => console.error(`   · ${p}`));
      console.error('\n   说明: 命令行运行时 Key 只从环境变量/.env 读取（.env 默认是模板占位符）。');
      console.error('         安装版由主进程从「设置」里的配置注入，无需 .env。\n');
      return 1;
    }
  }

  // === 启动预检：外部依赖缺失就直接退出 ===
  // 放在建目录 / 写 cost.json 之前：失败时磁盘上不留痕迹，
  // 更不会先烧掉 DeepSeek 与生图费用再失败
  let toolBanner = '';
  if (mode === 'auto' || mode === 'video') {
    const missing = [];
    const tools = verifyMediaTools();
    const LABELS = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', edgeTts: 'edge-tts', edgeTtsSpeech: 'edge-tts 语音合成' };
    for (const [name, r] of Object.entries(tools)) {
      if (!r.ok) missing.push(`${LABELS[name] || name} (${r.path}) — ${r.error}`);
    }
    if (missing.length > 0) {
      console.error('\n❌ 缺少视频合成所需的系统工具，已中止（未产生任何 API 费用）:');
      missing.forEach(m => console.error(`   · ${m}`));
      console.error('\n   安装建议: winget install Gyan.FFmpeg   /   pip install -U edge-tts');
      if (!tools.edgeTtsSpeech.ok) {
        console.error('   提示: edge-tts 版本能打印但合成失败，通常是客户端过期（微软轮换了令牌）');
        console.error('         升级即可: pip install -U edge-tts\n');
      }
      return 1;
    }
    const ver = (tools.ffmpeg.version.match(/version\s+(\S+)/) || [, '?'])[1];
    toolBanner = ` | 🧰 ffmpeg ${ver}`;
  }

  // 统一会话目录（只建一次）
  const sessionDir = getSessionDir();

  console.log(`\n🚀 XNOWPost — ${new Date().toLocaleString('zh-CN')}`);
  console.log(`📅 ${sessionDir} | 模式: ${mode}${topic ? ` | 主题: ${topic}` : ''}${toolBanner}\n`);

  // 配置自检日志（P2-11：config/default.json 现在真的生效，实际用了什么一眼可见）
  if (mode !== 'post') {
    const ds = getDeepSeekConfig();
    console.log(`⚙️ 模型 ${ds.model} | 温度 ${ds.temperature} | max_tokens ${ds.maxTokens} | 分镜 ${getSceneCount()}（config/default.json）`);
  }
  // 中文字体缺失 → 图片里的中文会变方块（P2-27：以前只在 image.js 里静默 warn）
  const font = getFontStatus();
  if (!font.ok) {
    console.warn(`⚠️ 中文字体不可用（${font.error}）→ 产出图片中的中文会显示为方块，请确认系统字体或改用英文文案`);
  }

  // 先保存空费用记录，保证 cost.json 一定存在
  try { await saveCostLog(sessionDir); } catch (_) {}

  // === 跑流水线 ===
  // auto 模式 = 视频 + 图文（调度器里这个模式就叫"视频+图文"，旧实现从不跑图文）
  // 两条流程各自捕获失败，任一条失败都要非零退出（P1-4）
  const failures = [];
  if (mode === 'text') {
    // 只出文案：DeepSeek 一轮 + 写 文案.txt/描述.txt，不配音、不生图、不合成、不发布。
    // 这是助手 run_engine(mode='text') 承诺的"约 ¥0.01"。以前没有这个分支，
    // mode=text 被当成 auto → 跑了整条视频流程（2026-10-19 22:29 实测，多花 ¥0.02、多等 3 分钟）。
    try {
      const shots = readUserImages();
      if (shots.length) {
        const desc = await describeScreenshots(shots, { apiKey: process.env.SILICONFLOW_API_KEY });
        setScreenshotContext(desc);
      } else {
        setScreenshotContext('');
      }
      const c = await generateVideoContent(topic);
      await fs.ensureDir(sessionDir);
      await writeContentFiles(sessionDir, c);
      console.log(`  ✅ 文案已生成（只出文案，不配音/不生图/不合成/不发布）: ${c.title_zh}`);
    } catch (err) {
      failures.push({ stage: '文案', err });
      console.error(`\n❌ 文案生成失败: ${err.message}`);
    }
  }
  if (mode !== 'post' && mode !== 'text') {
    try {
      await runVideoPipeline(sessionDir, 1, topic);
    } catch (err) {
      failures.push({ stage: '视频', err });
      console.error(`\n❌ 视频流程失败: ${err.message}`);
    }
  }
  if (mode !== 'video' && mode !== 'text') {
    try {
      // auto 模式图文文案另存，避免覆盖视频用的 文案.txt
      await runPostPipeline(sessionDir, 1, topic, mode === 'auto' ? '文案_图文.txt' : '文案.txt');
    } catch (err) {
      failures.push({ stage: '图文', err });
      console.error(`\n❌ 图文流程失败: ${err.message}`);
    }
  }

  // 费用落盘（P2-20：这里必须 await，旧实现未等待就 process.exit，费用记录直接丢）
  await saveCostLog(sessionDir);
  const cost = getSessionCost();
  console.log(`\n💰 DeepSeek ¥${cost.deepseek.toFixed(4)} + Kolors ¥${cost.kolors.toFixed(2)} (${cost.kolorsCount ?? 0}张) = ¥${cost.total.toFixed(2)}`);

  const videoOk = !failures.some(f => f.stage === '视频');
  let publishedOk = false;
  // 「点了 Post 但没能证明已公开」—— 既不算成功，也不许重发（2026-10-19 P0-2）
  let publishUnconfirmed = false;

  // === 自动发布（闹钟模式：生成后直接发布到指定账号） ===
  if (autoPublish && accountName && videoOk) {
    console.log(`\n📤 自动发布到账号: ${accountName}`);
    const configPath = path.join(resolveDataDir(), 'config', 'user.json');
    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
      console.error(`  ❌ 读取配置失败 (${configPath}): ${e.message}`);
      failures.push({ stage: '发布', err: e });
      await markFailed(sessionDir, '发布配置', e);
      return 1;
    }

    const account = config.accounts?.find(a => a.name === accountName);
    if (!account) {
      console.error(`  ❌ 配置中找不到账号: ${accountName}`);
      return 1;
    }
    if (!account.bitEnvId) {
      console.error(`  ❌ 账号 ${accountName} 未配置比特环境 ID`);
      return 1;
    }

    // 查找生成的视频文件
    const files = await fs.readdir(sessionDir);
    const videoFile = files.find(f => f.endsWith('.mp4'));
    const txtFile = files.find(f => f === '文案.txt');

    if (!videoFile) {
      console.error('  ❌ 没有找到生成的视频文件');
      return 1;
    }

    try {
      const { publishToTikTok } = await import('./publisher/tiktok.js');
      const url = await publishToTikTok({
        sessionPath: sessionDir,
        videoFile: path.join(sessionDir, videoFile),
        titleFile: path.join(sessionDir, txtFile),
        envId: account.bitEnvId,
        apiKey: config.bitApiKey || '',
        // 预算必须小于宿主 15 分钟超时，超时会提前结束并明确报"未确认"
        budgetMs: AUTO_PUBLISH_BUDGET_MS,
        // 发布器「点了 Post 但没确认结果」时不会抛错，只会回调这里 ——
        // 以前不接这个回调，于是把"未确认"直接当成了 ✅ 成功（P0-2）
        onUnconfirmed: ({ reason } = {}) => {
          publishUnconfirmed = true;
          console.log(`  ⚠️ 发布结果未确认：${reason || '预算内无法确认已公开'}`);
        },
      });
      // 标记里也可能是未确认（发布器写入 confirmed:false）
      try {
        const marker = JSON.parse(fs.readFileSync(path.join(sessionDir, '.published'), 'utf-8'));
        if (marker && (marker.confirmed === false || marker.note === 'post-clicked-unconfirmed')) {
          publishUnconfirmed = true;
        }
      } catch (_) { /* 没有标记就按未确认处理 */ publishUnconfirmed = true; }
      if (publishUnconfirmed) {
        // 视频确实点过 Post → published:true，让下一轮**不会**重发；但本轮如实报"未确认"
        await markFailed(sessionDir, '发布未确认', new Error('已点击发布按钮，但预算内无法确认已公开'), { published: true });
        console.error(`  ⚠️ 已点击发布但结果未确认 📁 ${sessionDir}\n`);
        return 3;
      }
      console.log(`  ✅ 自动发布完成 ${url ? `(${url})` : ''}`);
      publishedOk = true;
    } catch (pubErr) {
      // publishToTikTok 在 Post 点击后会写 .published 标记，
      // 并且 postedYet=true 时只警告不抛错。
      // 能走到这里的 catch，说明发布确实没开始（没点 Post 按钮）或者结果未确认。
      // 调度器已配置为 auto-publish 模式不重试，避免重跑 engine 浪费钱。
      console.error(`  ❌ 自动发布失败: ${pubErr.message}`);
      await markFailed(sessionDir, '自动发布', pubErr);
      return 1;
    }
  } else if (autoPublish && accountName && !videoOk) {
    console.error('\n❌ 视频流程失败，跳过自动发布（没有可发布的 mp4）');
  }

  if (failures.length > 0) {
    // published 字段：即使部分环节失败，视频可能已经真的发出去了，
    // 上层（调度器/GUI）据此判断要不要重跑，避免重复发布
    await markFailed(sessionDir, failures.map(f => f.stage).join('+'), failures[0].err, { published: publishedOk });
    console.error(`\n❌ 结束但不完整：失败环节 ${failures.map(f => f.stage).join('、')} 📁 ${sessionDir}\n`);
    return 1;
  }

  console.log(`✅ 完成！📁 ${sessionDir}\n`);
  return 0;
}

// ⚠️ 旧实现是裸 main()：Promise 未 await、没有 catch，
//    reject 后进程可能以 exit 0 结束（正是 P1-4 的"失败也成功"）。P2-25
main()
  .then(code => {
    process.exitCode = typeof code === 'number' ? code : 0;
    // 兜底：若还有残留句柄把进程拖住，2 秒后强制退出（给 stdout 留出 flush 时间，
    // 否则调度器那边会看到被截断的日志）
    setTimeout(() => process.exit(process.exitCode || 0), 2000).unref();
  })
  .catch(err => {
    console.error('\n❌ 未捕获异常: ' + (err?.stack || err));
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 2000).unref();
  });

process.on('unhandledRejection', (reason) => {
  console.error('❌ unhandledRejection: ' + (reason?.stack || reason));
  process.exitCode = 1;
});

process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException: ' + (err?.stack || err));
  process.exitCode = 1;
});
