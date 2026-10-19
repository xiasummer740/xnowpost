import axios from 'axios';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import fs from 'fs-extra';
import path from 'path';
import { trackKolors } from './cost.js';
import { getImageConfig } from './config.js';
import { writeFileAtomic } from '../fs-atomic.js';
import { registerCjkFont, FONT } from './fonts.js';

// 中文字体回退链在 fonts.js 里（P2-27）：
// 注册失败会明确报错，调用方可用 getFontStatus() 感知"中文会变方块"
registerCjkFont((fontPath, alias) => GlobalFonts.registerFromPath(fontPath, alias));

/**
 * 质量统计：本次运行有多少张图降级成了纯 Canvas 占位图。
 *
 * 降级是为了"不让整段视频失败"，但**必须让用户知道成片画面被降级了** ——
 * 否则他花了钱、拿到片、却不知道画面是空白占位。
 */
export const imageQuality = { canvasFallbacks: 0 };

/** 从错误里判断 HTTP 状态码（axios 的消息形如 "Request failed with status code 429"） */
function httpStatusOf(err) {
  const msg = String(err?.message || '');
  const m = msg.match(/status code (\d{3})/i) || msg.match(/\b(429|5\d\d)\b/);
  return m ? Number(m[1]) : 0;
}

/** 读取 Retry-After（秒数或 HTTP 日期），拿不到返回 0 */
function retryAfterMsOf(err) {
  const h = err?.response?.headers || err?.headers || {};
  const raw = h['retry-after'] ?? h['Retry-After'];
  if (raw === undefined || raw === null || raw === '') return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(String(raw));
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

/**
 * 计算本次重试该等多久。
 *
 * 旧实现固定等 `image.retryDelay`（2 秒），对 429 限流毫无意义 ——
 * 实测 3 次重试全在同一秒内撞墙，最后白白降级成占位图。
 * 这里：429 用指数退避并尊重 Retry-After；5xx 也退避；其它错误用基础延迟。
 */
export function retryWaitMs(err, attempt, baseDelay = 2000) {
  const status = httpStatusOf(err);
  const retryAfter = retryAfterMsOf(err);

  if (status === 429) {
    const backoff = 5000 * Math.pow(2, attempt);          // 5s → 10s → 20s
    return Math.min(Math.max(retryAfter, backoff), 45_000);
  }
  if (status >= 500) {
    return Math.min(baseDelay * Math.pow(2, attempt), 30_000);
  }
  return Number.isFinite(baseDelay) && baseDelay > 0 ? baseDelay : 2000;
}

export { httpStatusOf, retryAfterMsOf };

// 品牌色系统一
const BRAND = {
  orange: '#f59e0b',
  orangeDark: '#d97706',
  red: '#ef4444',
  white: '#ffffff',
  dark: '#000000',
  gray: 'rgba(255,255,255,0.5)',
};

// Kolors 尺寸映射
function toKolorsSize(w, h) {
  const ratio = w / h;
  if (ratio > 1.5) return '1024x576';  // 16:9 横屏
  if (ratio > 1.2) return '768x1024';  // 3:4
  if (ratio > 0.9) return '1024x1024'; // 1:1
  return '576x1024';                     // 9:16 竖屏
}

function getLayout(w, h) {
  const ratio = w / h;
  if (ratio > 1.5) return 'landscape'; // 16:9 横屏
  if (ratio > 1.2) return 'portrait3x4'; // 3:4
  return 'portrait';                     // 9:16 竖屏
}

// 根据策略动态切换品牌标签
function getBrandTag(strategyKey) {
  const map = {
    price_hook: '💰 全网最低价',
    growth_tips: '📈 运营干货',
    social_proof: '⭐ 真实数据',
    agent_recruit: '🤝 合伙人计划',
    multi_platform: '🌐 全平台矩阵',
  };
  return map[strategyKey] || '⚡ XNOW';
}

// 增强图片 Prompt（含镜头语言和氛围）
function enhancePrompt(prompt, layout, shotType, cameraMove, mood) {
  const base = prompt.trim();
  const parts = [base];

  // 镜头类型
  if (shotType === 'close_up') parts.push('close-up shot, focus on face/expression, shallow depth of field');
  else if (shotType === 'medium') parts.push('medium shot, waist-up framing');
  else if (shotType === 'wide') parts.push('wide shot, full scene, environmental context');
  else if (shotType === 'detail') parts.push('extreme close-up, macro detail, text or object focused');

  // 运镜提示
  if (cameraMove === 'push') parts.push('dolly zoom effect, dramatic forward perspective');
  else if (cameraMove === 'pull') parts.push('pulling back, revealing wider context');
  else if (cameraMove === 'pan') parts.push('horizontal panning motion, sweeping view');
  else if (cameraMove === 'follow') parts.push('tracking shot, following subject movement');
  else if (cameraMove === 'tilt_up' || cameraMove === 'tilt_down') parts.push('vertical tilt, dramatic angle shift');

  // 氛围
  if (mood === 'urgent') parts.push('high tension atmosphere, dramatic lighting, high contrast');
  else if (mood === 'hopeful') parts.push('warm golden light, optimistic atmosphere, bright');
  else if (mood === 'trust') parts.push('warm neutral lighting, professional setting, credible');
  else if (mood === 'excited') parts.push('vibrant colors, energetic composition, dynamic');
  else if (mood === 'curious') parts.push('intriguing composition, mystery lighting, selective focus');
  else if (mood === 'surprised') parts.push('wide-eyed expression, dramatic reveal lighting');

  // 布局
  if (layout === 'landscape') {
    parts.push('horizontal composition, wide aspect, professional marketing visual');
  } else {
    parts.push('vertical composition for social media story, photorealistic, natural lighting');
  }

  return parts.join(', ');
}

async function fetchAIImage(prompt, kolorsSize, layout, shotType, cameraMove, mood) {
  const key = process.env.SILICONFLOW_API_KEY;
  if (!key) throw new Error('no key');
  const resp = await axios.post('https://api.siliconflow.cn/v1/images/generations', {
    model: 'Kwai-Kolors/Kolors',
    prompt: enhancePrompt(prompt, layout, shotType, cameraMove, mood),
    image_size: kolorsSize, batch_size: 1, guidance_scale: 7.5,
  }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 120000 });
  const url = resp.data?.images?.[0]?.url || resp.data?.data?.[0]?.url;
  if (!url) throw new Error('no url');
  // ⚠️ 拿到 URL 就说明服务端已经生成并计费（P1-6：此前 trackKolors 零调用点，
  //    cost.json / 控制台汇总的 Kolors 恒为 ¥0.00，费用一直低报）。
  //    放在这里而不是下载成功之后：下载失败也已经被计费了。
  trackKolors(1);
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(r.data);
}

