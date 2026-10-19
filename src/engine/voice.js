import { spawnSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { findFFmpeg, findFFprobe, findEdgeTTS } from './tools.js';
import { getVoiceConfig } from './config.js';
import { writeFileAtomic } from '../fs-atomic.js';

// ⚠️ 这里只保存可执行文件路径本身，绝不拼成 shell 字符串：
//    LLM 生成的文案会原样作为 --text 的**参数值**传给 edge-tts。
//    旧实现把文案转义后拼进 cmd.exe 命令行（`\"`），但 cmd.exe 不把 `\` 当转义符，
//    英文引号会直接闭合引号，`%VAR%` / `&` / `|` / `>` 也照样生效 →
//    文案里出现引号或 % 就会破坏合成甚至注入命令（P1-7）。
const FFMPEG = findFFmpeg();
const FFPROBE = findFFprobe();
const EDGE_TTS = findEdgeTTS();

// 每段配音之后插入的静音时长（秒）。
// 字幕/画面时钟按「配音时长 + 静音」推进，音频里就必须真的有这段静音，
// 否则每段漂移 0.5s、越往后错得越多（P2-21）。
export const SCENE_GAP_SEC = 0.5;

/** 无文本分镜占用的时间轴长度（秒） */
const EMPTY_SCENE_SEC = 5;

/**
 * 统一的子进程调用：参数数组 + shell:false + windowsHide:true
 * - shell:false → 参数不经过 cmd.exe，注入面彻底消失
 * - windowsHide:true → 绝不弹 CMD 窗口（CLAUDE.md 硬规则）
 */
function runTool(exe, args, { timeout = 120000, label = '', cwd } = {}) {
  const name = label || path.basename(String(exe));
  const r = spawnSync(exe, args, {
    windowsHide: true,
    shell: false,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    ...(cwd ? { cwd } : {}),
  });
  if (r.error) {
    throw new Error(`${name} 启动失败: ${r.error.message} (${exe})`);
  }
  if (r.status !== 0) {
    const errText = String(r.stderr || '').trim().split('\n').slice(-3).join(' | ');
    throw new Error(`${name} 退出码 ${r.status}${errText ? `: ${errText}` : ''}`);
  }
  return String(r.stdout || '').trim();
}

// 获取音频实际时长（秒）
// ⚠️ 不再静默回退 5 秒：时长同时决定字幕时间轴和画面时长，
//    猜错会让整个视频声画错位，因此失败必须抛错（由上层记录并中止）
// 导出给 video.js 做"音频时长 ≈ 字幕时间轴"的运行时自检
export function getAudioDuration(filePath) {
  const out = runTool(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    filePath,
  ], { timeout: 10000, label: 'ffprobe' });
  const dur = parseFloat(out);
  if (!Number.isFinite(dur) || dur <= 0) {
    throw new Error(`ffprobe 未能解析音频时长: "${out}" (${path.basename(filePath)})`);
  }
  return dur;
}

export async function generateVoice(scenes, outputDir, lang = 'zh') {
  const config = getVoiceConfig(lang);
  const voiceDir = path.join(outputDir, 'voice');
  await fs.ensureDir(voiceDir);

  // 静音片段按长度缓存（段间 0.5s / 无文本分镜整段），只生成一次
  const silenceCache = new Map();
  const silenceFor = async (seconds) => {
    const key = seconds.toFixed(3);
    if (silenceCache.has(key)) return silenceCache.get(key);
    const file = path.join(voiceDir, `silence_${key.replace('.', '_')}.mp3`);
    if (!fs.existsSync(file)) {
      runTool(FFMPEG, [
        '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
        '-t', key, '-c:a', 'libmp3lame', '-b:a', '48k', file,
      ], { timeout: 30000, label: 'ffmpeg(生成静音)' });
    }
    silenceCache.set(key, file);
    return file;
  };

  // 为每个分镜生成语音 + 记录真实时长
  const durations = [];   // 每段占用的时间轴长度（= 配音时长 + 段间静音）
  const parts = [];       // 参与拼接的音频片段（按时间轴顺序）

  for (let i = 0; i < scenes.length; i++) {
    const text = lang === 'zh' ? scenes[i].scene_text_zh : scenes[i].scene_text_en;

    if (!text || text.trim() === '') {
      // ⚠️ 旧实现只 push 5 秒时长却**不产出任何音频**，
      //    导致后续字幕/画面比音频快 5 秒 —— 现在补一段等长静音。
      parts.push(await silenceFor(EMPTY_SCENE_SEC));
      durations.push(EMPTY_SCENE_SEC);
      continue;
    }

    const clipPath = path.join(voiceDir, `clip_${String(i + 1).padStart(2, '0')}_${lang}.mp3`);
    console.log(`  🔊 配音 ${i + 1}/${scenes.length}: ${text}`);

    // 文案作为单个 argv 参数传递：无论里面有引号、%VAR%、& 还是 | 都不会被解释
    runTool(EDGE_TTS, [
      '--voice', config.voice,
      `--rate=${config.rate}`,
      '--text', text,
      '--write-media', clipPath,
    ], { timeout: 60000, label: 'edge-tts' });

    const dur = getAudioDuration(clipPath);
    parts.push(clipPath);
    parts.push(await silenceFor(SCENE_GAP_SEC));   // 真的把 0.5s 静音写进音频
    durations.push(dur + SCENE_GAP_SEC);
  }

  if (parts.length === 0) {
    console.log('  ⚠️ 没有可配音的分镜，跳过');
    return { outputFile: null, durations: [] };
  }

  // 拼接所有片段（含静音）→ 音频总长 = 各段时间轴之和
  const outputFile = path.join(outputDir, `voice_${lang}.mp3`);
  const listName = `concat_${lang}.txt`;
  // 用相对文件名 + cwd：绝对路径里的空格/引号不会进入 concat 列表
  const listBody = parts.map(p => `file '${path.basename(p)}'`).join('\n');
  await writeFileAtomic(path.join(voiceDir, listName), listBody, 'utf-8');

  if (fs.existsSync(outputFile)) await fs.remove(outputFile);

  const total = durations.reduce((s, d) => s + d, 0);
  // -af apad + -t total：把音频精确压到时间轴长度（短了补静音，长了截断），
  // 这样"字幕/画面时钟 == 音频长度"是硬保证，而不是靠估算。
  runTool(FFMPEG, [
    '-y', '-f', 'concat', '-safe', '0', '-i', listName,
    '-af', 'apad', '-t', total.toFixed(3),
    '-c:a', 'libmp3lame', '-b:a', '48k', '-ar', '24000', '-ac', '1',
    outputFile,
  ], { cwd: voiceDir, timeout: 180000, label: 'ffmpeg(拼接配音)' });

  console.log(`  ✅ 配音完成: ${outputFile} (${durations.length}段, 音频总长 ${total.toFixed(1)}s)`);
  return { outputFile, durations };
}
