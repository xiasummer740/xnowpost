/**
 * 自动打码：把用户截图里的优惠码 / 邀请码遮掉。
 *
 * 为什么不用"模型返回坐标"：实测三个模型给的坐标全都对不上
 * （真值 x≈800/y≈530，Qwen3-VL-8B 给 539/723、32B 给 347/750，偏差几百像素）。
 * 视觉模型的定位能力不可信，靠坐标打码一定会漏。
 *
 * 所以换成两步闭环：
 *   1) 模型只说"有没有码、大概在纵向百分之几"（这个它答得比较准）
 *   2) 按这个位置把**整条横向带**糊掉，然后把糊过的图再发回模型问
 *      "还能看清 28925 吗" —— 答"不能"才算成功，否则加宽带子重试
 * 宁可多遮一条文字行，也不允许漏出一个码。
 */
import fs from 'fs-extra';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { findFFmpeg } from './tools.js';

const MODEL = 'Qwen/Qwen3-VL-8B-Instruct';
const BASE = process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1';
const MAX_CODES = 2;          // 一张图最多处理 2 个码，再多没必要
// 带子半高（占图高比例），**从小到大**试：第一次就通过就只糊一行，
// 失败才加宽。以前直接从 0.07 起、一失败就跳到 0.18，等于糊掉 3 行。
const BAND_STEPS = [0.035, 0.05, 0.07, 0.10, 0.14];

const DETECT_PROMPT = `这张截图是一个服务/商品页面。请找出里面所有"优惠码、邀请码、推广码、折扣码"
（通常是「用28925」这类 4~8 位数字或字母组合）。
只输出 JSON，不要解释：
{"codes":[{"code":"28925","yPercent":78}]}
yPercent 是这个码在图片**纵向**的位置百分比（0=最上，100=最下）。
没有就返回 {"codes":[]}`;

function verifyPrompt(code) {
  return `这张图里的数字串 "${code}" 是否还能被清晰读出？
如果能看清就回答 yes，被模糊掉看不清就回答 no。只回答一个词。`;
}

async function ask(imagePath, prompt, apiKey, maxTokens = 300) {
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp' : 'image/png';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const resp = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        }],
        max_tokens: maxTokens,
        temperature: 0,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return '';
    const data = await resp.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  } catch (_) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/** 在 src 上把 [yCenter±half] 这条横向带模糊掉，输出 dst */
function blurBand(src, dst, { yPercent, half, width, height }) {
  const ffmpeg = findFFmpeg();
  if (!ffmpeg) return false;

  const bh = Math.max(8, Math.round(height * half * 2));
  let by = Math.round(height * (yPercent / 100) - bh / 2);
  by = Math.max(0, Math.min(height - bh, by));

  // 先裁出那一条、重度模糊+压暗，再贴回原图 —— 比 drawbox 更自然，
  // 也不会因为纯黑色块显得像"打补丁"。
  const filter =
    `[0:v]split[base][band];` +
    `[band]crop=${width}:${bh}:0:${by},` +
    `boxblur=luma_radius=18:luma_power=3:chroma_radius=18:chroma_power=3,` +
    `eq=brightness=-0.06[patch];` +
    `[base][patch]overlay=0:${by}[out]`;

  const r = spawnSync(ffmpeg, [
    '-y', '-i', src, '-filter_complex', filter, '-map', '[out]',
    '-frames:v', '1', dst,
  ], { windowsHide: true, timeout: 60000, stdio: 'ignore' });

  return r.status === 0 && fs.existsSync(dst) && fs.statSync(dst).size > 1024;
}

function probeSize(file) {
  const ffprobe = findFFmpeg()?.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  if (!ffprobe) return null;
  const r = spawnSync(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
  ], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  const [w, h] = String(r.stdout).trim().split(',').map(Number);
  return Number.isFinite(w) && Number.isFinite(h) ? { width: w, height: h } : null;
}

/**
 * 处理一组截图：发现优惠码就打码，打完再校验。
 * @returns {Promise<{paths: string[], maskedCount: number, reasons: string[]}>}
 */
export async function maskPromoCodes(paths, { apiKey, outDir } = {}) {
  const list = (paths || []).filter(p => typeof p === 'string' && fs.existsSync(p));
  if (!list.length || !apiKey) return { paths: list, maskedCount: 0, reasons: [] };

  await fs.ensureDir(outDir);
  const outPaths = [];
  let maskedCount = 0;
  const reasons = [];

  for (const src of list) {
    const size = probeSize(src);
    if (!size) { outPaths.push(src); continue; }

    const raw = await ask(src, DETECT_PROMPT, apiKey);
    const m = raw.match(/\{[\s\S]*\}/);
    let codes = [];
    if (m) {
      try {
        const parsed = JSON.parse(m[0]);
        codes = (parsed.codes || [])
          .filter(c => c && c.code)
          .slice(0, MAX_CODES);
      } catch (_) { /* 解析失败当作没找到 */ }
    }

    if (!codes.length) { outPaths.push(src); continue; }

    // 逐个码叠加打码；每次都基于上一版结果继续遮
    let current = src;
    const baseName = path.basename(src, path.extname(src));
    let step = 0;
    let anyFailed = false;

    for (const c of codes) {
      const yPercent = Number(c.yPercent);
      if (!Number.isFinite(yPercent) || yPercent < 0 || yPercent > 100) continue;

      let done = false;
      for (const half of BAND_STEPS) {
        step++;
        const tmp = path.join(outDir, `${baseName}_mask${step}${path.extname(src)}`);
        if (!blurBand(current, tmp, { yPercent, half, ...size })) continue;

        // 闭环校验：糊过的图再问一遍，看不清才算成功
        const verdict = (await ask(tmp, verifyPrompt(c.code), apiKey, 8)).toLowerCase();
        if (verdict.includes('no') || verdict.includes('否')) {
          current = tmp;
          maskedCount++;
          done = true;
          break;
        }
        // 还看得见 → 换更宽的带子继续试
      }

      if (!done) {
        anyFailed = true;
        reasons.push(`${path.basename(src)} 的码 ${c.code} 未能完全遮住`);
        console.log(`  ⚠️ 无法安全遮挡 "${c.code}"，这张截图将不用于成片`);
      } else {
        console.log(`  🔒 已遮挡优惠码 "${c.code}"（纵向 ${yPercent}% 附近）`);
      }
    }

    // 遮不住就**不要用这张图** —— 宁可少一个画面，也不能把码放出去
    if (anyFailed) continue;

    outPaths.push(current);
  }

  return { paths: outPaths, maskedCount, reasons };
}
