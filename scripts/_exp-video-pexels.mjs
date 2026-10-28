/**
 * 实验 v3：**沿用现在线上的配料**，只修可量化的缺陷 —— 仍然不改应用任何代码。
 *
 * 按用户 2026-10-20 20:2x 的三条口径：
 *   ① 画面：Pexels 真实实拍片段（不要 AI 静图），内容要产品/科技感
 *   ② 语言：中英字幕**同字号**双行（不是英文当小注解）
 *   ③ 封面卡：保留（先去掉卡片里的网址和 logo，看效果）
 * 另外保留：中文配音 Xiaoxiao +10%（跟线上一致）、BGM 0.15、6 镜 → 5 镜快节奏、
 *          响度归一到 -14 LUFS（线上是 -26）。
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { findFFmpeg, findFFprobe, findEdgeTTS } from '../src/engine/tools.js';
import { searchVideos, downloadMaterial, resolvePexelsKey } from '../src/engine/material.js';
import { prependCoverCard } from '../src/engine/covercard.js';

const FFMPEG = findFFmpeg();
const FFPROBE = findFFprobe();
const EDGE = findEdgeTTS();
const W = 1080;
const H = 1920;
const FPS = 25;
const T = 0.4;
const GAP = 0.15;

const OUT = path.join(process.cwd(), 'output', 'exp-2026-10-20');
const CLIP_DIR = path.join(OUT, 'clips');
const VOICE_DIR = path.join(OUT, 'voice-pexels');

// Pexels Key 从应用配置读（只读，不改）
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'xnowpost', 'config', 'user.json'), 'utf-8'));
  if (!process.env.PEXELS_API_KEY && cfg.pexelsApiKey) process.env.PEXELS_API_KEY = String(cfg.pexelsApiKey);
} catch (_) {
  /* 配置读不到就算了 */
}

const VOICE = 'zh-CN-XiaoxiaoNeural'; // 跟线上一致
const RATE = '+10%'; // 跟线上一致

// 7 镜 / 约 20 秒：痛点 → 归因 → 卖点① → 收益 → 卖点② → 卖点③ → CTA
// （用户 2026-10-20 20:5x：14s 偏短，要 20~25s）
const SCENES = [
  {
    zh: '昨晚剪完，上传卡了 3 次',
    en: 'Upload failed three times.',
    key: '3 次',
    q: 'video editing laptop',
  },
  {
    zh: '不是内容差，是节点在掉',
    en: 'Your node is dropping.',
    key: '节点',
    q: 'network switch',
  },
  {
    zh: '10 条专线，哪条都不掉',
    en: 'Ten lines. None drop.',
    key: '10 条专线',
    q: 'server room',
  },
  {
    zh: '一条片子，省回 2 小时',
    en: 'Two hours, saved.',
    key: '2 小时',
    q: 'clock desk',
  },
  {
    zh: '多平台一个面板，不用切号',
    en: 'One panel. Every platform.',
    key: '一个面板',
    q: 'editing timeline screen',
  },
  {
    zh: '掉了自动补，不用盯着',
    en: 'Drops refill themselves.',
    key: '自动补',
    q: 'checklist notebook',
  },
  {
    zh: '评论区扣「专线」，给你试',
    en: 'Comment LINE for a trial.',
    key: '专线',
    q: 'typing phone',
  },
];
const COVER_TITLE = '上传卡了 3 次？';
const COVER_SUB = '不是内容差，是节点在掉';

function run(exe, args, { cwd, timeout = 600000, label = '' } = {}) {
  const r = spawnSync(exe, args, { cwd, timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`${label || path.basename(exe)} 失败: ${String(r.stderr || '').slice(-800)}`);
  return r;
}
function audioDur(f) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const d = parseFloat(String(r.stdout || '').trim());
  return Number.isFinite(d) ? d : 0;
}
function assTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
}

