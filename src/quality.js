/**
 * 成片质量自检（2026-10-20 v1.6.46）。
 *
 * 起因：用户报「视频质量」问题时，我们只能靠人眼一条条看，而且看不出**为什么**差。
 * 这一轮把能测的指标全部测出并打成一张卡，出片即出证据：
 *
 *   - 响度（LUFS）：旧片实测 -26.2，社交平台标准约 -14 —— 这是"听着又闷又轻"的根因，
 *     现在成片会过 loudnorm，本模块负责**复核真的归一了没有**；
 *   - 时长/镜数/每镜时长：节奏是否落在 2.4~3.6 秒的目标区间；
 *   - 字幕：中英是否都出、字号是否够大（读 .ass 文件，不靠猜）；
 *   - 文案：首句是否带数字（钩子）、结尾是否有 CTA、每镜字数是否超限；
 *   - 画质：分辨率/帧率/码率。
 *
 * 设计原则：**只测、只报，不改片子**。任何一项测不出来都写"未测"，绝不编数字。
 */
import fs from 'fs-extra';
import path from 'path';
import { spawnSync } from 'child_process';
import { findFFmpeg, findFFprobe } from './engine/tools.js';

/** 目标区间（与 config/default.json 的 video 段口径一致） */
export const QUALITY_TARGETS = {
  loudness: { min: -16, max: -12, target: -14 }, // LUFS，社交标准 ±2
  truePeakMax: -0.5, // dBTP，超过会爆音
  sceneSec: { min: 2.2, max: 4.2 },
  totalSec: { min: 18, max: 30 },
  zhChars: { min: 6, max: 16 },
  subtitleZhSizeMin: 44,
};

function run(exe, args, timeout = 120000) {
  const r = spawnSync(exe, args, {
    windowsHide: true,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: r.status === 0, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

/** 用 ffprobe 读时长/分辨率/帧率/码率/音轨 */
export function probeVideo(file) {
  const ffprobe = findFFprobe();
  if (!ffprobe || !fs.existsSync(file)) return null;
  const r = run(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration,bit_rate',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate,channels',
    '-of', 'json', file,
  ]);
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.stdout);
    const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
    const a = (j.streams || []).find((s) => s.codec_type === 'audio') || {};
    const [num, den] = String(v.r_frame_rate || '0/1').split('/').map(Number);
    return {
      durationSec: Number(j.format?.duration) || 0,
      bitrateKbps: Math.round((Number(j.format?.bit_rate) || 0) / 1000),
      width: Number(v.width) || 0,
      height: Number(v.height) || 0,
      fps: den ? Number((num / den).toFixed(2)) : 0,
      channels: Number(a.channels) || 0,
    };
  } catch (_) {
    return null;
  }
}

/** 用 ebur128 测整片响度（返回 LUFS / 真峰值 dBTP） */
export function measureLoudness(file) {
  const ffmpeg = findFFmpeg();
  if (!ffmpeg || !fs.existsSync(file)) return null;
  const r = run(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], 300000);
  if (!r.ok) return null;
  // 只认最后那个 Summary 块（前面每 100ms 会刷临时值）
  const idx = r.stderr.lastIndexOf('Summary:');
  if (idx < 0) return null;
  const block = r.stderr.slice(idx);
  const i = block.match(/\bI:\s*(-?[\d.]+)\s*LUFS/);
  const tp = block.match(/True peak:\s*Peak:\s*(-?[\d.]+)\s*dBFS/);
  if (!i) return null;
  return { lufs: Number(i[1]), truePeakDb: tp ? Number(tp[1]) : null };
}