// ==== 竖屏布局 (9:16 / 3:4) ====
function drawPortrait(ctx, w, h, title, subtitle, points, index, tags) {
  // 轻量暗化
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(0,0,0,0.15)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.05)');
  g.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

  // 品牌标签
  const tagH = Math.round(h * 0.045);
  const tagW = Math.round(w * 0.35);
  ctx.fillStyle = `rgba(245,158,11,0.85)`;
  roundRect(ctx, 36, Math.round(h*0.06), tagW, tagH, tagH/2); ctx.fill();
  ctx.font = `bold ${Math.round(tagH*0.5)}px ${FONT}`;
  ctx.fillStyle = BRAND.dark; ctx.textAlign = 'left';
  ctx.fillText(getBrandTag(tags?.[0]), 50, Math.round(h*0.06) + tagH*0.66);

  // 序号
  if (index > 0) {
    ctx.textAlign = 'right';
    ctx.fillStyle = BRAND.gray;
    ctx.font = `bold ${Math.round(h*0.018)}px ${FONT}`;
    ctx.fillText(`${index}/4`, w - 36, Math.round(h*0.06) + tagH*0.66);
  }

  // 主标题 (描边增强，字号缩小确保不溢出)
  if (title) {
    const ts = Math.round(h * 0.042);
    ctx.font = `bold ${ts}px ${FONT}`; ctx.textAlign = 'center';
    const maxW = w * 0.82;
    const lines = wrapText(ctx, title, maxW);
    const lh = ts * 1.35, sy = h * 0.24;
    lines.slice(0, 3).forEach((l, i) => {
      const y = sy + i * lh;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = ts * 0.12; ctx.strokeText(l, w/2, y);
      ctx.fillStyle = BRAND.white; ctx.fillText(l, w/2, y);
    });
  }

  // 卖点卡片
  if (points?.length) {
    const pSize = Math.round(h * 0.024);
    ctx.font = `bold ${pSize}px ${FONT}`; ctx.textAlign = 'center';
    const icons = ['💎','⚡','🔥','🎯'];
    const valid = points.filter(Boolean).slice(0, 4);
    const cardW = w * 0.82, cardX = (w - cardW) / 2;
    const cardY = h * 0.52, cardH = valid.length * pSize * 1.8 + pSize;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(ctx, cardX, cardY, cardW, cardH, 14); ctx.fill();
    ctx.fillStyle = BRAND.orange; ctx.fillRect(cardX + 16, cardY, cardW - 32, 2);

    valid.forEach((pt, i) => {
      ctx.fillStyle = BRAND.white;
      ctx.fillText(`${icons[i]||'✅'}  ${pt}`, w/2, cardY + pSize * 1.2 + i * pSize * 1.8);
    });
  }

  // 软CTA (64% 位置)
  const softY = h * 0.64;
  const softSize = Math.round(h * 0.02);
  ctx.font = `${softSize}px ${FONT}`; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText('👇 想知道具体价格？继续往下看', w/2, softY);

  // 硬CTA 按钮 (78% 位置)
  const ctaY = h * 0.78, ctaSize = Math.round(h * 0.024);
  ctx.font = `bold ${ctaSize}px ${FONT}`;
  const ctaText = '🔥 立即注册 · xnow.taikon.top';
  const ctaW = ctx.measureText(ctaText).width + 50, ctaH = ctaSize * 2.2;
  const ctaX = (w - ctaW) / 2;

  ctx.shadowColor = 'rgba(245,158,11,0.5)'; ctx.shadowBlur = 18;
  ctx.fillStyle = BRAND.orange;
  roundRect(ctx, ctaX, ctaY, ctaW, ctaH, ctaH/2); ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = BRAND.dark; ctx.fillText(ctaText, w/2, ctaY + ctaH*0.62);

  // 底部
  ctx.font = `${Math.round(h*0.016)}px ${FONT}`;
  ctx.fillStyle = BRAND.gray; ctx.textAlign = 'center';
  ctx.fillText('秒级交付 · 无需密码 · 全网最低价', w/2, h - 25);
}