// ── 1. 封面卡（PIL 画，不带网址/logo）────────────────────────────────────
function makeCover(file) {
  const py = path.join(process.env.TEMP || '.', 'exp-cover2.py');
  fs.writeFileSync(
    py,
    `
from PIL import Image, ImageDraw, ImageFont, ImageFilter
W, H = 1080, 1920
img = Image.new("RGB", (W, H), (12, 13, 17))
# 右下角红色光晕（压淡一点，别糊）
glow = Image.new("RGB", (W, H), (0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([W*0.40, H*0.58, W*1.30, H*1.10], fill=(120, 18, 42))
glow = glow.filter(ImageFilter.GaussianBlur(190))
img = Image.blend(img, glow, 0.30)
d = ImageDraw.Draw(img)
def font(sz, bold=False):
    p = r"C:\\Windows\\Fonts\\msyhbd.ttc" if bold else r"C:\\Windows\\Fonts\\msyh.ttc"
    return ImageFont.truetype(p, sz)
RED = (255, 46, 91)
# ① 左上角 logo 片（跟现在线上那张同位置）
d.rounded_rectangle([80, 120, 300, 196], radius=38, fill=RED)
d.ellipse([104, 152, 120, 168], fill=(255, 255, 255))
d.text((134, 138), "XNOW", font=font(40, True), fill=(255, 255, 255))
# ② 主标题 + 钩子
d.rectangle([84, 556, 244, 564], fill=RED)
d.text((84, 600), ${JSON.stringify(COVER_TITLE)}, font=font(112, True), fill=(255, 255, 255))
d.text((84, 762), ${JSON.stringify(COVER_SUB)}, font=font(60, False), fill=(206, 209, 220))
# ③ 底部 CTA 条（网址回来了）
d.rounded_rectangle([70, 1590, 1010, 1700], radius=24, fill=RED)
d.text((110, 1616), "立即注册 · xnow.taikon.top", font=font(52, True), fill=(255, 255, 255))
d.text((78, 1730), "秒级交付 · 无需密码 · 全网最低价", font=font(36, False), fill=(150, 154, 168))
img.save(r"${file.replace(/\\/g, '\\\\')}")
print("cover ok")
`,
    'utf-8',
  );
  const r = spawnSync('python', [py], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`封面生成失败: ${String(r.stderr || '')}`);
  console.log(`  ✅ 封面卡（含 logo + 网址）：${path.basename(file)}`);
}
// ── 2. 实拍素材 ───────────────────────────────────────────────────────────
/** 抓 4 帧拼成 32x32 灰度算平均亮度：太黑的素材（实测抓到过几乎全黑的"服务器红灯"）
 *  在手机上就是一片黑屏，字幕再好也白搭 —— 直接换下一条。 */
function meanLuma(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-t', '3.2', '-i', file, '-vf', 'fps=2,scale=32:32', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const buf = r.stdout;
  if (!buf || !buf.length) return -1;
  let sum = 0;
  for (const b of buf) sum += b;
  return sum / buf.length;
}

async function fetchClips() {
  fs.mkdirSync(CLIP_DIR, { recursive: true });
  if (!resolvePexelsKey()) throw new Error('没有 Pexels Key，实拍素材拉不了');
  // 有 picks.json（人挑过的）就照它来：关键词搜索排的是"相关度"，不是"画面像不像那句话"
  const picksFile = path.join(OUT, 'picks.json');
  const picks = fs.existsSync(picksFile) ? JSON.parse(fs.readFileSync(picksFile, 'utf-8')) : {};
  const hasPicks = Object.keys(picks).filter((k) => !k.startsWith('_')).length > 0;
  if (hasPicks) console.log('  📌 使用 picks.json 里人挑过的素材');
  const out = [];
  for (let i = 0; i < SCENES.length; i++) {
    const f = path.join(CLIP_DIR, `s${i + 1}.mp4`);
    const pickName = picks[`s${i + 1}`];
    if (hasPicks && pickName) {
      const src = path.join(OUT, 'candidates', pickName);
      if (!fs.existsSync(src)) throw new Error(`picks.json 指向的候选不存在: ${pickName}`);
      fs.copyFileSync(src, f);
      console.log(`  📌 第${i + 1}镜 ← ${pickName}（人挑，亮度 ${meanLuma(f).toFixed(0)}）`);
      out.push(f);
      continue;
    }
    if (fs.existsSync(f) && fs.statSync(f).size > 200 * 1024) {
      const lum = meanLuma(f);
      if (lum >= 45 && lum <= 235) {
        console.log(`  ⏭️  s${i + 1}.mp4 已存在，复用（亮度 ${lum.toFixed(0)}）`);
        out.push(f);
        continue;
      }
      console.log(`  ♻️  s${i + 1}.mp4 太黑/太白（亮度 ${lum.toFixed(0)}），重新挑一条`);
      fs.rmSync(f, { force: true });
    }
    let hits = await searchVideos(SCENES[i].q, { perPage: 8, orientation: 'portrait' });
    // Pexels 实测：4 个词以上经常直接 0 条 → 退化成前两个词再搜
    if (!hits.length && SCENES[i].q.split(' ').length > 2) {
      const short = SCENES[i].q.split(' ').slice(0, 2).join(' ');
      console.log(`     ℹ️  "${SCENES[i].q}" 0 条，退化搜 "${short}"`);
      hits = await searchVideos(short, { perPage: 8, orientation: 'portrait' });
    }
    if (!hits.length) throw new Error(`第 ${i + 1} 镜没搜到实拍素材（${SCENES[i].q}）`);
    let picked = null;
    for (const h of hits.filter((x) => x.duration >= 4).concat(hits)) {
      const tmp = path.join(CLIP_DIR, `try-${i + 1}.mp4`);
      try {
        await downloadMaterial(h.url, tmp);
        const lum = meanLuma(tmp);
        if (lum >= 45 && lum <= 235) {
          fs.renameSync(tmp, f);
          picked = { h, lum };
          break;
        }
        console.log(`     ⏭️  亮度 ${lum.toFixed(0)} 不合适（太黑/太白），换下一条`);
      } catch (e) {
        console.log(`     ⏭️  下载失败，换下一条：${e.message}`);
      }
    }
    if (!picked) throw new Error(`第 ${i + 1} 镜没找到亮度合适的实拍素材（${SCENES[i].q}）`);
    console.log(
      `  🎞️  第${i + 1}镜实拍: "${SCENES[i].q}" (${picked.h.width}x${picked.h.height}, ${picked.h.duration}s, 亮度 ${picked.lum.toFixed(0)})`,
    );
    out.push(f);
  }
  return out;
}

