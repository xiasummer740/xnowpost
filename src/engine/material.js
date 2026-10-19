// 全网素材搜索（Pexels 免费 API）
//
// 状态说明：本模块的 searchPhotos / searchVideos / downloadMaterial 由上一任开发者写好，
// 但**没有任何文件调用过它们** —— 等于半成品。这里补上：
//   1. Key 解析：环境变量 → 「设置」里的 config/user.json（原来只读 env，
//      导致界面里填了 Key 也不生效）
//   2. 占位符识别：user.json 里曾出现「拿到 Key 再填」这种中文占位符，
//      必须当成"未配置"，否则会拿它去请求
//   3. fetchBrollForScenes()：按分镜关键词取真实拍摄的竖屏视频片段，带本地缓存
//
// 为什么用实拍素材而不是 AI 文生视频：30 秒成片若用 AI 文生视频，
// 按 ¥0.3~1/秒 计约 ¥9~30/条；实拍素材库免费且是有真实镜头运动的画面。
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { spawnSync } from 'child_process';
import { dataPath } from '../paths.js';
import { looksLikePlaceholder } from './apikey.js';
import { findFFmpeg } from './tools.js';

const PEXELS_BASE = 'https://api.pexels.com';

/**
 * 解析 Pexels Key。
 * 优先级：环境变量 > 用户配置。占位符一律视为未配置。
 */
export function resolvePexelsKey() {
  const fromEnv = String(process.env.PEXELS_API_KEY || '').trim();
  if (fromEnv) {
    if (looksLikePlaceholder(fromEnv)) {
      return { ok: false, reason: 'PEXELS_API_KEY 是占位符' };
    }
    return { ok: true, key: fromEnv, source: 'env' };
  }
  try {
    const userFile = dataPath('config', 'user.json');
    if (fs.existsSync(userFile)) {
      const raw = fs.readJsonSync(userFile);
      const v = String(raw?.pexelsApiKey || '').trim();
      if (v && !looksLikePlaceholder(v)) {
        return { ok: true, key: v, source: 'config' };
      }
      if (v) return { ok: false, reason: '设置里的 Pexels Key 是占位符' };
    }
  } catch (e) {
    return { ok: false, reason: `读取配置失败: ${e.message}` };
  }
  return { ok: false, reason: '未配置 Pexels Key' };
}

function authHeaders() {
  const r = resolvePexelsKey();
  return r.ok ? { Authorization: r.key } : null;
}

// 搜索真实图片
export async function searchPhotos(query, { perPage = 5, orientation = 'portrait' } = {}) {
  const headers = authHeaders();
  if (!headers) {
    console.log('  📷 Pexels Key 未配置，跳过素材搜索');
    return [];
  }
  try {
    const resp = await axios.get(`${PEXELS_BASE}/v1/search`, {
      headers,
      params: { query, per_page: perPage, orientation, size: 'large' },
      timeout: 15000,
    });
    return (resp.data?.photos || []).map(p => ({
      id: p.id,
      url: p.src?.large2x || p.src?.original,
      photographer: p.photographer,
      width: p.width,
      height: p.height,
      avgColor: p.avg_color,
    }));
  } catch (e) {
    console.log(`  ⚠️ Pexels 搜索失败: ${e.message}`);
    return [];
  }
}

/**
 * 从 Pexels 的 video_files 里挑一个文件。
 *
 * 原则：**够用且最小**。输出是 1080x1920，下 2160x3840 的 4K 毫无收益
 * （实测 4K 单镜 16~24MB，9 镜 = 150MB+ 无谓下载）。
 * 没有够用的竖屏文件时，退而求其次取最大的竖屏；再不行取任意 hd。
 */
export function pickBestVideoFile(files) {
  const list = Array.isArray(files) ? files.filter(f => f && f.link) : [];
  if (!list.length) return null;
  const portrait = list.filter(f => (f.height || 0) >= (f.width || 0));
  const enough = portrait.filter(f => f.height >= 1920 && f.width >= 1080);
  const area = (f) => (f.width || 0) * (f.height || 0);
  if (enough.length) {
    // 满足分辨率的前提下，选像素最少的（下载最快、转码最省）
    return [...enough].sort((a, b) => area(a) - area(b))[0];
  }
  if (portrait.length) {
    return [...portrait].sort((a, b) => area(b) - area(a))[0];
  }
  return list.find(f => f.quality === 'hd') || list[0];
}

/**
 * 搜索真实视频。
 * 每个结果已挑选出该素材里最合适的一个文件（优先竖屏、够用且最小）。
 */
export async function searchVideos(query, { perPage = 5, orientation = 'portrait' } = {}) {
  const headers = authHeaders();
  if (!headers) {
    console.log('  🎥 Pexels Key 未配置，跳过视频搜索');
    return [];
  }
  try {
    const resp = await axios.get(`${PEXELS_BASE}/videos/search`, {
      headers,
      params: { query, per_page: perPage, orientation, size: 'large' },
      timeout: 20000,
    });
    return (resp.data?.videos || []).map(v => {
      const best = pickBestVideoFile(v.video_files);
      return {
        id: v.id,
        url: best?.link,
        duration: v.duration,
        width: best?.width,
        height: best?.height,
        photographer: v.user?.name,
      };
    }).filter(v => v.url);
  } catch (e) {
    console.log(`  ⚠️ Pexels 视频搜索失败: ${e.message}`);
    return [];
  }
}

