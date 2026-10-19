/**
 * 给成片加「开头封面卡」
 *
 * 用户实拍反馈（2026-10-18）：
 *   发出去的视频第一帧是全黑（分镜 fade-in 从黑起），TikTok 自动取的封面因此也是黑的，
 *   刷到的人完全不知道这条视频讲什么；而我们已经生成了一张很好的 封面.png
 *   （标题 + 一句话钩子 + CTA），却从来没被用上。
 *
 * 做法：把 封面.png 作为 1.6 秒的定格卡片拼到正片**最前面**（配静音，音画同步不挪时间轴）。
 *   - 第一帧 = 有标题的封面 → 平台自动封面 / 用户手动选封面都有内容；
 *   - 观众前 1.6 秒就看到「这条讲什么」，划走率下降；
 *   - 不改动正片本身的任何帧，失败时可完全回退（写临时文件再原子替换）。
 *
 * 只用 ffmpeg 滤镜，不依赖 Playwright，不会因为 TikTok 改版而失效。
 */
import path from 'path';
import fs from 'fs-extra';
import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

/** 找 ffmpeg：优先环境变量，其次 PATH */
function ffmpegBin() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

/**
 * 在视频前面拼一张封面定格卡（覆盖原文件，失败会抛错由调用方决定是否忽略）。
 *
 * @param {string} videoPath  正片路径（会被替换）
 * @param {string} coverPath  封面图路径（PNG/JPG）
 * @param {object} opts
 * @param {number} opts.seconds  卡片时长，默认 1.6s
 * @param {number} opts.fps      输出帧率，默认 25
 */
export async function prependCoverCard(videoPath, coverPath, { seconds = 1.6, fps = 25 } = {}) {
  if (!(await fs.pathExists(videoPath))) throw new Error(`正片不存在: ${videoPath}`);
  if (!(await fs.pathExists(coverPath))) throw new Error(`封面不存在: ${coverPath}`);

  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  const tmpOut = path.join(dir, `${base}.card.tmp.mp4`);

  // 卡片与正片都要统一成 1080x1920 / 25fps / yuv420p / 48k 立体声，
  // 否则 concat 滤镜会因为参数不一致直接失败。
  const filter = [
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=${fps},format=yuv420p[vcard]`,
    `[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[acard]`,
    `[2:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=${fps},format=yuv420p[vmain]`,
    `[2:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[amain]`,
    `[vcard][acard][vmain][amain]concat=n=2:v=1:a=1[v][a]`,
  ].join(';');

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-framerate', String(fps), '-t', String(seconds), '-i', coverPath,
    '-f', 'lavfi', '-t', String(seconds), '-i', 'anullsrc=r=48000:cl=stereo',
    '-i', videoPath,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    tmpOut,
  ];

  await run(ffmpegBin(), args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60 * 1000 });

  const st = await fs.stat(tmpOut);
  if (!st.size) {
    await fs.remove(tmpOut).catch(() => {});
    throw new Error('封面卡合成产出 0 字节');
  }

  // 原子替换：先备份原名再改名，任何一步失败都不会留下半截文件
  const bak = path.join(dir, `${base}.nocover.mp4`);
  await fs.move(videoPath, bak, { overwrite: true });
  try {
    await fs.move(tmpOut, videoPath, { overwrite: true });
  } catch (err) {
    await fs.move(bak, videoPath, { overwrite: true }).catch(() => {});
    throw err;
  }
  await fs.remove(bak).catch(() => {});
  return videoPath;
}
