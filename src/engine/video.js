import { spawnSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { generateVoice, getAudioDuration } from './voice.js';
import { getPlatformConfig } from '../platforms/index.js';
import { findFFmpeg } from './tools.js';
import { getVideoStyleConfig, getEngineConfig } from './config.js';
import { resolveCodeRoot } from '../paths.js';

const FFMPEG = findFFmpeg();

// 成片帧率：25 兼顾流畅与编码速度（24~30 都行，25 在 1080x1920 上最快）
export const FPS = 25;
// 运镜幅度 12%：足够有"活着"的感觉，又不会把画面边缘的文字切掉
export const MOTION_AMPLITUDE = 0.12;

/**
 * 每段片长。
 *
 * 关键点：xfade 会"吃掉"重叠时间。若每段都按配音时长给，转场会让成片变短
 * （9 镜 × 0.5s = 少 4 秒），配音与画面对不上，最后一句会被 -shortest 截掉。
 * 所以除最后一段外，每段多给一个转场时长，重叠后再扣回来，总长恰好等于配音。
 */
export function clipLengths(durations, transitionSec) {
  const T = Math.max(0, Number(transitionSec) || 0);
  const ds = durations.map(d => Math.max(0.5, Number(d) || 0.5));
  return ds.map((d, i) => Number((i < ds.length - 1 ? d + T : d).toFixed(3)));
}

/** 第 k 个 xfade 的 offset（相对累积时间轴） */
export function transitionOffsets(lengths, transitionSec) {
  const T = Math.max(0, Number(transitionSec) || 0);
  const offsets = [];
  let acc = 0;
  for (let k = 0; k < lengths.length - 1; k++) {
    acc += lengths[k];
    offsets.push(Number((acc - k * T - T).toFixed(3)));
  }
  return offsets;
}

/** 我们的 transition 语义 → FFmpeg xfade 的 transition 名 */
export function xfadeName(transition) {
  const map = {
    cut: 'fade',
    fade: 'fade',
    zoom: 'zoomin',
    slide: 'slideleft',
    dissolve: 'dissolve',
  };
  return map[String(transition || '').trim().toLowerCase()] || 'fade';
}

/**
 * 单个分镜的运镜滤镜（把静态图变成有镜头运动的画面）。
 *
 * 依据模型已经输出的 camera_move 字段 —— 这个字段以前只喂给生图提示词，
 * 合成时完全没用，所以成片看起来就是"PPT 翻页"。
 */
export function motionFilterFor(cameraMove, { width, height, clipSec, amplitude = MOTION_AMPLITUDE }) {
  const W = Math.round(width);
  const H = Math.round(height);
  const D = Math.max(0.5, Number(clipSec) || 0.5).toFixed(2);
  const ramp = `min(t/${D},1)`;
  const A = amplitude;
  const Z = (1 + A).toFixed(2);

  // 先归一化到精确尺寸，再做运动，避免不同来源比例的图被拉伸
  const normalize = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
  const center = `crop=${W}:${H}:x='(iw-${W})/2':y='(ih-${H})/2'`;
  const zoomIn = `scale=w='iw*(1+${A}*${ramp})':h='ih*(1+${A}*${ramp})':eval=frame:flags=lanczos,${center}`;
  const zoomOut = `scale=w='iw*(${Z}-${A}*${ramp})':h='ih*(${Z}-${A}*${ramp})':eval=frame:flags=lanczos,${center}`;
  // 平移/上下摇用固定放大画布 + crop 位移，比逐帧 scale 快很多
  const panCanvas = `scale=${Math.round(W * (1 + A))}:${Math.round(H * (1 + A))}:flags=lanczos`;
  const panLr = `${panCanvas},crop=${W}:${H}:x='(iw-${W})*${ramp}':y='(ih-${H})/2'`;
  const tiltDown = `${panCanvas},crop=${W}:${H}:x='(iw-${W})/2':y='(ih-${H})*${ramp}'`;
  const tiltUp = `${panCanvas},crop=${W}:${H}:x='(iw-${W})/2':y='(ih-${H})*(1-${ramp})'`;

  const motion = {
    push: zoomIn,
    pull: zoomOut,
    pan: panLr,
    tilt_down: tiltDown,
    tilt_up: tiltUp,
    static: 'null',
  }[String(cameraMove || '').toLowerCase()] || zoomIn;

  return `${normalize},${motion}`;
}

/** 扫描 assets/bgm 里的配乐，随机取一首；没有就返回 null（不影响出片） */
export function pickBgmFile() {
  try {
    const dir = path.join(resolveCodeRoot(), 'assets', 'bgm');
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir)
      .filter(f => /\.(mp3|m4a|aac|wav|ogg)$/i.test(f))
      .map(f => path.join(dir, f));
    if (!files.length) return null;
    return files[Math.floor(Math.random() * files.length)];
  } catch (_) {
    return null;
  }
}

function formatAssTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2,'0')}:${(s%60).toFixed(2).padStart(5,'0')}`;
}

/**
 * 从平台的 subtitleLang 推导**配音语言**（P2-9）
 *
 * 旧实现是 `subtitleLang.includes('en') ? 'en' : 'zh'`，
 * 而 TikTok 配置是 'cn+en' → includes('en') 成立 → 中文内容配英文音，
 * 且因为 lang 被判成 'en'，中文字幕也被一起丢掉。
 * 规则：含 cn/zh → 中文配音优先；否则含 en → 英文；都没有 → 中文。
 */
export function pickVoiceLang(subtitleLang) {
  const s = String(subtitleLang || '').toLowerCase();
  if (/cn|zh|chinese|中文/.test(s)) return 'zh';
  if (/en|english|英文/.test(s)) return 'en';
  return 'zh';
}

/**
 * 中文字幕折行。
 * ASS 里 WrapStyle=2 表示**不自动换行**，只有 `\N` 才换行，
 * 所以长文案必须自己折行，否则会直接戳出屏幕。
 * 每行最多 maxCharsPerLine 个字符，最多 maxLines 行，超出部分截断并加省略号。
 */
export function wrapCjk(text, maxCharsPerLine = 16, maxLines = 3) {
  if (!text) return '';
  const chars = [...text];
  const lines = [];
  for (let i = 0; i < chars.length; i += maxCharsPerLine) {
    lines.push(chars.slice(i, i + maxCharsPerLine).join(''));
  }
  if (lines.length <= maxLines) return lines.join('\\N');
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = kept[maxLines - 1].slice(0, maxCharsPerLine - 1) + '…';
  return kept.join('\\N');
}

/** 英文按词折行（每行约 35 字符），避免一行超出画面 */
/**
 * 折行时**不切断 ASS 标记**（v1.6.46）。
 *
 * 踩过的坑：先折行再染色，关键词正好被折在 `\N` 两侧 → `includes(kw)` 找不到 → 不染色。
 * 实测 7 镜只染上 2 镜。现在改成**先染色再折行**，并且折行时把 `{...}` 当作零宽、不可分割，
 * 保证 `{\1c&H5B2EFF&}` 这类标记永远不会被劈开。
 */
export function wrapCjkTagged(text, maxCharsPerLine = 16, maxLines = 3) {
  if (!text) return '';
  const out = [];      // 输出片段（可见字符 + 原样标记）
  let visible = 0;     // 当前行已占的可见字数
  let lines = 1;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      const end = text.indexOf('}', i);
      const tag = end === -1 ? text.slice(i) : text.slice(i, end + 1);
      out.push(tag);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (visible >= maxCharsPerLine) {
      if (lines >= maxLines) {
        out.push('…');
        return out.join('');
      }
      out.push('\\N');
      visible = 0;
      lines += 1;
    }
    const ch = [...text.slice(i)][0];
    out.push(ch);
    visible += 1;
    i += ch.length;
  }
  let result = out.join('');
  // 孤字兜底：只剩 1~3 个字被挤到第二行（"…不用密" / "码"）比超出一两个像素更难看。
  // 只要总字数只多出 1~2 个、而且正好两行，就直接并成一行。
  const segs = result.split('\\N');
  if (segs.length === 2) {
    const visibleOf = (s) => s.replace(/\{[^}]*\}/g, '').length;
    if (visibleOf(segs[1]) <= 3 && visibleOf(segs[0]) + visibleOf(segs[1]) <= maxCharsPerLine + 3) {
      result = segs.join('');
    }
  }
  return result;
}
export function wrapEn(text, maxCharsPerLine = 35) {
  if (!text) return '';
  const words = text.split(' ');
  const out = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).length > maxCharsPerLine) { out.push(line); line = word; }
    else line = line ? line + ' ' + word : word;
  }
  if (line) out.push(line);
  return out.join('\\N');
}

export function createAssForTest(...a) {
  return createAss(...a);
}

// durations: 每段占用的时间轴长度（秒，含段间静音）
function createAss(scenes, outPath, w, h, lang, durations) {
  // 2026-10-20（v1.6.46）：字幕重做，三处改动都是从样片实测来的 ——
  //  ① 36px 在手机上基本看不清（用户旧片截图放大才勉强认得字）→ 竖屏 60px；
  //  ② 英文原来缩到 0.85 倍当"注解"，中英不对等 → 中英**同字号**双行；
  //  ③ 位置从居中偏下挪到**下三分之一安全区**（TikTok 底部有文案/按钮遮挡）。
  const style = getVideoStyleConfig();
  const isPortrait = w < h;
  const fontSize = isPortrait
    ? Math.round(style.subtitle?.zhSize || 60)
    : Math.round((style.subtitle?.zhSize || 60) * 0.55);
  const enSize = isPortrait
    ? Math.round(style.subtitle?.enSize || fontSize)
    : Math.round((style.subtitle?.enSize || 60) * 0.55);
  // 左右边距给足，防止长文本戳出屏幕
  const marginLR = Math.round(w * 0.07);
  // 底部边距：中文在上、英文在下（同字号，两块各占一行距）
  const lineGap = Math.round(fontSize * 1.25);
  const marginVEn = Math.round(h * 0.27);
  const marginVZh = marginVEn + lineGap;

  let ass =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\n` +
    `ScaledBorderAndShadow: yes\nWrapStyle: 2\n\n[V4+ Styles]\n` +
    `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    // 描边 4 + 阴影 3：素材有亮有暗，细描边在浅色画面上会糊成一团
    `Style: ZH,Microsoft YaHei,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H90000000,1,0,0,0,100,100,1,0,1,4,3,2,${marginLR},${marginLR},${marginVZh},1\n` +
    `Style: EN,Arial,${enSize},&H00FFFFFF,&H000000FF,&H00000000,&H90000000,0,0,0,0,100,100,0,0,1,4,3,2,${marginLR},${marginLR},${marginVEn},1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  // lang 是平台的 subtitleLang（可能是 'cn+en'）：含 cn 出中文字幕，含 en 出英文字幕，
  // 两者都存在时**同时**输出两行（旧实现只会命中其中一种）
  const wantZh = /cn|zh|chinese|中文/.test(String(lang || '').toLowerCase());
  const wantEn = /en|english|英文/.test(String(lang || '').toLowerCase());

  // 可用宽度换算成一行能放多少字（WrapStyle=2 不自动换行，必须自己折）
  const usableW = w - marginLR * 2;
  const zhPerLine = Math.max(6, Math.floor(usableW / (fontSize * 0.92)));
  const enPerLine = Math.max(10, Math.floor(usableW / (enSize * 0.50)));
  // 行高（ASS 行距≈字号的 1.2 倍）与两块之间的间隙
  const lineH = Math.round(fontSize * 1.2);
  const blockGap = Math.round(fontSize * 0.35);
  // 中文块**底边**的绝对 y（从上算）：落在下三分之一、避开 TikTok 底部文案条
  const zhBottomY = Math.round(h * (isPortrait ? 0.665 : 0.72));

  let t = 0;
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const d = (durations && durations[i]) || s.duration || 7;
    const se = formatAssTime(t), ee = formatAssTime(t + d);
    const zhRaw = (s.scene_text_zh || '').replace(/[&{}]/g, '');
    // 先染色再折行：折行函数会把 {...} 当零宽、不切开（否则关键词跨行就染不上）
    const zhText = wrapCjkTagged(
      highlightKeyword(zhRaw, s.keyword_zh || deriveKeyword(zhRaw)),
      zhPerLine,
    );
    const enText = wrapEn((s.scene_text_en || '').replace(/[&{}]/g, ''), enPerLine);

    // 每条字幕按**自己的行数**定位，而不是靠固定 MarginV。
    // 2026-10-20 21:44 实测的坑：英文 40 字符折成 2 行时块向上生长，
    // 直接盖住中文字幕，看起来像"中英顺序反了"（实际是重叠）。
    const zhLines = zhText ? zhText.split('\\N').length : 0;
    const enLines = enText ? enText.split('\\N').length : 0;
    const zhPos = `{\\an2\\pos(${Math.round(w / 2)},${zhBottomY})}`;
    const enBottomY = zhBottomY + blockGap + enLines * lineH;
    const enPos = `{\\an2\\pos(${Math.round(w / 2)},${enBottomY})}`;

    if (zhText && wantZh) ass += `Dialogue: 0,${se},${ee},ZH,,0,0,0,,${zhPos}${zhText}\n`;
    if (enText && wantEn) ass += `Dialogue: 0,${se},${ee},EN,,0,0,0,,${enPos}${enText}\n`;
    // 中文多行时英文跟着往下让位（zhLines 已在上面算出，留着给后面调参看）
    void zhLines;
    t += d;
  }
  fs.writeFileSync(outPath, ass, 'utf-8');
  return outPath.replace(/\\/g, '/');
}

