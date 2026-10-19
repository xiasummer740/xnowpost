import axios from 'axios';
import fs from 'fs-extra';
import { getTelegramConfig } from './engine/config.js';

const TOKEN = process.env.TG_BOT_TOKEN;
const CHANNEL_ID = process.env.TG_CHANNEL_ID;

const BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

/** 是否已配置 TG（调用方可据此区分"没配"与"发失败"） */
export function isTelegramConfigured() {
  return !!BASE;
}

/**
 * 发送文本消息
 * ⚠️ 失败必须抛错（P2-23）：旧实现 catch 之后只 console.error 就返回 undefined，
 *    调用方（daily.js / 主进程）拿到 undefined 仍然打印"✅ 日报已推送到 TG"，
 *    于是推送挂掉时没有任何人知道。
 * @returns {Promise<object|null>} 成功返回 TG 响应；未配置返回 null（明确跳过）
 */
async function sendMessage(text, options = {}) {
  if (!BASE) {
    console.log('⚠️ TG Bot 未配置（缺 TG_BOT_TOKEN），跳过推送');
    return null;
  }

  const { silent, ...rest } = options;
  const cfg = getTelegramConfig();
  try {
    const response = await axios.post(`${BASE}/sendMessage`, {
      chat_id: CHANNEL_ID,
      text,
      parse_mode: cfg.parseMode,
      disable_notification: silent ?? cfg.disableNotification,
      ...rest,
    });
    return response.data;
  } catch (err) {
    const status = err.response?.status ?? '';
    const detail = err.response?.data?.description || err.message;
    throw new Error(`TG 推送失败 ${status} ${detail}`.trim());
  }
}

async function sendPhoto(caption, filePath) {
  if (!BASE) return null;

  try {
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('chat_id', CHANNEL_ID);
    form.append('photo', fs.createReadStream(filePath));
    form.append('caption', caption);
    form.append('parse_mode', getTelegramConfig().parseMode);

    const response = await axios.post(`${BASE}/sendPhoto`, form, {
      headers: form.getHeaders(),
    });
    return response.data;
  } catch (err) {
    const detail = err.response?.data?.description || err.response?.data || err.message;
    throw new Error(`TG 图片推送失败: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
}

async function sendVideo(caption, filePath) {
  if (!BASE) return null;

  try {
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('chat_id', CHANNEL_ID);
    form.append('video', fs.createReadStream(filePath));
    form.append('caption', caption);
    form.append('parse_mode', getTelegramConfig().parseMode);

    const response = await axios.post(`${BASE}/sendVideo`, form, {
      headers: form.getHeaders(),
    });
    return response.data;
  } catch (err) {
    const detail = err.response?.data?.description || err.response?.data || err.message;
    throw new Error(`TG 视频推送失败: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
}

// === 格式化输出 ===

/** HTML 转义：内容里出现 <、>、& 会破坏 parse_mode=HTML 的整条消息 */
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 标签行：tags_zh/tags_en 可能缺失（旧实现直接展开会让整条通知抛错） */
function tagsLine(tagsZh, tagsEn) {
  const all = [
    ...(Array.isArray(tagsZh) ? tagsZh : []),
    ...(Array.isArray(tagsEn) ? tagsEn : []),
  ].filter(Boolean);
  return all.length ? esc(all.map(t => '#' + String(t).trim()).join(' ')) : '（无标签）';
}

export function formatVideoMessage(content = {}, index, timeLabel) {
  const { title_zh, title_en, tags_zh, tags_en, strategy, scenes } = content;
  const list = Array.isArray(scenes) ? scenes : [];
  const sceneText = list.length
    ? list.map((s, i) => `第${i + 1}镜: ${esc(s?.scene_text_zh || '')}`).join(' | ')
    : '（无分镜）';

  return [
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📅 ${new Date().toLocaleDateString('zh-CN')} · ${esc(timeLabel)} · 第${index}条 · 🔴视频`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `📝 <b>${esc(title_zh || '(无标题)')}</b>`,
    `📝 <i>${esc(title_en || '')}</i>`,
    ``,
    `📜 分镜速览`,
    `${sceneText}`,
    ``,
    `🏷️ <b>标签</b>`,
    `${tagsLine(tags_zh, tags_en)}`,
    ``,
    `📌 策略: ${esc(strategy?.label || '未知')}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
  ].join('\n');
}

export function formatPostMessage(content = {}, index, timeLabel) {
  const { title_zh, title_en, body_zh, body_en, tags_zh, tags_en, strategy } = content;

  return [
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📅 ${new Date().toLocaleDateString('zh-CN')} · ${esc(timeLabel)} · 第${index}条 · 🟢图文`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `📝 <b>${esc(title_zh || '(无标题)')}</b>`,
    `📝 <i>${esc(title_en || '')}</i>`,
    ``,
    `📄 <b>中文文案</b>`,
    `${esc(body_zh || '')}`,
    ``,
    `📄 <b>English</b>`,
    `${esc(body_en || '')}`,
    ``,
    `🏷️ <b>标签（直接复制）</b>`,
    `${tagsLine(tags_zh, tags_en)}`,
    ``,
    `📌 策略: ${esc(strategy?.label || '未知')}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
  ].join('\n');
}

/**
 * 推送视频
 * @returns {Promise<{ok:boolean, skipped:boolean, error?:string}>}
 *          明确返回结果，调用方不再"猜"是否推送成功（P2-23）
 */
export async function pushVideoContent(content, index, videoPath, timeLabel) {
  if (!BASE) {
    console.log('  ⚠️ TG 未配置，跳过视频推送');
    return { ok: false, skipped: true };
  }
  const text = formatVideoMessage(content, index, timeLabel);
  try {
    if (videoPath && await fs.pathExists(videoPath)) {
      await sendVideo(text, videoPath);
    } else {
      await sendMessage(text);
    }
    console.log('  ✅ 视频已推送到 TG');
    return { ok: true, skipped: false };
  } catch (err) {
    console.error(`  ❌ 视频推送失败: ${err.message}`);
    return { ok: false, skipped: false, error: err.message };
  }
}

/**
 * 推送图文
 * @returns {Promise<{ok:boolean, skipped:boolean, error?:string}>}
 */
export async function pushPostContent(content, index, imagePath, timeLabel) {
  if (!BASE) {
    console.log('  ⚠️ TG 未配置，跳过图文推送');
    return { ok: false, skipped: true };
  }
  const text = formatPostMessage(content, index, timeLabel);
  try {
    await sendMessage(text);
    if (imagePath && await fs.pathExists(imagePath)) {
      await sendPhoto(`${esc(content.title_zh)} | ${esc(content.title_en)}`, imagePath);
    }
    console.log('  ✅ 图文已推送到 TG');
    return { ok: true, skipped: false };
  } catch (err) {
    console.error(`  ❌ 图文推送失败: ${err.message}`);
    return { ok: false, skipped: false, error: err.message };
  }
}

export { sendMessage, sendPhoto, sendVideo };