// ── 3. 配音 ───────────────────────────────────────────────────────────────
function genVoice() {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const files = [];
  for (let i = 0; i < SCENES.length; i++) {
    const f = path.join(VOICE_DIR, `v${i + 1}.mp3`);
    if (!fs.existsSync(f)) {
      run(
        EDGE,
        ['--voice', VOICE, `--rate=${RATE}`, '--text', SCENES[i].zh, '--write-media', f],
        { timeout: 90000, label: `edge-tts ${i + 1}` },
      );
    }
    const d = audioDur(f);
    console.log(`  🗣️  第${i + 1}镜 语音 ${d.toFixed(2)}s`);
    files.push({ f, d });
  }
  return files;
}

// ── 4. 字幕：中英**同字号**双行 ───────────────────────────────────────────
const RED = '{\\1c&H5B2EFF&}';
const WHITE = '{\\1c&HFFFFFF&}';
function buildAss(durations, file) {
  const events = [];
  let t = 0;
  for (let i = 0; i < SCENES.length; i++) {
    const s = SCENES[i];
    const d = durations[i];
    let zh = s.zh.replace(/[&{}]/g, '');
    const k = s.key.replace(/[&{}]/g, '');
    zh = zh.includes(k) ? zh.replace(k, `${RED}${k}${WHITE}`) : `${RED}${zh}${WHITE}`;
    events.push(`Dialogue: 0,${assTime(t)},${assTime(t + d)},ZH,,0,0,0,,${zh}`);
    events.push(`Dialogue: 0,${assTime(t)},${assTime(t + d)},EN,,0,0,0,,${s.en.replace(/[&{}]/g, '')}`);
    t += d;
  }
  const SZ = 60; // 中英同字号
  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ZH,Microsoft YaHei,${SZ},&H00FFFFFF,&H000000FF,&H00000000,&H90000000,1,0,0,0,100,100,1,0,1,4,3,2,70,70,660,1
Style: EN,Arial,${SZ},&H00FFFFFF,&H000000FF,&H00000000,&H90000000,0,0,0,0,100,100,0,0,1,4,3,2,70,70,520,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
  fs.writeFileSync(file, ass, 'utf-8');
  return file;
}