/**
 * 把一句字幕里的关键词染成品牌红（#FF2E5B → ASS 的 &HBBGGRR& 是 &H5B2EFF&）。
 *
 * 只染**第一处**：一句话里重复出现同一个词时，全染会让画面很吵；
 * 关键词没配或没命中时整句保持白色，不会出现"全句变红"。
 */
/**
 * 文案没配 keyword_zh 时，自动挑一个"看着像重点"的片段：
 * 优先「数字+量词/单位」（3 次 / 10 条专线 / 2 小时 / 30 秒），其次卖点词，
 * 都没有就返回空串（整句白色，不乱染色）。
 *
 * 为什么需要兜底：提示词要求模型返回 keyword_zh，但实测 deepseek-flash 经常漏这个字段
 * （2026-10-20 21:26 那条：7 镜一个字都没给，染色 0 行）。
 */
export function deriveKeyword(text) {
  const t = String(text || '');
  if (!t) return '';
  // 长的组合词排在前面：「10 条专线」不能被截成「10 条」
  const num = t.match(/[0-9]+(?:\.[0-9]+)?\s*(?:条专线|条视频|个平台|个账号|次|条|个|块|元|秒|分钟|小时|天|万|千|%|倍|步|招)?/);
  if (num && num[0].trim().length >= 2) return num[0].trim();
  const brand = t.match(/自动补|专线|多平台|一键|免密|秒级|不掉线|不封号/);
  return brand ? brand[0] : '';
}
export function highlightKeyword(text, keyword) {
  const kw = String(keyword || '').trim().replace(/[&{}]/g, '');
  if (!kw || !text.includes(kw)) return text;
  const RED = '{\\1c&H5B2EFF&}', WHITE = '{\\1c&HFFFFFF&}';
  const at = text.indexOf(kw);
  return `${text.slice(0, at)}${RED}${kw}${WHITE}${text.slice(at + kw.length)}`;
}

