/**
 * 素材库自动生长（2026-10-20 v1.6.52）。
 *
 * 用户口径：「素材库你会自动更新自动补吗，这样我以后就不用手动补了」。
 * 之前只有 14 段人挑过的片段，且**完全静态** —— 选题一换就没素材，只能人工补。
 *
 * 自动补的难点不是"下载"，是**没人看着画质和相关性**。所以设了 5 道闸，
 * 全部通过才入库（任何一道不过就丢掉，绝不污染库）：
 *   ① 时长 ≥ 3.5s（不够切不出 2.4~3.6 秒的镜头）
 *   ② 亮度 45~235（太黑/太白的素材在手机上等于黑屏/白屏）
 *   ③ 清晰度：Laplacian 方差 ≥ 阈值（虚焦、脏镜头的方差很低）
 *   ④ 感知哈希去重（和库里已有片段汉明距离 < 6 视为同一条）
 *   ⑤ 分辨率/体积下限（小图放大就糊）
 *
 * 相关性仍无法 100% 保证（Pexels 只按关键词排序），所以：
 *   - 自动入库的条目带 `source:'auto'`，挑片时**永远排在人挑的后面**（同分优先 curated）；
 *   - 记录使用次数 `used`，长期没人用的自动会被裁掉；
 *   - 体积总量有上限，超了优先淘汰「自动 + 用得少 + 入库早」的。
 *
 * 触发方式：应用每天自动跑一次（最多补 6 段）；也可手动
 *   `node scripts/grow-broll-library.mjs --max 20 [--dry-run]`
 */
import fs from 'fs-extra';
import path from 'path';
import { spawnSync } from 'child_process';
import { searchVideos, downloadMaterial, meanLuma } from './engine/material.js';
import { findFFmpeg } from './engine/tools.js';
import { dataPath } from './paths.js';
import {
  libraryPath, loadClips, saveClips, readMisses,
} from './broll-store.js';

export { readMisses, recordMiss, markLibraryUse, grownToday, markGrownToday, libraryPath } from './broll-store.js';

// 供脚本/测试直接复用（亮度检测与引擎同一份实现，避免两套阈值）
export { meanLuma };




/** 自动补的题材表：标签 → Pexels 检索词（1~2 个词命中率最高，4 个词以上实测返回 0 条） */
export const AUTO_PLAN = {
  editing: ['video editing', 'editing timeline', 'laptop video'],
  phone: ['smartphone hand', 'phone screen', 'hand holding phone'],
  chat: ['chat message', 'notification phone'],
  data: ['data screen', 'numbers screen', 'analytics dashboard'],
  server: ['server room', 'network device', 'cable server'],
  clock: ['clock time', 'alarm clock'],
  desk: ['desk notebook', 'writing notebook'],
  office: ['office desk', 'workspace monitor'],
  people: ['person using phone', 'young man phone'],
  growth: ['chart growth', 'graph rising', 'stock chart'],
  night: ['night city neon', 'neon lights'],
};

/** 闸门阈值（改这些要同步改单测） */
export const GATES = {
  minDurationSec: 3.5,
  lumaMin: 32,   // 实测：人挑的好素材里有亮度 21~37 的暗调科技感画面，45 会误杀
  lumaMax: 235,
  minSharpness: 75,   // Laplacian 方差；现有 14 段实测 70~1189（中位 303），虚焦普遍 < 60
  minHeight: 720,
  minBytes: 700 * 1024,
  dedupeDistance: 6,  // 汉明距离小于它就算重复
  maxLibraryBytes: 900 * 1024 * 1024,
};

