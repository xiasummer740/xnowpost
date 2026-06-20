import { execSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { findFFmpeg, findEdgeTTS } from './tools.js';

const EDGE_TTS = `"${findEdgeTTS()}"`;
const FFMPEG = `"${findFFmpeg()}"`;

// 获取音频实际时长（秒）
function getAudioDuration(filePath) {
  try {
    const ffprobe = FFMPEG.replace(/ffmpeg\.exe"?$/, 'ffprobe.exe').replace(/"/g, '');
    const cmd = `"${ffprobe}" -v error -show_entries format=duration -of csv=p=0 "${filePath}"`;
    const result = execSync(cmd, { stdio: 'pipe', timeout: 10000, encoding: 'utf-8', windowsHide: true });
    return parseFloat(result.trim()) || 5;
  } catch (e) {
    return 5; // fallback 5秒
  }
}

export async function generateVoice(scenes, outputDir, lang = 'zh') {
  const voiceConfig = {
    zh: { voice: 'zh-CN-XiaoxiaoNeural', rate: '+10%' },
    en: { voice: 'en-US-JennyNeural', rate: '+10%' },
  };

  const config = voiceConfig[lang] || voiceConfig.zh;
  const voiceDir = path.join(outputDir, 'voice');
  await fs.ensureDir(voiceDir);

  // 为每个分镜生成语音 + 记录真实时长
  const clips = [];
  const durations = [];

  for (let i = 0; i < scenes.length; i++) {
    const text = lang === 'zh' ? scenes[i].scene_text_zh : scenes[i].scene_text_en;
    if (!text || text.trim() === '') {
      durations.push(5); // 无文本默认5秒
      continue;
    }

    const clipPath = path.join(voiceDir, `clip_${String(i + 1).padStart(2, '0')}_${lang}.mp3`);
    console.log(`  🔊 配音 ${i + 1}/${scenes.length}: ${text}`);

    const safeText = text.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    execSync(
      `${EDGE_TTS} --voice ${config.voice} --rate=${config.rate} --text "${safeText}" --write-media "${clipPath}"`,
      { stdio: 'pipe', timeout: 60000, windowsHide: true }
    );

    // 读取真实时长
    const dur = getAudioDuration(clipPath);
    // 加0.5秒间隙让字幕更自然
    durations.push(dur + 0.5);
    clips.push(clipPath);
  }

  if (clips.length === 0) {
    console.log('  ⚠️ 无有效配音文本，跳过');
    return { outputFile: null, durations: [] };
  }

  // 拼接所有片段
  let outputFile;
  if (clips.length === 1) {
    outputFile = path.join(outputDir, `voice_${lang}.mp3`);
    await fs.copyFile(clips[0], outputFile);
  } else {
    const concatList = clips.map(c => `file '${c.replace(/\\/g, '/')}'`).join('\n');
    const concatFile = path.join(voiceDir, `concat_${lang}.txt`);
    await fs.writeFile(concatFile, concatList, 'utf-8');

    outputFile = path.join(outputDir, `voice_${lang}.mp3`);
    if (fs.existsSync(outputFile)) await fs.remove(outputFile);

    execSync(
      `${FFMPEG} -y -f concat -safe 0 -i "${concatFile}" -c copy "${outputFile}"`,
      { stdio: 'pipe', timeout: 30000, windowsHide: true }
    );
  }

  console.log(`  ✅ 配音完成: ${outputFile} (${durations.length}段)`);
  return { outputFile, durations };
}