/**
 * 用参数数组调用 FFmpeg（shell:false 不经过 cmd.exe）。
 *
 * stderr 收集而不丢弃：旧实现设成 'ignore'，导致 ffmpeg 失败时只剩一个
 * 退出码（例如 "退出码 4294967294"），完全看不出是哪条滤镜/哪个文件的问题。
 * spawnSync 会等进程结束，不存在管道死锁风险。
 */
function runFFmpeg(args, { cwd, timeout = 10 * 60 * 1000 } = {}) {
  const r = spawnSync(FFMPEG, args, {
    windowsHide: true,
    shell: false,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) throw new Error(`ffmpeg 启动失败: ${r.error.message} (${FFMPEG})`);
  if (r.status !== 0) {
    // 只取 stderr 最后几行：ffmpeg 的真正原因总在末尾
    const tail = String(r.stderr || '')
      .split('\n').map(l => l.trim()).filter(Boolean).slice(-3).join(' | ');
    throw new Error(`ffmpeg 退出码 ${r.status}${tail ? `: ${tail.substring(0, 400)}` : '（无 stderr）'}`);
  }
  return r;
}

async function synthOne({ dirPath, outputPath, pkey, config, voicePath, scenes, durations }) {
  const { width, height } = config.video;
  // 字幕语言跟随**配音**语言：中文配音只出中文字幕，英文配音只出英文字幕。
  // 以前固定用平台的 'cn+en'，画面上中英两行叠在底部，手机小屏上又挤又小。
  const forcedVoice = getVideoStyleConfig().voiceLang;
  const subLang = forcedVoice === 'zh' ? 'cn'
    : forcedVoice === 'en' ? 'en'
    : (config.subtitleLang || 'cn+en');

  // 用真实时长生成字幕
  const assFile = createAss(scenes, path.join(dirPath, `sub_${pkey}.ass`), width, height, subLang, durations);
  const assRel = path.basename(assFile);

  // 分镜图必须先全部存在（P2-1）：
  // 旧实现里单张分镜图失败只是 console.log 一条警告，
  // 而 concat 列表照样引用该文件 → 整段视频合成失败，或者画面与配音整体错位。
  //
  // 例外：已有实拍素材（broll/scene_XX.mp4）的分镜不需要分镜图 ——
  // 上游会为这些镜跳过生图，所以这里按"有视频就不用图"来判定，
  // 否则会出现"明明有素材却说缺图"的误报。
  const sd = path.join(dirPath, 'slides');
  const slideFiles = scenes.map((s, i) =>
    path.join(sd, `scene_${String(i + 1).padStart(2, '0')}.png`));
  const brollPath = (i) => path.join(dirPath, 'broll', `scene_${String(i + 1).padStart(2, '0')}.mp4`);
  const usableBroll = (i) => {
    try {
      const p = brollPath(i);
      return fs.existsSync(p) && fs.statSync(p).size > 10 * 1024;
    } catch (_) {
      return false;
    }
  };
  const missing = slideFiles.filter((f, i) => !fs.existsSync(f) && !usableBroll(i));
  if (missing.length > 0) {
    throw new Error(
      `分镜图缺失 ${missing.length}/${scenes.length} 张（${missing.map(f => path.basename(f)).join(', ')}），` +
      `拒绝合成：缺图会让画面与配音时间轴错位`
    );
  }

  // 每镜真实时长（来自配音），与音频逐段对齐
  const realDurs = scenes.map((s, i) => Math.max(0.5, (durations && durations[i]) || s.duration || 7));
  const totalDur = realDurs.reduce((a, b) => a + b, 0);
  const style = getVideoStyleConfig();
  // 转场不能超过最短分镜的一半，否则时间轴会出现负 offset
  const minDur = Math.min(...realDurs);
  const T = style.motion ? Math.min(style.transitionSec, Math.max(0, (minDur - 0.5) / 2)) : 0;

  // 先输出到 _video 内的临时文件，成功后再 move 到最终位置
  // 防止进程被杀留下残缺 MP4（moov atom not found）
  const finalOutput = outputPath || path.join(dirPath, `video_${pkey}.mp4`);
  const tmpOutput = path.join(dirPath, `video_${pkey}_tmp.mp4`);
  const voiceRel = path.basename(voicePath);
  const bgmFile = pickBgmFile();

  const inputs = [];
  const lengths = clipLengths(realDurs, T);
  // 实拍素材优先：broll/scene_XX.mp4 存在就用真实拍摄的镜头运动，
  // 否则回退 AI 静态图 + 运镜（渐进增强，缺素材绝不影响出片）
  const brollUsed = new Set();
  const brollOf = (i) => (usableBroll(i) ? brollPath(i) : null);
  for (let i = 0; i < scenes.length; i++) {
    const broll = brollOf(i);
    if (broll) brollUsed.add(i);
    // 相对 cwd(dirPath) 的路径；分镜图在 slides/ 子目录里
    const rel = path.relative(dirPath, broll || slideFiles[i]).replace(/\\/g, '/');
    if (broll) {
      // 实拍片段通常比该镜时长（5-7s）短，循环播放补齐
      inputs.push('-stream_loop', '-1', '-t', lengths[i].toFixed(3), '-i', rel);
    } else {
      inputs.push('-loop', '1', '-t', lengths[i].toFixed(3), '-i', rel);
    }
  }
  const voiceIdx = scenes.length;
  inputs.push('-i', voiceRel);
  let bgmIdx = -1;
  if (bgmFile) {
    bgmIdx = voiceIdx + 1;
    // 配乐循环播放以覆盖整条视频，长度由 amix 的 duration=first（配音）决定
    inputs.push('-stream_loop', '-1', '-i', bgmFile);
  }

  const parts = [];
  const fallbackFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  // 用户自带截图已在 material.js 里做成"整图完整 + 模糊底"，本身已经是成品画面，
  // 再叠运镜会把整图放大会重新裁掉边缘（等于又变成残缺）。所以这些镜不做运镜。
  const userScenes = new Set();
  try {
    const mf = path.join(dirPath, 'slides', 'user-manifest.json');
    if (fs.existsSync(mf)) {
      const m = fs.readJsonSync(mf);
      for (const i of (m && m.indices) || []) userScenes.add(i);
    }
  } catch (_) { /* 读不到就当没有 */ }

  for (let i = 0; i < scenes.length; i++) {
    let vf;
    if (userScenes.has(i)) {
      // 用户截图：给一点点缩放让画面活起来（不裁到图，material.js 已留 10% 边距）。
      // 平移/摇镜会吃掉一侧边距，放大 5% 时可能切到截图边缘，所以统一改成推/拉。
      const move = /pan|tilt/i.test(String(scenes[i].camera_move || ''))
        ? (i % 2 === 0 ? 'push' : 'pull')
        : (scenes[i].camera_move || 'push');
      vf = motionFilterFor(move, {
        width, height, clipSec: lengths[i], amplitude: 0.05,
      });
    } else if (brollUsed.has(i)) {
      // 实拍素材本身就有运动和运镜，只需归一化尺寸（再加缩放会二次裁切）
      vf = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
    } else if (style.motion) {
      vf = motionFilterFor(scenes[i].camera_move, { width, height, clipSec: lengths[i] });
    } else {
      vf = fallbackFilter;
    }
    parts.push(
      `[${i}:v]${vf},setsar=1,fps=${FPS},` +
      `trim=duration=${lengths[i].toFixed(3)},setpts=PTS-STARTPTS[v${i}]`
    );
  }

  // 画面拼接：有转场走 xfade 链，否则走 concat（硬切）
  let chainLabel = 'v0';
  if (scenes.length > 1 && T > 0) {
    const offsets = transitionOffsets(lengths, T);
    for (let k = 0; k < scenes.length - 1; k++) {
      const out = k === scenes.length - 2 ? 'vx' : `x${k}`;
      parts.push(
        `[${chainLabel}][v${k + 1}]xfade=transition=${xfadeName(scenes[k + 1].transition)}` +
        `:duration=${T.toFixed(3)}:offset=${offsets[k]}[${out}]`
      );
      chainLabel = out;
    }
  } else if (scenes.length > 1) {
    parts.push(`${scenes.map((_, i) => `[v${i}]`).join('')}concat=n=${scenes.length}:v=1:a=0[vx]`);
    chainLabel = 'vx';
  }

  // 淡入淡出 + 字幕（ASS 用相对文件名，避免 Windows 盘符里的冒号干扰滤镜解析）
  const fades = [];
  if (style.fadeIn > 0) fades.push(`fade=t=in:st=0:d=${style.fadeIn.toFixed(2)}`);
  if (style.fadeOut > 0) {
    fades.push(`fade=t=out:st=${Math.max(0, totalDur - style.fadeOut).toFixed(2)}:d=${style.fadeOut.toFixed(2)}`);
  }
  const fadeChain = fades.length ? `${fades.join(',')},` : '';
  parts.push(`[${chainLabel}]${fadeChain}subtitles=${assRel}[vout]`);

  // 音轨：配音 一定有；配乐可选（volume 淡入后与配音混合）
  // 最后统一过一遍响度归一：实测旧片只有 -26.2 LUFS（社交平台标准约 -14），
  // 同一个音量推子上看还行，手机上听着就是"又闷又轻"，划走率高。
  const ln = style.loudness || { target: -14, truePeak: -1.5, lra: 11 };
  const normalize = `loudnorm=I=${ln.target}:TP=${ln.truePeak}:LRA=${ln.lra},alimiter=limit=0.95`;
  if (bgmIdx >= 0) {
    parts.push(`[${bgmIdx}:a]volume=${style.bgmVolume}${style.fadeIn > 0 ? `,afade=t=in:st=0:d=${Math.min(1, style.fadeIn).toFixed(2)}` : ''}[bgm]`);
    parts.push(`[${voiceIdx}:a][bgm]amix=inputs=2:duration=first:dropout_transition=0,${normalize}[aout]`);
  } else {
    parts.push(`[${voiceIdx}:a]${normalize}[aout]`);
  }

  const styleBits = [];
  if (brollUsed.size > 0) styleBits.push(`实拍 ${brollUsed.size}/${scenes.length} 镜`);
  if (style.motion) styleBits.push(`运镜${T > 0 ? ` + ${T}s 转场` : ''}`);
  if (bgmFile) styleBits.push('配乐');
  console.log(`  🎥 ${pkey}（${styleBits.length ? styleBits.join(' + ') : '静态'}）...`);
  // 参数以数组传入，路径/字幕文件名都不再经过 shell
  runFFmpeg([
    '-y',
    ...inputs,
    '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-t', totalDur.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-shortest',
    tmpOutput,
  ], { cwd: dirPath });

  if (!fs.existsSync(tmpOutput) || fs.statSync(tmpOutput).size === 0) {
    throw new Error(`ffmpeg 执行完成但未生成文件 (${path.basename(tmpOutput)})`);
  }
  // 只在这步才移动到最终位置——进程被杀时临时文件随 _video 一起清理
  await fs.move(tmpOutput, finalOutput, { overwrite: true });
  console.log(`  ✅ ${path.basename(finalOutput)} (${(fs.statSync(finalOutput).size/1024/1024).toFixed(1)}MB)`);
  return finalOutput;
}

/**
 * 只生成整段配音（音轨 + 每镜真实时长），不碰画面。
 *
 * 单独拆出来是为了**省钱**：配音是最便宜的一步（edge-tts 免费），
 * 却是最容易坏的一步 —— 微软会轮换令牌，旧客户端直接 403。
 * 把它放在生图之前跑，配音不通时只损失 DeepSeek 的 ¥0.0095，
 * 而不是 9 张 Kolors 的 ≈¥0.18。
 */
export async function generateVoiceTrack(dirPath, content) {
  // 根据平台配置选择配音语言：字幕语言（可能中英双语）与配音语言是两件事
  const tkConfig = getPlatformConfig('tiktok');
  if (!tkConfig || !tkConfig.video) {
    throw new Error('缺少 tiktok 平台配置（config/platforms.json），无法确定视频尺寸');
  }
  const subLang = tkConfig.subtitleLang || 'cn+en';
  // 设置里显式选了中文/英文就听设置；'auto' 才回退到"跟字幕走"的旧行为
  const forced = getVideoStyleConfig().voiceLang;
  const voiceLang = (forced === 'zh' || forced === 'en') ? forced : pickVoiceLang(subLang);
  const note = voiceLang === 'en' ? '英文配音读 scene_text_en' : '中文配音读 scene_text_zh';
  console.log(`  🗣️ 配音语言: ${voiceLang}（字幕: ${subLang}，${note}）`);

  // 目标时长来自 config/default.json 的 video.totalDuration（默认 22s）：
  // 超了让 voice.js 自动提速重录，避免 7 镜被拖成 26 秒
  const targetSec = Number(getEngineConfig()?.video?.totalDuration) || 22;
  const voiceResult = await generateVoice(content.scenes, dirPath, voiceLang, { targetSec });
  if (!voiceResult || !voiceResult.outputFile) {
    throw new Error('配音失败：没有产出音频文件，无法合成视频');
  }

  return { outputFile: voiceResult.outputFile, durations: voiceResult.durations, voiceLang };
}

/**
 * 合成视频。`precomputedVoice` 由调用方提前生成时传入，避免重复合成配音。
 */
export async function synthesizeAllPlatforms(dirPath, content, outputPath, precomputedVoice = null) {
  console.log(`  🎬 视频合成...`);

  const tkConfig = getPlatformConfig('tiktok');
  if (!tkConfig || !tkConfig.video) {
    throw new Error('缺少 tiktok 平台配置（config/platforms.json），无法确定视频尺寸');
  }

  const voice = precomputedVoice || await generateVoiceTrack(dirPath, content);
  const { outputFile: voicePath, durations } = voice;

  // 运行时自检：音频真实时长必须≈字幕/画面时间轴之和，
  // 否则就是 P2-21 那类"字幕与配音漂移"回归（超过 0.5s 直接告警）
  const timelineTotal = durations.reduce((s, d) => s + d, 0);
  try {
    const audioDur = getAudioDuration(voicePath);
    const drift = Math.abs(audioDur - timelineTotal);
    if (drift > 0.5) {
      console.warn(`  ⚠️ 时间轴校验失败: 音频 ${audioDur.toFixed(2)}s vs 时间轴 ${timelineTotal.toFixed(2)}s（相差 ${drift.toFixed(2)}s）`);
    } else {
      console.log(`  ⏱️ 时间轴校验通过: 音频 ${audioDur.toFixed(2)}s ≈ 时间轴 ${timelineTotal.toFixed(2)}s`);
    }
  } catch (e) {
    console.warn(`  ⚠️ 时间轴校验跳过: ${e.message}`);
  }

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
