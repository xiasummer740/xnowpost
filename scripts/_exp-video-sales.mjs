/**
 * 实验：做一条"改进版"成片给用户看效果 —— **不修改应用任何代码/配置**。
 *
 * 与现有流水线的差别（就是想验证的四件事）：
 *   ① 文案结构：6 镜、每镜 ≤12 字、首句带具体数字、结尾一句 CTA（现在是 4 镜 × 4 秒、偏书面）
 *   ② 节奏：每镜 2.2~3.6 秒（按配音时长自适应，不再固定 4 秒）
 *   ③ 语音：换音色（默认 zh-CN-XiaoyiNeural，可 --voice 换），逐镜微调语速
 *   ④ 字幕：大字 + 关键词高亮（数字/关键名词染品牌红），英文小字在下
 *   ⑤ 画面：每镜单独写"画面提示词"生成图（Kolors），不再靠关键词撞运气
 *
 * 用法：
 *   node scripts/_exp-video.mjs                       # 生成 2 个版本（女声/男声）
 *   node scripts/_exp-video.mjs --voice zh-CN-XiaoyiNeural
 *   node scripts/_exp-video.mjs --no-image            # 跳过生图（复用上次的图）
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import axios from 'axios';
import { findFFmpeg, findFFprobe, findEdgeTTS } from '../src/engine/tools.js';

const FFMPEG = findFFmpeg();
const FFPROBE = findFFprobe();
const EDGE = findEdgeTTS();
const W = 1080;
const H = 1920;
const FPS = 25;
const T = 0.35; // 转场
const GAP = 0.15; // 镜间留白

const APP_DATA = path.join(process.env.APPDATA || '', 'xnowpost');
const OUT = path.join(process.cwd(), 'output', 'exp-2026-10-20');
const IMG_DIR = path.join(OUT, 'img');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = '') => {
  const i = argv.indexOf(k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

// ── 主题：沿用现在线上的"卖服务"语境（卖点 / 数字 / 对比 / 痛点 / CTA）────
const TOPIC = '海外运营网络：上传不掉线';

const SCENES = [
  {
    zh: '昨晚剪完，上传卡了 3 次',
    en: 'Finished editing. Upload failed 3 times.',
    key: '3 次',
    img: 'vertical photo, laptop at night with an upload progress bar stuck at 100%, glowing screen in a dark room, frustration, cinematic lighting',
  },
  {
    zh: '不是内容差，是节点在掉',
    en: "Your content is fine. Your node isn't.",
    key: '节点',
    img: 'vertical photo, network cables unplugged on a dark desk, red warning light, moody dramatic lighting, close up',
  },
  {
    zh: '10 条专线，哪条都不掉',
    en: 'Ten dedicated lines. None of them drop.',
    key: '10 条专线',
    img: 'vertical photo, a wall of glowing server lights in a dark data center, blue and red indicators, premium tech atmosphere',
  },
  {
    zh: '一条片子，省回 2 小时',
    en: 'One upload. Two hours back.',
    key: '2 小时',
    img: 'vertical photo, a clean desk with a laptop showing a completed upload, warm morning light, calm productive atmosphere',
  },
  {
    zh: '新号也能当天发满 10 条',
    en: 'A new account can still post ten today.',
    key: '10 条',
    img: 'vertical photo, a phone showing a social media upload queue with multiple items, dark background, dramatic side light',
  },
  {
    zh: '评论区扣「专线」，给你试',
    en: 'Comment LINE — I will send you a trial.',
    key: '专线',
    img: 'vertical photo, a hand tapping a smartphone screen in a dark room, warm refill light on the hand, cinematic close up',
  },
];
// ── 小工具 ────────────────────────────────────────────────────────────────
function run(exe, args, { cwd, timeout = 300000, label = '' } = {}) {
  const r = spawnSync(exe, args, { cwd, timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    const err = String(r.stderr || '').slice(-1200);
    throw new Error(`${label || path.basename(exe)} 失败 (code ${r.status}): ${err}`);
  }
  return r;
}
function audioDur(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], {
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

// ── 1. 取 API Key（读应用配置，不改它）────────────────────────────────────
function loadKeys() {
  const f = path.join(APP_DATA, 'config', 'user.json');
  const cfg = JSON.parse(fs.readFileSync(f, 'utf-8'));
  const pick = (...keys) => {
    for (const k of keys) {
      const v = cfg[k] || (cfg.api && cfg.api[k]) || (cfg.keys && cfg.keys[k]);
      if (v && String(v).startsWith('sk-')) return String(v);
    }
    return '';
  };
  const deepseek = process.env.DEEPSEEK_API_KEY || pick('deepseekApiKey', 'deepseekKey', 'deepseek');
  const silicon = process.env.SILICONFLOW_API_KEY || pick('siliconflowApiKey', 'siliconflowKey', 'siliconflow');
  return { deepseek, silicon };
}

// ── 2. 生图（Kolors，每镜一张，prompt 由每镜自己写）──────────────────────
async function genImages(silicon) {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  for (let i = 0; i < SCENES.length; i++) {
    const out = path.join(IMG_DIR, `s${i + 1}.png`);
    if (fs.existsSync(out) && fs.statSync(out).size > 20000) {
      console.log(`  ⏭️  s${i + 1}.png 已存在，复用`);
      continue;
    }
    const prompt = `${SCENES[i].img}, vertical 9:16 composition for a mobile video, photorealistic, high detail, no text, no watermark`;
    const r = await axios.post(
      'https://api.siliconflow.cn/v1/images/generations',
      { model: 'Kwai-Kolors/Kolors', prompt, image_size: '1024x1024', batch_size: 1, guidance_scale: 7.5 },
      { headers: { Authorization: `Bearer ${silicon}`, 'Content-Type': 'application/json' }, timeout: 180000 },
    );
    const url = r.data?.images?.[0]?.url || r.data?.data?.[0]?.url;
    if (!url) throw new Error(`第 ${i + 1} 镜没拿到图片 URL`);
    const bin = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
    fs.writeFileSync(out, Buffer.from(bin.data));
    console.log(`  ✅ s${i + 1}.png (${(fs.statSync(out).size / 1024).toFixed(0)}KB)`);
  }
}

// ── 3. 配音（逐镜独立合成，语速逐镜微调）─────────────────────────────────
async function genVoice(voice, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const rates = ['+10%', '+6%', '+12%', '+4%', '+8%', '+6%']; // 有起伏，不是一条直线
  const files = [];
  for (let i = 0; i < SCENES.length; i++) {
    const f = path.join(dir, `v${i + 1}.mp3`);
    run(
      EDGE,
      [
        '--voice', voice,
        // ⚠️ 必须用 --rate= / --pitch= 的等号形式：argparse 会把 "-2Hz" 当成另一个选项
        `--rate=${rates[i % rates.length]}`,
        `--pitch=${i % 2 === 0 ? '+0Hz' : '-2Hz'}`,
        '--text', SCENES[i].zh,
        '--write-media', f,
      ],
      { timeout: 90000, label: `edge-tts 第${i + 1}镜` },
    );
    const d = audioDur(f);
    console.log(`  🗣️  第${i + 1}镜 语音 ${d.toFixed(2)}s`);
    files.push({ f, d });
  }
  return files;
}

// ── 4. 字幕（ASS：大字 + 关键词高亮）─────────────────────────────────────
// ASS 颜色是 &HBBGGRR&；品牌红 #FF2E5B → &H5B2EFF&
const RED = '{\\1c&H5B2EFF&}';
const WHITE = '{\\1c&HFFFFFF&}';
function buildAss(durations, file) {
  const events = [];
  let t = 0;
  for (let i = 0; i < SCENES.length; i++) {
    const s = SCENES[i];
    const d = durations[i];
    // 关键词染色：把 key 从整句里切出来单独上色
    let zh = s.zh.replace(/[&{}]/g, '');
    const k = s.key.replace(/[&{}]/g, '');
    zh = zh.includes(k) ? zh.replace(k, `${RED}${k}${WHITE}`) : `${RED}${zh}${WHITE}`;
    events.push(`Dialogue: 0,${assTime(t)},${assTime(t + d)},ZH,,0,0,0,,${zh}`);
    events.push(`Dialogue: 0,${assTime(t)},${assTime(t + d)},EN,,0,0,0,,${s.en.replace(/[&{}]/g, '')}`);
    t += d;
  }
  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ZH,Microsoft YaHei,80,&H00FFFFFF,&H000000FF,&H00000000,&H90000000,1,0,0,0,100,100,2,0,1,5,3,2,70,70,560,1
Style: EN,Arial,38,&H00D9D9D9,&H000000FF,&H00000000,&H90000000,0,0,0,0,100,100,0,0,1,3,2,2,70,70,450,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
  fs.writeFileSync(file, ass, 'utf-8');
  return file;
}

// ── 5. 合成 ───────────────────────────────────────────────────────────────
function compose({ voiceFiles, outFile, bgm }) {
  const dir = path.dirname(outFile);
  const base = path.basename(outFile, '.mp4');

  // 每镜画面时长 = 配音 + 留白；最后一镜不收转场补偿，前面每镜 +T
  const durs = voiceFiles.map((v) => Math.max(2.2, Number((v.d + GAP).toFixed(3))));
  const clipLens = durs.map((d, i) => Number((i < durs.length - 1 ? d + T : d).toFixed(3)));

  // 配音轨：逐镜 mp3 + 静音间隔，拼成一条
  const silence = path.join(dir, 'silence.mp3');
  if (!fs.existsSync(silence)) {
    run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(GAP), '-q:a', '9', silence], {
      label: '静音片段',
    });
  }
  const list = [];
  voiceFiles.forEach((v) => {
    list.push(`file '${v.f.replace(/\\/g, '/')}'`);
    list.push(`file '${silence.replace(/\\/g, '/')}'`);
  });
  const listFile = path.join(dir, `voice-${base}.txt`);
  fs.writeFileSync(listFile, list.join('\n'), 'utf-8');
  const voiceTrack = path.join(dir, `voice-${base}.mp3`);
  run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-q:a', '3', voiceTrack], {
    label: '配音拼接',
  });

  const assFile = buildAss(durs, path.join(dir, `sub-${base}.ass`));

  // 输入：N 张图 + 配音 + BGM
  const args = ['-y'];
  SCENES.forEach((_, i) => args.push('-loop', '1', '-t', String(clipLens[i] + 1), '-i', path.join(IMG_DIR, `s${i + 1}.png`)));
  args.push('-i', voiceTrack);
  if (bgm) args.push('-i', bgm);

  const filters = [];
  SCENES.forEach((_, i) => {
    const zoomIn = i % 2 === 0;
    const z = zoomIn
      ? `zoompan=z='min(1.0+0.0012*on,1.14)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(clipLens[i] * FPS)}:s=${W}x${H}:fps=${FPS}`
      : `zoompan=z='if(eq(on,1),1.14,max(1.0,1.14-0.0012*on))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(clipLens[i] * FPS)}:s=${W}x${H}:fps=${FPS}`;
    filters.push(
      `[${i}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},` +
        `${z},trim=duration=${clipLens[i]},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[v${i}]`,
    );
  });

  // xfade 链
  let prev = 'v0';
  for (let i = 1; i < SCENES.length; i++) {
    const offset = clipLens.slice(0, i).reduce((a, b) => a + b, 0) - T * i;
    filters.push(`[${prev}][v${i}]xfade=transition=fade:duration=${T}:offset=${offset.toFixed(3)}[x${i}]`);
    prev = `x${i}`;
  }
  // 字幕 + 结尾淡出
  filters.push(`[${prev}]ass=${path.basename(assFile)},fade=t=out:st=${(durs.reduce((a, b) => a + b, 0) - 0.5).toFixed(2)}:d=0.5[vo]`);

  // 音频：旁白为主，BGM 压低并在旁白处让路（sidechain）
  const voiceIdx = SCENES.length;
  const bgmIdx = SCENES.length + 1;
  if (bgm) {
    filters.push(`[${voiceIdx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asplit=2[vmain][vsc]`);
    filters.push(`[${bgmIdx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=0.55[bg]`);
    filters.push(`[bg][vsc]sidechaincompress=threshold=0.03:ratio=12:attack=8:release=350[bgd]`);
    filters.push(`[vmain][bgd]amix=inputs=2:duration=first:dropout_transition=0,loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.95,afade=t=out:st=${(durs.reduce((a, b) => a + b, 0) - 0.6).toFixed(2)}:d=0.6[aout]`);
  } else {
    filters.push(`[${voiceIdx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]`);
  }

  args.push('-filter_complex', filters.join(';'), '-map', '[vo]', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS));
  args.push('-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', outFile);

  console.log(`  🎬 合成 ${base} …（总时长约 ${durs.reduce((a, b) => a + b, 0).toFixed(1)}s）`);
  run(FFMPEG, args, { cwd: dir, label: `合成 ${base}`, timeout: 600000 });

  const total = audioDur(outFile);
  return { outFile, durs, total };
}

// ── 6. 主流程 ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🧪 实验成片：${TOPIC}`);
  console.log(`   ffmpeg=${FFMPEG}\n   edge-tts=${EDGE}`);
  console.log(`   输出目录：${OUT}\n`);

  const keys = loadKeys();
  console.log(`   Key: deepseek=${keys.deepseek ? '有' : '无'} siliconflow=${keys.silicon ? '有' : '无'}`);

  if (!has('--no-image')) {
    if (!keys.silicon) throw new Error('没有硅基流动 Key，生图跑不了（用 --no-image 复用已有图）');
    console.log('\n🎨 生图 6 张（每镜一条画面提示词）');
    await genImages(keys.silicon);
  }

  const bgms = fs.existsSync(path.join(process.cwd(), 'assets', 'bgm'))
    ? fs
        .readdirSync(path.join(process.cwd(), 'assets', 'bgm'))
        .filter((f) => /\.(mp3|m4a|wav)$/i.test(f))
        .map((f) => path.join(process.cwd(), 'assets', 'bgm', f))
    : [];
  const bgm = bgms.length ? bgms[0] : null;

  const voices = has('--voice')
    ? [val('--voice', 'zh-CN-XiaoxiaoNeural')]
    : ['zh-CN-XiaoxiaoNeural'];
  const results = [];
  for (const voice of voices) {
    const tag = voice.split('-').pop().replace('Neural', '').toLowerCase();
    console.log(`\n🗣️  版本 ${tag}（${voice}）`);
    const vdir = path.join(OUT, `voice-${tag}`);
    const files = await genVoice(voice, vdir);
    const r = compose({ voiceFiles: files, outFile: path.join(OUT, `demo-${tag}.mp4`), bgm });
    results.push({ voice, tag, ...r });
  }

  console.log('\n═══ 质量自检卡 ═══');
  for (const r of results) {
    const secs = r.durs.map((d) => d.toFixed(1)).join(' / ');
    console.log(`\n  ${path.basename(r.outFile)}  音色 ${r.voice}`);
    console.log(`    总时长 ${r.total.toFixed(2)}s ｜ 镜数 ${SCENES.length} ｜ 每镜 ${secs}`);
    console.log(`    首句含数字: ${/\d/.test(SCENES[0].zh) ? '✅' : '❌'}   每镜字数: ${SCENES.map((s) => s.zh.length).join('/')}`);
    console.log(`    结尾 CTA: ${/评论|扣|清单|链接/.test(SCENES[SCENES.length - 1].zh) ? '✅' : '❌'}`);
    console.log(`    文件 ${(fs.statSync(r.outFile).size / 1024 / 1024).toFixed(2)} MB`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
});
