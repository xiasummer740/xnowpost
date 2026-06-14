import axios from 'axios';
import fs from 'fs-extra';

const TOKEN = process.env.TG_BOT_TOKEN;
const CHANNEL_ID = process.env.TG_CHANNEL_ID;

const BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

async function sendMessage(text, options = {}) {
  if (!BASE) {
    console.log('⚠️ TG Bot 未配置，跳过推送');
    return null;
  }

  try {
    const response = await axios.post(`${BASE}/sendMessage`, {
      chat_id: CHANNEL_ID,
      text,
      parse_mode: 'HTML',
      disable_notification: options.silent || false,
      ...options,
    });
    return response.data;
  } catch (err) {
    console.error('❌ TG 推送失败:', err.response?.status, err.response?.data?.description || err.message);
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
    form.append('parse_mode', 'HTML');

    const response = await axios.post(`${BASE}/sendPhoto`, form, {
      headers: form.getHeaders(),
    });
    return response.data;
  } catch (err) {
    console.error('❌ TG 图片推送失败:', err.response?.data || err.message);
    throw err;
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
    form.append('parse_mode', 'HTML');

    const response = await axios.post(`${BASE}/sendVideo`, form, {
      headers: form.getHeaders(),
    });
    return response.data;
  } catch (err) {
    console.error('❌ TG 视频推送失败:', err.response?.data || err.message);
    throw err;
  }
}

// === 格式化输出 ===

export function formatVideoMessage(content, index, timeLabel) {
  const { title_zh, title_en, tags_zh, tags_en, strategy, scenes } = content;

  const sceneText = scenes.map((s, i) => `第${i+1}镜: ${s.scene_text_zh}`).join(' | ');

  return [
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📅 ${new Date().toLocaleDateString('zh-CN')} · ${timeLabel} · 第${index}条 · 🔴视频`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `📝 <b>${title_zh}</b>`,
    `📝 <i>${title_en}</i>`,
    ``,
    `📜 分镜速览`,
    `${sceneText}`,
    ``,
    `🏷️ <b>标签</b>`,
    `${[...tags_zh, ...tags_en].map(t => '#' + t).join(' ')}`,
    ``,
    `📌 策略: ${strategy.label}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
  ].join('\n');
}

export function formatPostMessage(content, index, timeLabel) {
  const { title_zh, title_en, body_zh, body_en, tags_zh, tags_en, strategy } = content;

  return [
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📅 ${new Date().toLocaleDateString('zh-CN')} · ${timeLabel} · 第${index}条 · 🟢图文`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `📝 <b>${title_zh}</b>`,
    `📝 <i>${title_en}</i>`,
    ``,
    `📄 <b>中文文案</b>`,
    `${body_zh}`,
    ``,
    `📄 <b>English</b>`,
    `${body_en}`,
    ``,
    `🏷️ <b>标签（直接复制）</b>`,
    `${[...tags_zh, ...tags_en].map(t => '#' + t).join(' ')}`,
    ``,
    `📌 策略: ${strategy.label}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
  ].join('\n');
}

export async function pushVideoContent(content, index, videoPath, timeLabel) {
  const text = formatVideoMessage(content, index, timeLabel);

  if (videoPath && await fs.pathExists(videoPath)) {
    await sendVideo(text, videoPath);
  } else {
    await sendMessage(text);
  }
}

export async function pushPostContent(content, index, imagePath, timeLabel) {
  const text = formatPostMessage(content, index, timeLabel);

  await sendMessage(text);
  if (imagePath && await fs.pathExists(imagePath)) {
    await sendPhoto(`${content.title_zh} | ${content.title_en}`, imagePath);
  }
}

export { sendMessage, sendPhoto, sendVideo };