// 下载素材到本地
export async function downloadMaterial(url, filepath) {
  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 90000,
      maxContentLength: 200 * 1024 * 1024,
    });
    await fs.ensureDir(path.dirname(filepath));
    await fs.writeFile(filepath, Buffer.from(resp.data));
    console.log(`  📥 素材下载: ${path.basename(filepath)} (${(resp.data.length / 1024).toFixed(0)}KB)`);
    return filepath;
  } catch (e) {
    console.log(`  ⚠️ 下载失败: ${e.message}`);
    return null;
  }
}

/**
 * 按每个分镜的 broll_keywords 取真实拍摄片段，存成 broll/scene_XX.mp4。
 *
 * 全部失败也不影响出片：合成时会自动回退到 AI 静态图 + 运镜。
 * @returns {{ok: boolean, fetched: number, total: number, reason?: string}}
 */
export async function fetchBrollForScenes(dirPath, scenes, { minBytes = 60 * 1024, skipIndices = [] } = {}) {
  const keyInfo = resolvePexelsKey();
  if (!keyInfo.ok) {
    return { ok: false, fetched: 0, total: scenes.length, indices: [], reason: keyInfo.reason };
  }

  const skip = new Set(skipIndices);
  const outDir = path.join(dirPath, 'broll');
  await fs.ensureDir(outDir);
  const indices = [];

  for (let i = 0; i < scenes.length; i++) {
    if (skip.has(i)) continue; // 该镜要交给图生视频，不要浪费一次搜索/下载
    const name = `scene_${String(i + 1).padStart(2, '0')}.mp4`;
    const dest = path.join(outDir, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > minBytes) {
      indices.push(i); // 已有缓存，不重复下载
      continue;
    }
    const keywords = String(scenes[i]?.broll_keywords || '').trim();
    if (!keywords) {
      console.log(`  ⚠️ 分镜 ${i + 1} 没有 broll_keywords，将使用 AI 图`);
      continue;
    }

    const hits = await searchVideos(keywords, { perPage: 5 });
    if (!hits.length) {
      console.log(`  ⚠️ 分镜 ${i + 1} 没搜到实拍素材（关键词: ${keywords}）→ 回退 AI 图`);
      continue;
    }
    // 优先时长够用的，其次画幅最大的
    const wanted = Math.max(4, Number(scenes[i]?.duration) || 6);
    const ranked = [...hits].sort((a, b) => {
      const aEnough = (a.duration || 0) >= wanted ? 1 : 0;
      const bEnough = (b.duration || 0) >= wanted ? 1 : 0;
      if (aEnough !== bEnough) return bEnough - aEnough;
      return (b.height || 0) - (a.height || 0);
    });

    const saved = await downloadMaterial(ranked[0].url, dest);
    if (saved && fs.statSync(saved).size > minBytes) {
      indices.push(i);
      console.log(`  🎞️ 分镜 ${i + 1} 实拍素材: "${keywords}" (${ranked[0].width}x${ranked[0].height}, ${ranked[0].duration}s)`);
    } else {
      await fs.remove(dest).catch(() => {});
      console.log(`  ⚠️ 分镜 ${i + 1} 素材下载不完整 → 回退 AI 图`);
    }
  }

  // indices 让上游知道"哪几镜已经有实拍素材"，这些镜就不必再花钱生图
  return { ok: indices.length > 0, fetched: indices.length, total: scenes.length, indices };
}

/**
 * 用户自带截图 → 视频画面（"我提供截图，按截图生成视频"）。
 *
 * 为什么需要：Pexels 图库再像也不是自己的产品 —— 卖课程的人需要自己的
 * 后台截图、学员反馈、收款页面。这些只有用户自己有。
 *
 * 规则：
 *   - 图片按**文件名自然序**（1,2,10 而不是 1,10,2）依次对应分镜
 *   - 图比镜头少 → 循环使用；图比镜头多 → 多余的不用
 *   - 统一预缩放并居中裁切到成片尺寸，横屏截图也不会留黑边
 *   - 任何一张失败只跳过该镜，不影响其余分镜
 */
/**
 * 挑出"用截图"的分镜下标。
 * 规则：跳过第 1 镜（开场留给会动的画面），其余均匀分布。
 * 只中少数几镜是有意的 —— 一张图铺满全片就成了图片幻灯片，不像视频。
 */
function pickTargets(total, count) {
  if (count <= 0) return [];
  const pool = [];
  for (let i = 1; i < total; i++) pool.push(i);
  if (!pool.length) pool.push(0);           // 只有 1 镜时只能用第 1 镜
  if (count >= pool.length) return pool.slice();
  const step = pool.length / count;
  const out = [];
  for (let k = 0; k < count; k++) {
    out.push(pool[Math.min(pool.length - 1, Math.floor(k * step + step / 2))]);
  }
  return [...new Set(out)];
}