// ==== 横屏布局 (16:9) ====
function drawLandscape(ctx, w, h, title, subtitle, points, index, tags) {
  // 左侧图片区域 (占 55%)，右侧文字卡片 (占 45%)
  const splitX = Math.round(w * 0.55);

  // 右侧深色背景
  const rg = ctx.createLinearGradient(splitX, 0, w, 0);
  rg.addColorStop(0, 'rgba(0,0,0,0.7)');
  rg.addColorStop(1, 'rgba(0,0,0,0.85)');
  ctx.fillStyle = rg; ctx.fillRect(splitX, 0, w - splitX, h);

  // 分割线
  ctx.fillStyle = BRAND.orange;
  ctx.fillRect(splitX, 0, 4, h);

  // 品牌标签 (右侧顶部)
  const tagH = Math.round(h * 0.06);
  ctx.fillStyle = `rgba(245,158,11,0.85)`;
  roundRect(ctx, splitX + 20, 30, Math.round((w-splitX)*0.7), tagH, tagH/2); ctx.fill();
  ctx.font = `bold ${Math.round(tagH*0.5)}px ${FONT}`;
  ctx.fillStyle = BRAND.dark; ctx.textAlign = 'left';
  ctx.fillText(getBrandTag(tags?.[0]), splitX + 34, 30 + tagH*0.66);

  // 标题 (右侧，字号缩小)
  if (title) {
    const ts = Math.round(h * 0.055);
    ctx.font = `bold ${ts}px ${FONT}`; ctx.textAlign = 'left';
    const maxW = (w - splitX) * 0.82;
    const lines = wrapText(ctx, title, maxW);
    const lh = ts * 1.35, sy = h * 0.18;
    lines.slice(0, 3).forEach((l, i) => {
      const y = sy + i * lh;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = ts * 0.12; ctx.strokeText(l, splitX + 30, y);
      ctx.fillStyle = BRAND.white; ctx.fillText(l, splitX + 30, y);
    });
  }

  // 卖点 (右侧)
  if (points?.length) {
    const pSize = Math.round(h * 0.03);
    ctx.font = `bold ${pSize}px ${FONT}`; ctx.textAlign = 'left';
    const icons = ['💎','⚡','🔥','🎯'];
    points.filter(Boolean).slice(0, 4).forEach((pt, i) => {
      const y = h * 0.45 + i * pSize * 1.8;
      ctx.fillStyle = BRAND.white;
      ctx.fillText(`${icons[i]||'✅'}  ${pt}`, splitX + 30, y);
    });
  }

  // CTA 按钮 (右侧底部)
  const ctaSize = Math.round(h * 0.03);
  ctx.font = `bold ${ctaSize}px ${FONT}`; ctx.textAlign = 'left';
  ctx.fillStyle = BRAND.orange;
  const ctaW = Math.round((w - splitX) * 0.75), ctaH = ctaSize * 2;
  roundRect(ctx, splitX + 30, h - ctaH - 30, ctaW, ctaH, ctaH/2); ctx.fill();
  ctx.fillStyle = BRAND.dark;
  ctx.fillText('🔥 立即注册 xnow.taikon.top', splitX + 50, h - 30 - ctaH*0.4);

  // 底部
  ctx.font = `${Math.round(h*0.022)}px ${FONT}`;
  ctx.fillStyle = BRAND.gray; ctx.textAlign = 'center';
  ctx.fillText('秒级交付 · 无需密码 · 全网最低价', w/2, h - 10);
}