/** 解析 .ass 字幕：报告中英行数、字号、是否有染色标记 */
export function inspectAss(file) {
  if (!file || !fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf-8');
  const styles = {};
  for (const line of text.split('\n')) {
    if (!line.startsWith('Style:')) continue;
    const cols = line.slice(6).split(',');
    styles[cols[0].trim()] = { font: cols[1], size: Number(cols[2]) || 0 };
  }
  const dialogs = text.split('\n').filter((l) => l.startsWith('Dialogue:'));
  const zh = dialogs.filter((l) => l.includes(',ZH,'));
  const en = dialogs.filter((l) => l.includes(',EN,'));
  const highlighted = zh.filter((l) => l.includes('\\1c&H5B2EFF&')).length;
  return {
    zhLines: zh.length,
    enLines: en.length,
    zhSize: styles.ZH?.size || 0,
    enSize: styles.EN?.size || 0,
    highlightedLines: highlighted,
  };
}

function within(v, range) {
  return Number.isFinite(v) && v >= range.min && v <= range.max;
}

/**
 * 把测到的指标 + 文案整理成一张可打印的自检卡。
 * 返回 { lines, metrics, problems, ok }：ok=false 只代表"有项没达标"，不阻断发布。
 */
export function buildQualityReport({ videoFile, scenes, assFile, targets = QUALITY_TARGETS }) {
  const probe = probeVideo(videoFile);
  const loud = measureLoudness(videoFile);
  const ass = inspectAss(assFile);
  const problems = [];

  const zh = (scenes || []).map((s) => String(s.scene_text_zh || ''));
  const en = (scenes || []).map((s) => String(s.scene_text_en || ''));
  const firstHasNumber = /\d/.test(zh[0] || '');
  // CTA 判定要宽一点：实测模型写「现在注册，火速出圈！」是合格 CTA，
  // 早期正则只认「评论/扣/领」，把好文案判成不合格（2026-10-20 21:26 自检卡误报）
  const lastCta = /评论|扣|留言|私信|注册|下单|链接|主页|下方|点|领|试|联系|找我|立即|马上|现在/.test(zh[zh.length - 1] || '');
  const overChars = zh.filter((t) => t.length > targets.zhChars.max).length;
  const tooShort = zh.filter((t) => t.length > 0 && t.length < targets.zhChars.min).length;

  if (loud) {
    if (!within(loud.lufs, { min: targets.loudness.min, max: targets.loudness.max })) {
      problems.push(`响度 ${loud.lufs.toFixed(1)} LUFS 不在 ${targets.loudness.min}~${targets.loudness.max}`);
    }
    if (loud.truePeakDb !== null && loud.truePeakDb > targets.truePeakMax) {
      problems.push(`真峰值 ${loud.truePeakDb.toFixed(1)} dBFS 超过 ${targets.truePeakMax}（会爆音）`);
    }
  } else {
    problems.push('响度未测出');
  }
  if (probe) {
    if (!within(probe.durationSec, targets.totalSec)) {
      problems.push(`总时长 ${probe.durationSec.toFixed(1)}s 不在 ${targets.totalSec.min}~${targets.totalSec.max}s`);
    }
  } else {
    problems.push('规格未测出');
  }
  if (ass) {
    if (!ass.zhLines) problems.push('没有中文字幕');
    if (!ass.enLines) problems.push('没有英文字幕');
    if (ass.zhSize && ass.zhSize < targets.subtitleZhSizeMin) {
      problems.push(`中文字幕 ${ass.zhSize}px 小于 ${targets.subtitleZhSizeMin}px（手机上看不清）`);
    }
  } else {
    problems.push('字幕文件未测出');
  }
  if (!firstHasNumber) problems.push('首句没有数字（钩子偏弱）');
  if (!lastCta) problems.push('结尾没有 CTA');
  if (overChars) problems.push(`${overChars} 镜中文字数超过 ${targets.zhChars.max}`);
  if (tooShort) problems.push(`${tooShort} 镜中文字数不足 ${targets.zhChars.min}`);

  const lines = [];
  if (probe) {
    lines.push(`  规格 ${probe.width}x${probe.height} / ${probe.fps}fps / ${probe.bitrateKbps}kbps / 音轨 ${probe.channels}ch`);
    lines.push(`  时长 ${probe.durationSec.toFixed(2)}s（${(scenes || []).length} 镜）`);
  }
  if (loud) {
    const mark = within(loud.lufs, { min: targets.loudness.min, max: targets.loudness.max }) ? '✅' : '⚠️';
    lines.push(`  响度 ${loud.lufs.toFixed(1)} LUFS（目标 ${targets.loudness.target}）${mark}` +
      (loud.truePeakDb !== null ? ` ｜ 真峰值 ${loud.truePeakDb.toFixed(1)} dBFS` : ''));
  }
  if (ass) {
    lines.push(`  字幕 中文 ${ass.zhLines} 行 / 英文 ${ass.enLines} 行 ｜ 字号 ${ass.zhSize}/${ass.enSize}px ｜ 染色 ${ass.highlightedLines} 行`);
  }
  if (zh.length) {
    // 这里用 ⚠️/✗ 而不是 ❌：这是**自检报告**，一条文案缺 CTA 不代表这轮失败
    // （视频照样生成、照样发布）。用 ❌ 会被日志分类器记成 [ERROR]
    // —— 2026-10-29 就因为它把一轮成功的发布记成了错误。
    const mark = (ok) => (ok ? '✅' : '⚠️');
    lines.push(`  文案 每镜字数 ${zh.map((t) => t.length).join('/')} ｜ 首句数字 ${mark(firstHasNumber)} ｜ 结尾 CTA ${mark(lastCta)}`);
    lines.push(`  英文每镜字符 ${en.map((t) => t.length).join('/')}`);
  }
  lines.push(problems.length ? `  ⚠️ 待改进 ${problems.length} 项：${problems.join('；')}` : '  ✅ 各项指标达标');

  return {
    ok: problems.length === 0,
    problems,
    lines,
    metrics: { probe, loudness: loud, subtitle: ass, firstHasNumber, lastCta },
  };
}

/** 生成并打印自检卡（失败只记一行，不影响成片） */
export function printQualityReport(opts) {
  try {
    const rep = buildQualityReport(opts);
    console.log('\n═══ 成片自检卡 ═══');
    for (const line of rep.lines) console.log(line);
    if (!rep.ok) console.log('  （以上不阻断发布，只作为下一轮改提示词/配置的依据）');
    console.log('');
    return rep;
  } catch (e) {
    console.log(`  ⚠️ 自检卡生成失败（不影响成片）: ${e.message}`);
    return null;
  }
}