// ── 5. 合成 ───────────────────────────────────────────────────────────────
function compose({ voiceFiles, clips, outFile, bgm }) {
  const dir = path.dirname(outFile);
  const durs = voiceFiles.map((v) => Math.max(2.4, Number((v.d + GAP).toFixed(3))));
  const clipLens = durs.map((d, i) => Number((i < durs.length - 1 ? d + T : d).toFixed(3)));
  const total = durs.reduce((a, b) => a + b, 0);

  // 配音轨
  const silence = path.join(dir, 'silence.mp3');
  if (!fs.existsSync(silence)) {
    run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(GAP), '-q:a', '9', silence], { label: '静音' });
  }
  const list = [];
  voiceFiles.forEach((v) => {
    list.push(`file '${v.f.replace(/\\/g, '/')}'`);
    list.push(`file '${silence.replace(/\\/g, '/')}'`);
  });
  const listFile = path.join(dir, 'voice-list.txt');
  fs.writeFileSync(listFile, list.join('\n'), 'utf-8');
  const voiceTrack = path.join(dir, 'voice-track.mp3');
  run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-q:a', '3', voiceTrack], { label: '配音拼接' });

  const assFile = buildAss(durs, path.join(dir, 'subs.ass'));

  const args = ['-y'];
  clips.forEach((c, i) => args.push('-t', String(clipLens[i] + 0.4), '-i', c));
  args.push('-i', voiceTrack);
  if (bgm) args.push('-i', bgm);

  const filters = [];
  clips.forEach((_, i) => {
    filters.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},` +
        `trim=duration=${clipLens[i]},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[v${i}]`,
    );
  });
  let prev = 'v0';
  for (let i = 1; i < clips.length; i++) {
    const offset = clipLens.slice(0, i).reduce((a, b) => a + b, 0) - T * i;
    filters.push(`[${prev}][v${i}]xfade=transition=fade:duration=${T}:offset=${offset.toFixed(3)}[x${i}]`);
    prev = `x${i}`;
  }
  filters.push(`[${prev}]ass=${path.basename(assFile)},fade=t=out:st=${(total - 0.4).toFixed(2)}:d=0.4[vo]`);

  const vIdx = clips.length;
  const bIdx = clips.length + 1;
  if (bgm) {
    filters.push(`[${vIdx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asplit=2[vmain][vsc]`);
    filters.push(`[${bIdx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=0.30[bg]`);
    filters.push(`[bg][vsc]sidechaincompress=threshold=0.03:ratio=12:attack=8:release=350[bgd]`);
    filters.push(
      `[vmain][bgd]amix=inputs=2:duration=first:dropout_transition=0,loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.95[aout]`,
    );
  } else {
    filters.push(`[${vIdx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);
  }

  args.push('-filter_complex', filters.join(';'), '-map', '[vo]', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS));
  args.push('-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', outFile);

  console.log(`  🎬 合成主片…（${total.toFixed(1)}s）`);
  run(FFMPEG, args, { cwd: dir, label: '合成' });
  return { durs, total };
}

// ── 6. 主流程 ─────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`\n🧪 实验 v3（Pexels 实拍 + 中英同字号 + 封面卡 + -14 LUFS）`);
  console.log(`   音色 ${VOICE} 语速 ${RATE}（与线上一致）\n`);

  console.log('🎞️ 实拍素材（Pexels，产品/科技感）');
  const clips = await fetchClips();

  console.log('\n🗣️ 配音');
  const voiceFiles = genVoice();

  const bgmDir = path.join(process.cwd(), 'assets', 'bgm');
  const bgms = fs.existsSync(bgmDir) ? fs.readdirSync(bgmDir).filter((f) => /\.(mp3|m4a)$/i.test(f)).map((f) => path.join(bgmDir, f)) : [];
  const bgm = bgms.length ? bgms[0] : null;

  const mainFile = path.join(OUT, 'demo-v3-nocover.mp4');
  const { durs, total } = compose({ voiceFiles, clips, outFile: mainFile, bgm });

  console.log('\n🖼️ 封面卡');
  const cover = path.join(OUT, 'cover-v3.png');
  makeCover(cover);
  const finalFile = path.join(OUT, 'demo-v3.mp4');
  fs.copyFileSync(mainFile, finalFile);
  await prependCoverCard(finalFile, cover, { seconds: 1.2 });

  const full = audioDur(finalFile);
  console.log('\n═══ 质量自检卡 ═══');
  console.log(`  文件 ${finalFile}`);
  console.log(`  总时长 ${full.toFixed(2)}s（封面 1.2s + 正片 ${total.toFixed(1)}s）｜ 镜数 ${SCENES.length}`);
  console.log(`  每镜 ${durs.map((d) => d.toFixed(1)).join(' / ')}`);
  console.log(`  首句含数字 ${/\d/.test(SCENES[0].zh) ? '✅' : '❌'} ｜ 结尾 CTA ${/评论|扣|给/.test(SCENES[SCENES.length - 1].zh) ? '✅' : '❌'}`);
  console.log('');
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
});