// === 主渲染 ===
async function overlayText(baseBuffer, opts) {
  const { width, height, title, subtitle, tags, index, points } = opts;
  const img = await loadImage(baseBuffer);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 底图 fill
  const scale = Math.max(width / img.width, height / img.height);
  ctx.drawImage(img, -(img.width*scale-width)/2, -(img.height*scale-height)/2, img.width*scale, img.height*scale);

  const layout = getLayout(width, height);
  if (layout === 'landscape') {
    drawLandscape(ctx, width, height, title, subtitle, points, index, tags);
  } else {
    drawPortrait(ctx, width, height, title, subtitle, points, index, tags);
  }

  return canvas.toBuffer('image/png');
}

// === Canvas 回退 ===
function generateWithCanvas(opts) {
  const { width, height, title, index, points } = opts;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const layout = getLayout(width, height);

  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, '#1e293b'); grad.addColorStop(0.5, '#334155'); grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, width, height);

  // XNOW 暗纹
  ctx.globalAlpha = 0.04;
  ctx.font = `bold ${Math.round(Math.min(width,height)*0.25)}px ${FONT}`;
  ctx.fillStyle = BRAND.white; ctx.textAlign = 'center';
  ctx.fillText('XNOW', width/2, height/2 + 40);
  ctx.globalAlpha = 1;

  if (layout === 'landscape') {
    const splitX = Math.round(width * 0.55);
    const rg = ctx.createLinearGradient(splitX, 0, width, 0);
    rg.addColorStop(0, 'rgba(0,0,0,0.75)'); rg.addColorStop(1, 'rgba(0,0,0,0.9)');
    ctx.fillStyle = rg; ctx.fillRect(splitX, 0, width - splitX, height);
    ctx.fillStyle = BRAND.orange; ctx.fillRect(splitX, 0, 4, height);

    if (title) {
      const ts = Math.round(height * 0.055);
      ctx.font = `bold ${ts}px ${FONT}`; ctx.textAlign = 'left';
      const lines = wrapText(ctx, title, (width-splitX)*0.82);
      lines.slice(0,3).forEach((l,i) => {
        ctx.fillStyle = BRAND.white;
        ctx.fillText(l, splitX+30, height*0.2 + i*ts*1.35);
      });
    }
  } else {
    // 竖屏 fallback
    if (title) {
      const ts = Math.round(height * 0.042);
      ctx.font = `bold ${ts}px ${FONT}`; ctx.textAlign = 'center';
      const lines = wrapText(ctx, title, width*0.82);
      lines.slice(0,3).forEach((l,i) => {
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = ts*0.12;
        ctx.strokeText(l, width/2, height*0.3 + i*ts*1.4);
        ctx.fillStyle = BRAND.white; ctx.fillText(l, width/2, height*0.3 + i*ts*1.4);
      });
    }
  }

  // 统一 CTA
  ctx.fillStyle = BRAND.orange;
  const ctaH2 = Math.round(height*0.05);
  roundRect(ctx, (width-260)/2, height - ctaH2 - 30, 260, ctaH2, ctaH2/2); ctx.fill();
  ctx.font = `bold ${Math.round(ctaH2*0.48)}px ${FONT}`; ctx.textAlign = 'center';
  ctx.fillStyle = BRAND.dark;
  ctx.fillText('🔥 立即注册 xnow.taikon.top', width/2, height - 30 - ctaH2*0.4);

  return canvas.toBuffer('image/png');
}