export async function attachUserMaterials(dirPath, materialsDir, sceneCount, {
  width = 1080, height = 1920, maxScenes = 2,
} = {}) {
  if (!materialsDir) return { ok: false, indices: [], reason: '未设置素材目录' };

  const exts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
  let files = [];

  // 两种来源：
  //   1) 数组 = 本次生成时在控制台当场选的图片（XNOWPOST_USER_IMAGES）
  //   2) 字符串 = 设置里长期指定的素材目录
  if (Array.isArray(materialsDir)) {
    files = materialsDir
      .filter(f => typeof f === 'string' && exts.has(path.extname(f).toLowerCase()))
      .filter(f => fs.existsSync(f))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'zh-CN', { numeric: true }));
    if (!files.length) return { ok: false, indices: [], reason: '本次选的图片都不存在或格式不支持' };
  } else {
    const abs = path.resolve(String(materialsDir));
    if (!fs.existsSync(abs)) return { ok: false, indices: [], reason: `素材目录不存在: ${abs}` };
    try {
      files = fs.readdirSync(abs)
        .filter(f => exts.has(path.extname(f).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
        .map(f => path.join(abs, f));
    } catch (e) {
      return { ok: false, indices: [], reason: `读取素材目录失败: ${e.message}` };
    }
    if (!files.length) {
      return { ok: false, indices: [], reason: `素材目录里没有图片（支持 png/jpg/jpeg/webp/bmp）: ${abs}` };
    }
  }
  const sourceLabel = Array.isArray(materialsDir)
    ? `本次选择的 ${files.length} 张图片`
    : path.resolve(String(materialsDir));

  const ffmpeg = findFFmpeg();
  if (!ffmpeg) return { ok: false, indices: [], reason: '找不到 ffmpeg，无法处理用户素材' };

  const slidesDir = path.join(dirPath, 'slides');
  await fs.ensureDir(slidesDir);
  const indices = [];
  // ⚠️ 用户截图必须**完整可见**，绝不能裁切。
  // 以前用 force_original_aspect_ratio=increase + crop，等于把图放大到铺满
  // 再剪掉多余部分：一张 1040x701 的横屏截图会被放大 2.7 倍、只留中间一条竖条，
  // 观众看到的是残缺的碎片（已踩过）。
  // 现在：整张图等比缩到能放下（decrease），四周用**同一张图的高斯模糊**填满，
  // 既保证信息完整，又不会出现难看的黑边。
  //
  // 另外留 10% 安全边距（按 0.9 倍尺寸摆放）：合成阶段会给这些镜加一点点缩放
  // 让画面"活起来"，有了这圈边距，放大 5% 也不会切到截图本身。
  const fitW = Math.round(width * 0.9);
  const fitH = Math.round(height * 0.9);
  const filter = [
    `[0:v]scale=${fitW}:${fitH}:force_original_aspect_ratio=decrease[fg]`,
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},gblur=sigma=40,eq=brightness=-0.15[bg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[out]`,
  ].join(';');

  // 截图只放在少数几镜里当"证据"，其余分镜交给实拍素材 / AI 图 —— 
  // 之前是把一张图循环铺满 9 镜，整条视频等于静态截图轮播，用户直接质疑
  // "你怎么没自己生成视频"。
  const useCount = Math.min(files.length, Math.max(1, maxScenes), sceneCount);
  const targets = pickTargets(sceneCount, useCount);
  if (targets.length < sceneCount) {
    console.log(
      `  🖼️ 截图将用于第 ${targets.map(i => i + 1).join('、')} 镜（共 ${sceneCount} 镜，其余用实拍/AI 画面）`
    );
  }

  for (let k = 0; k < targets.length; k++) {
    const i = targets[k];
    const src = files[k % files.length];
    const dest = path.join(slidesDir, `scene_${String(i + 1).padStart(2, '0')}.png`);
    const r = spawnSync(ffmpeg, [
      '-y', '-i', src, '-filter_complex', filter, '-map', '[out]',
      '-frames:v', '1', dest,
    ], {
      windowsHide: true,   // 项目硬规则：绝不允许弹 CMD 窗口
      timeout: 60000,
      stdio: 'ignore',
    });
    if (r.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
      indices.push(i);
    } else {
      console.log(`  ⚠️ 用户素材第 ${i + 1} 镜处理失败: ${path.basename(src)}`);
    }
  }

  // 告诉合成阶段：这些镜是"用户的完整截图"，不要加运镜（加了会重新裁掉边缘）
  try {
    await fs.writeJson(path.join(slidesDir, 'user-manifest.json'), { indices }, { spaces: 0 });
  } catch (_) { /* 写不了也不影响出片 */ }

  return {
    ok: indices.length > 0,
    indices,
    total: sceneCount,
    source: sourceLabel,
    fileCount: files.length,
    reason: indices.length ? undefined : '所有图片都处理失败',
  };
}
