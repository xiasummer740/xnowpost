import { execSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { generateVoice } from './voice.js';
import { getPlatformConfig } from '../platforms/index.js';
import { findFFmpeg } from './tools.js';

const FFMPEG = findFFmpeg();

function formatAssTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2,'0')}:${(s%60).toFixed(2).padStart(5,'0')}`;
}

// durations: 每段真实语音时长（秒）
function createAss(scenes, outPath, w, h, lang, durations) {
  // 竖屏字体比横屏大，但都不能太大避免溢出
  const isPortrait = w < h;
  const fontSize = Math.round(isPortrait ? 36 : 28);
  // 左右边距给足，防止长文本戳出屏幕
  const marginLR = Math.round(w * 0.08);  // 8% 画面宽度
  // 底部边距
  const marginV = Math.round(h * 0.06);

  let ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nScaledBorderAndShadow: yes\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: ZH,Microsoft YaHei,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,3,3,1,2,${marginLR},${marginLR},${marginV},1\nStyle: EN,Arial,${Math.round(fontSize * 0.85)},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,3,2,1,2,${marginLR},${marginLR},${Math.round(marginV * 0.8)},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  let t = 0;
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const d = (durations && durations[i]) || s.duration || 7;
    const se = formatAssTime(t), ee = formatAssTime(t + d);
    // 对过长的文本做裁剪，避免一行超出屏幕
    let zhText = (s.scene_text_zh || '').replace(/[&{}]/g, '');
    let enText = (s.scene_text_en || '').replace(/[&{}]/g, '');
    // 英文超过 60 字符自动插入换行
    if (enText.length > 60) {
      const words = enText.split(' ');
      let line = '', result = [];
      for (const word of words) {
        if ((line + ' ' + word).length > 35) { result.push(line); line = word; }
        else line = line ? line + ' ' + word : word;
      }
      if (line) result.push(line);
      enText = result.join('\\N');
    }
    if (zhText && /zh|cn/.test(lang)) ass += `Dialogue: 0,${se},${ee},ZH,,0,0,0,,${zhText}\n`;
    if (enText && /en/.test(lang)) ass += `Dialogue: 0,${se},${ee},EN,,0,0,0,,${enText}\n`;
    t += d;
  }
  fs.writeFileSync(outPath, ass, 'utf-8');
  return outPath.replace(/\\/g, '/');
}

async function synthOne({ dirPath, outputPath, pkey, config, voicePath, scenes, durations }) {
  const { width, height } = config.video;
  const subLang = config.subtitleLang || 'cn+en';

  // 用真实时长生成字幕
  const assFile = createAss(scenes, path.join(dirPath, `sub_${pkey}.ass`), width, height, subLang, durations);
  const assRel = path.basename(assFile);

  // conat 文件用真实时长
  const sd = path.join(dirPath, 'slides');
  const concatLines = scenes.map((s, i) => {
    const d = (durations && durations[i]) || s.duration || 7;
    return `file '${path.join(sd, `scene_${String(i+1).padStart(2,'0')}.png`).replace(/\\/g,'/')}'\nduration ${d.toFixed(1)}`;
  });
  concatLines.push(`file '${path.join(sd, `scene_${String(scenes.length).padStart(2,'0')}.png`).replace(/\\/g,'/')}'`);
  const concatFile = path.join(dirPath, `concat_${pkey}.txt`);
  fs.writeFileSync(concatFile, concatLines.join('\n'), 'utf-8');

  // 先输出到 _video 内的临时文件，成功后再 move 到最终位置
  // 防止进程被杀留下残缺 MP4（moov atom not found）
  const finalOutput = outputPath || path.join(dirPath, `video_${pkey}.mp4`);
  const tmpOutput = path.join(dirPath, `video_${pkey}_tmp.mp4`);
  const ff = FFMPEG.replace(/\\/g, '/');
  const voiceRel = path.basename(voicePath);

  // stderr: 'ignore' → 不经过管道，防止 Windows 管道缓冲区写阻塞死锁
  // FFmpeg 输出大量编码日志(~8KB) 超过默认管道缓冲区(4KB)
  // 不使用 bat 文件中转，直接 execSync 调用 FFmpeg
  const ffCmd = `"${ff}" -y -f concat -safe 0 -i "concat_${pkey}.txt" -i "${voiceRel}" -vf "fps=24,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,subtitles=${assRel}" -map 0:v -map 1:a -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest "${tmpOutput}"`;

  console.log(`  🎥 ${pkey}...`);
  try {
    execSync(ffCmd, { cwd: dirPath, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, timeout: 10 * 60 * 1000 });
    if (fs.existsSync(tmpOutput) && fs.statSync(tmpOutput).size > 0) {
      // 只在这步才移动到最终位置——进程被杀时临时文件随 _video 一起清理
      await fs.move(tmpOutput, finalOutput, { overwrite: true });
      console.log(`  ✅ ${path.basename(finalOutput)} (${(fs.statSync(finalOutput).size/1024/1024).toFixed(1)}MB)`);
      return finalOutput;
    }
    console.log(`  ⚠️ ffmpeg 执行完成但未生成文件`);
  } catch (err) {
    console.error(`  ❌ ${pkey}: ${err.message}`);
  }
  return null;
}

export async function synthesizeAllPlatforms(dirPath, content, outputPath) {
  console.log(`  🎬 视频合成...`);

  // 根据平台配置选择配音语言
  const tkConfig = getPlatformConfig('tiktok');
  const lang = tkConfig?.subtitleLang?.includes('en') ? 'en' : 'zh';

  const voiceResult = await generateVoice(content.scenes, dirPath, lang);
  if (!voiceResult || !voiceResult.outputFile) { console.log('  ⚠️ 配音失败'); return null; }

  const { outputFile: voicePath, durations } = voiceResult;

  // 用真实时长覆盖 content.scenes 中的 duration
  const scenes = content.scenes.map((s, i) => ({
    ...s,
    duration: durations[i] || s.duration || 7,
  }));

  const result = await synthOne({
    dirPath, outputPath, pkey: 'tiktok', config: tkConfig,
    voicePath, scenes, durations,
  });

  return result;
}