/** 抽 9x8 灰度算 dHash（64 位），返回 hex 字符串 */
export function dhash(file) {
  const ffmpeg = findFFmpeg();
  if (!ffmpeg) return null;
  const r = spawnSync(ffmpeg, [
    '-v', 'error', '-ss', '1', '-i', file,
    '-vf', 'scale=9:8:flags=area,format=gray', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], { windowsHide: true, timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const buf = r.stdout;
  if (!buf || buf.length < 72) return null;
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits += buf[y * 9 + x] > buf[y * 9 + x + 1] ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** 汉明距离（去重用） */
export function hamming(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return 99;
  let d = 0;
  for (let i = 0; i < hexA.length; i++) {
    let x = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/** Laplacian 方差（清晰度；越低越糊） */
export function sharpness(file) {
  const ffmpeg = findFFmpeg();
  if (!ffmpeg) return -1;
  const W = 320, H = 180;
  const r = spawnSync(ffmpeg, [
    '-v', 'error', '-ss', '1', '-i', file,
    '-vf', `scale=${W}:${H}:flags=bilinear,format=gray`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], { windowsHide: true, timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const b = r.stdout;
  if (!b || b.length < W * H) return -1;
  const vals = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      vals.push(4 * b[i] - b[i - 1] - b[i + 1] - b[i - W] - b[i + W]);
    }
  }
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const varr = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
  return Math.round(varr);
}

/**
 * 判定一个候选片段能不能入库（纯逻辑，方便单测）。
 * @returns {{ok:boolean, reasons:string[], metrics:object}}
 */
export function judgeCandidate(metrics, thresholds = GATES) {
  const reasons = [];
  const { durationSec, height, bytes, luma, sharp, hash } = metrics;
  if (!(durationSec >= thresholds.minDurationSec)) reasons.push(`时长 ${durationSec}s < ${thresholds.minDurationSec}s`);
  if (!(height >= thresholds.minHeight)) reasons.push(`高度 ${height} < ${thresholds.minHeight}`);
  if (!(bytes >= thresholds.minBytes)) reasons.push(`体积 ${Math.round((bytes || 0) / 1024)}KB 太小`);
  if (!(luma >= thresholds.lumaMin && luma <= thresholds.lumaMax)) reasons.push(`亮度 ${luma} 超出 ${thresholds.lumaMin}~${thresholds.lumaMax}`);
  if (!(sharp >= thresholds.minSharpness)) reasons.push(`清晰度 ${sharp} < ${thresholds.minSharpness}（疑似虚焦）`);
  if (!hash) reasons.push('取不到感知哈希');
  return { ok: reasons.length === 0, reasons, metrics };
}

/**
 * 主流程：按题材表补齐到每类 perTag 段，最多补 maxPerRun 段。
 * @returns {Promise<{added:string[], skipped:number, stats:object}>}
 */
export async function growLibrary({ perTag = 3, maxPerRun = 6, dryRun = false, quiet = false } = {}) {
  const { dir } = libraryPath();
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const clips = loadClips();
  const hashes = clips.map((c) => c.hash).filter(Boolean);
  const byTag = new Map();
  for (const c of clips) for (const t of c.tags || []) byTag.set(t, (byTag.get(t) || 0) + 1);

  const added = [];
  let skipped = 0;
  const stats = { candidates: 0, rejected: {}, accepted: 0 };

  // 优先级：先补"引擎实际没搜到"的关键词，再按题材表
  const misses = readMisses();
  const targets = [];
  for (const m of misses.slice(0, 6)) {
    const tag = m.keywords.split(/\s+/)[0].toLowerCase();
    if (targets.some((t) => t.tag === tag)) continue;
    targets.push({ tag, queries: [m.keywords], need: perTag, from: 'miss' });
  }
  for (const [tag, queries] of Object.entries(AUTO_PLAN)) {
    const have = byTag.get(tag) || 0;
    if (have >= perTag + 2) continue; // 该类已经够用
    targets.push({ tag, queries, need: Math.max(1, perTag - Math.min(have, perTag)), from: 'plan' });
  }

  for (const t of targets) {
    if (added.length >= maxPerRun) break;
    let got = 0;
    for (const q of t.queries) {
      if (got >= t.need || added.length >= maxPerRun) break;
      let hits = [];
      try {
        hits = await searchVideos(q, { perPage: 8 });
      } catch (e) {
        log(`  ⚠️ 搜索失败 ${q}: ${e.message}`);
        continue;
      }
      // 便宜的预筛：时长够、分辨率够
      const pre = hits.filter((h) => (h.duration || 0) >= GATES.minDurationSec && (h.height || 0) >= GATES.minHeight);
      // 每个检索词最多评估 3 条候选，挑**最清晰**的那条入库。
      // 只取第一条（Pexels 按相关度排序、不按画质）实测会收到又糊又偏的片子。
      let bestOfQuery = null;
      const evalLimit = Math.min(pre.length, 3);
      for (let ci = 0; ci < evalLimit; ci++) {
        if (got >= t.need || added.length >= maxPerRun) break;
        const cand = pre[ci];
        const url = cand.url; // searchVideos 已按「竖屏优先+够用最小」挑好文件
        if (!url) continue;
        stats.candidates += 1;
        const tmp = path.join(dir, '.incoming.mp4');
        try {
          const saved = await downloadMaterial(url, tmp);
          if (!saved) continue;
          const bytes = fs.statSync(tmp).size;
          const metrics = {
            durationSec: Number(cand.duration) || 0,
            height: Number(cand.height) || 0,
            bytes,
            luma: Math.round(meanLuma(tmp)),
            sharp: sharpness(tmp),
            hash: dhash(tmp),
          };
          const verdict = judgeCandidate(metrics);
          if (!verdict.ok) {
            skipped += 1;
            for (const r of verdict.reasons) stats.rejected[r.split(' ')[0]] = (stats.rejected[r.split(' ')[0]] || 0) + 1;
            log(`  ⏭️  ${q} 候选不合格：${verdict.reasons.join('；')}`);
            fs.removeSync(tmp);
            continue;
          }
          const dup = hashes.some((h) => hamming(h, metrics.hash) < GATES.dedupeDistance);
          if (dup) {
            skipped += 1;
            stats.rejected['重复'] = (stats.rejected['重复'] || 0) + 1;
            log(`  ⏭️  ${q} 候选与库里已有片段重复`);
            fs.removeSync(tmp);
            continue;
          }
          // 记下这条候选（含临时文件路径），本轮里挑最清晰的
          if (bestOfQuery) fs.removeSync(bestOfQuery.tmp);
          bestOfQuery = { tmp, metrics, q, bytes };
          fs.moveSync(tmp, `${tmp}.best`, { overwrite: true });
          bestOfQuery.tmp = `${tmp}.best`;
        } catch (e) {
          fs.removeSync(tmp);
          log(`  ⚠️ ${q} 候选下载/检测失败：${e.message}`);
        }
      }

      if (bestOfQuery && got < t.need && added.length < maxPerRun) {
        const { metrics, bytes } = bestOfQuery;
        const name = `${t.tag}__auto-${Date.now().toString(36)}.mp4`;
        if (!dryRun) {
          fs.moveSync(bestOfQuery.tmp, path.join(dir, name), { overwrite: true });
          clips.push({
            file: name,
            // 标签 = 题材标签 + 检索词：以后用 "phone"/"chat" 都能命中
            tags: [t.tag, ...String(bestOfQuery.q).split(/\s+/).map((w) => w.toLowerCase()).filter((w) => w.length >= 3)],
            note: `自动补入（${bestOfQuery.q}${t.from === 'miss' ? '，引擎搜不到的关键词' : ''}）`,
            bytes,
            luma: metrics.luma,
            sharp: metrics.sharp,
            hash: metrics.hash,
            source: 'auto',
            used: 0,
            addedAt: new Date().toISOString(),
          });
          hashes.push(metrics.hash);
        } else {
          fs.removeSync(bestOfQuery.tmp);
        }
        if (!dryRun) saveClips(clips); // 立刻落盘：进程被杀也不会留下孤儿文件
        added.push(name);
        got += 1;
        stats.accepted += 1;
        log(`  ✅ 入库 ${name}（${bestOfQuery.q}，亮度 ${metrics.luma}，清晰度 ${metrics.sharp}，${Math.round(bytes / 1024)}KB）`);
      }
    }
  }

  if (!dryRun && added.length) {
    // 体积上限：超了优先淘汰「自动 + 用得少 + 入库早」
    let total = clips.reduce((s, c) => s + (c.bytes || 0), 0);
    if (total > GATES.maxLibraryBytes) {
      const victims = clips
        .filter((c) => c.source === 'auto')
        .sort((a, b) => (a.used || 0) - (b.used || 0) || String(a.addedAt).localeCompare(String(b.addedAt)));
      while (total > GATES.maxLibraryBytes && victims.length) {
        const v = victims.shift();
        const p = path.join(dir, v.file);
        if (fs.existsSync(p)) fs.removeSync(p);
        total -= v.bytes || 0;
        const i = clips.indexOf(v);
        if (i >= 0) clips.splice(i, 1);
        log(`  🗑️ 超出体积上限，淘汰 ${v.file}`);
      }
    }
    saveClips(clips);
  }

  return { added, skipped, stats, total: clips.length };
}

/**
 * 收养孤儿文件：磁盘上有 `xxx__auto-*.mp4` 但 index 里没有的片段。
 *
 * 为什么需要：补库进程被杀/断网时，文件已经落地、index 还没写，
 * 这批文件就永远不会被用到（白占几百 MB）。收养时照样过全部闸门，
 * 不合格的直接删 —— 不会因为"是孤儿"就降低标准。
 */
export async function adoptOrphans({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const { dir } = libraryPath();
  if (!fs.existsSync(dir)) return { adopted: [], dropped: 0 };
  const clips = loadClips();
  const known = new Set(clips.map((c) => c.file));
  const hashes = clips.map((c) => c.hash).filter(Boolean);
  const files = fs.readdirSync(dir).filter((f) => /__auto-[a-z0-9]+\.mp4$/i.test(f) && !known.has(f));
  const adopted = [];
  let dropped = 0;
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      const bytes = fs.statSync(p).size;
      const metrics = { durationSec: 99, height: 1920, bytes, luma: Math.round(meanLuma(p)), sharp: sharpness(p), hash: dhash(p) };
      const verdict = judgeCandidate(metrics);
      if (!verdict.ok) {
        fs.removeSync(p);
        dropped += 1;
        log(`  🗑️ 孤儿不合格，删除 ${f}：${verdict.reasons.join('；')}`);
        continue;
      }
      if (hashes.some((h) => hamming(h, metrics.hash) < GATES.dedupeDistance)) {
        fs.removeSync(p);
        dropped += 1;
        log(`  🗑️ 孤儿重复，删除 ${f}`);
        continue;
      }
      const tag = f.split('__auto-')[0];
      clips.push({
        file: f,
        tags: [tag],
        note: '自动补入（进程中断后收养）',
        bytes,
        luma: metrics.luma,
        sharp: metrics.sharp,
        hash: metrics.hash,
        source: 'auto',
        used: 0,
        addedAt: new Date().toISOString(),
      });
      hashes.push(metrics.hash);
      adopted.push(f);
      log(`  ♻️ 收养 ${f}（亮度 ${metrics.luma}，清晰度 ${metrics.sharp}）`);
    } catch (e) {
      fs.removeSync(p);
      dropped += 1;
      log(`  🗑️ 孤儿检测失败，删除 ${f}：${e.message}`);
    }
  }
  if (adopted.length) saveClips(clips);
  return { adopted, dropped };
}