// === 工具函数 ===
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y);
  ctx.quadraticCurveTo(x+w,y,x+w,y+r); ctx.lineTo(x+w,y+h-r);
  ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h); ctx.lineTo(x+r,y+h);
  ctx.quadraticCurveTo(x,y+h,x,y+h-r); ctx.lineTo(x,y+r);
  ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}

function wrapText(ctx, text, maxW) {
  if (!text) return [];
  const lines = []; let line = '';
  // 统一按字符切分（不管中英文），遇到空格保留作为换行机会
  const chars = [...text];
  for (const c of chars) {
    const test = line + c;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = c === ' ' ? '' : c;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// === 导出 ===
export async function generateImage({ prompt, width=1080, height=1920, seed, index=0, title, subtitle, tags, points, shotType, cameraMove, mood }) {
  const kolorsSize = toKolorsSize(width, height);
  const layout = getLayout(width, height);
  // 把文案文本追加到生图 prompt，让图片内容与文案匹配
  const enhancedPrompt = title
    ? `${prompt}, the scene visually reflects the text concept: "${title.substring(0, 60)}"`
    : prompt;

  // 底图最多试 cfg.retries 次（config/default.json 的 image.retries/retryDelay，
  // 此前这两个字段无人读取）。注意：重试只包住"取底图"这一步 ——
  // 文字叠加失败不会重新调用 AI，避免重复计费。
  const cfg = getImageConfig();
  let base = null;
  let lastErr = null;
  for (let attempt = 0; attempt <= cfg.retries && !base; attempt++) {
    try {
      if (attempt === 0) console.log(`  🤖 底图(${kolorsSize}): ${(enhancedPrompt||'').substring(0,40)}...`);
      else console.log(`  🔁 底图重试 ${attempt}/${cfg.retries}...`);
      base = await fetchAIImage(enhancedPrompt, kolorsSize, layout, shotType, cameraMove, mood);
    } catch (err) {
      lastErr = err;
      if (attempt < cfg.retries) {
        const wait = retryWaitMs(err, attempt, cfg.retryDelay);
        const status = httpStatusOf(err);
        console.log(`  ⏳ ${status === 429 ? '限流(429)' : status ? `${status}` : '暂时性错误'}，${(wait / 1000).toFixed(1)}s 后重试`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }

  if (!base) {
    imageQuality.canvasFallbacks++;
    console.log(`  ⚠️ AI(${lastErr ? lastErr.message : 'unknown'}), 回退纯 Canvas（该张为占位图，画面降级）`);
    return generateWithCanvas({ width, height, title, subtitle, tags, index, points });
  }

  try {
    console.log(`  ✍️ 叠加...`);
    return await overlayText(base, { width, height, title, subtitle, tags, index, points });
  } catch (err) {
    console.log(`  ⚠️ 文字叠加失败(${err.message})，改用纯 Canvas`);
    return generateWithCanvas({ width, height, title, subtitle, tags, index, points });
  }
}

export async function generateImageToFile(opts) {
  const buf = await generateImage(opts);
  await fs.ensureDir(path.dirname(opts.filepath));
  // 原子写：进程被杀不会留下半截 PNG（半截图会让 FFmpeg 合成直接失败）
  await writeFileAtomic(opts.filepath, buf);
  console.log(`  ✅ ${opts.filepath} (${(buf.length/1024).toFixed(0)}KB)`);
  return opts.filepath;
}

/**
 * 生成"纯 Canvas 占位图"并落盘 —— 不调用 AI、不产生费用。
 * 用途：某个分镜图缺失时补齐画面，保证 concat 列表与配音时间轴仍然一一对应
 * （P2-1：缺一张图就整段视频合成失败，或时间轴错位）。
 */
export async function generatePlaceholderToFile(opts = {}) {
  const width = opts.width || 1080;
  const height = opts.height || 1920;
  const buf = generateWithCanvas({ ...opts, width, height });
  await fs.ensureDir(path.dirname(opts.filepath));
  await writeFileAtomic(opts.filepath, buf);
  console.log(`  🧩 占位图已生成: ${opts.filepath}`);
  return opts.filepath;
}
