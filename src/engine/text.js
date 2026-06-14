import 'dotenv/config';
import OpenAI from 'openai';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { pickStrategy } from './strategy.js';
import { trackDeepSeek } from './cost.js';
import { isDuplicate } from './dedup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
});

function loadPrompt(type) {
  return fs.readFileSync(
    path.join(__dirname, '..', '..', 'config', 'prompts', `content_${type}.txt`),
    'utf-8'
  );
}

// 防注入：清洗策略描述中的潜在指令覆盖词
function sanitizeForPrompt(text) {
  return text
    .replace(/system[:：]/gi, '[blocked]')
    .replace(/user[:：]/gi, '[blocked]')
    .replace(/assistant[:：]/gi, '[blocked]')
    .replace(/ignore\s+all/i, '[blocked]')
    .replace(/你(的)?任务/i, '内容')
    .substring(0, 800);
}

let globalUserTopic = '';

export function setUserTopic(topic) {
  globalUserTopic = topic ? sanitizeForPrompt(topic).substring(0, 200) : '';
}

function buildPrompt(template, strategy) {
  let prompt = template
    .replace('{STRATEGY_LABEL}', sanitizeForPrompt(strategy.label))
    .replace('{STRATEGY_DESC}', sanitizeForPrompt(strategy.desc))
    .replace('{SCENE_COUNT}', '9');

  if (globalUserTopic) {
    prompt = prompt.replace('{USER_TOPIC}', `\n## 用户指定的主题（优先围绕此主题创作）\n${globalUserTopic}\n`);
  } else {
    prompt = prompt.replace('{USER_TOPIC}', '');
  }

  return prompt;
}

// ============ 健壮 JSON 解析 ============

function robustJSONParse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();
  // 1. 去 markdown 代码块包裹
  text = text.replace(/^```(?:json)?\s*/gm, '').replace(/\s*```$/gm, '');
  // 2. 直接解析
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  // 3. 截取第一个 { 到最后一个 }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.substring(start, end + 1)); } catch (e) { /* fall through */ }
  }
  return null;
}

// ============ 内容校验 ============

function validateVideoContent(data) {
  const errors = [];
  if (!data) return { valid: false, errors: ['返回为空'] };
  if (!data.title_zh || !data.title_zh.trim()) errors.push('缺少 title_zh');
  if (!data.title_en || !data.title_en.trim()) errors.push('缺少 title_en');
  if (!Array.isArray(data.scenes)) errors.push('scenes 不是数组');
  else if (data.scenes.length < 1) errors.push('scenes 为空数组');
  else {
    data.scenes.forEach((s, i) => {
      if (!s.scene_text_zh || !s.scene_text_zh.trim()) errors.push(`分镜 ${i+1} 缺少 scene_text_zh`);
      if (!s.scene_text_en || !s.scene_text_en.trim()) errors.push(`分镜 ${i+1} 缺少 scene_text_en`);
      if (!s.image_desc || !s.image_desc.trim()) errors.push(`分镜 ${i+1} 缺少 image_desc`);
      if (s.duration !== undefined && (s.duration < 3 || s.duration > 20)) errors.push(`分镜 ${i+1} duration ${s.duration} 超出 [3,20]`);
    });
  }
  return { valid: errors.length === 0, errors };
}

function validatePostContent(data) {
  const errors = [];
  if (!data) return { valid: false, errors: ['返回为空'] };
  if (!data.title_zh || !data.title_zh.trim()) errors.push('缺少 title_zh');
  if (!data.title_en || !data.title_en.trim()) errors.push('缺少 title_en');
  if (!data.body_zh || !data.body_zh.trim()) errors.push('缺少 body_zh');
  if (!data.body_en || !data.body_en.trim()) errors.push('缺少 body_en');
  return { valid: errors.length === 0, errors };
}

// ============ DeepSeek 调用（带自动重试 + 反馈纠正） ============

async function callDeepSeek(sysPrompt, userPrompt, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: 'deepseek-chat',
        temperature: attempt === 0 ? 0.8 : 0.3, // 首次创意，重试时收紧
        max_tokens: 4096,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userPrompt }
        ],
      });

      if (response.usage) trackDeepSeek(response.usage);
      const raw = response.choices[0]?.message?.content;
      if (!raw) throw new Error('DeepSeek 返回空内容');

      const parsed = robustJSONParse(raw);
      if (parsed) return parsed;

      // 解析失败 → 带反馈重试
      if (attempt < retries) {
        console.warn(`  ⚠️ JSON 解析失败（第${attempt+1}次），带纠正重试...`);
        const snippet = raw.substring(0, 150).replace(/\n/g, '\\n');
        userPrompt = [
          `⚠️ 你之前返回的内容格式不对，无法解析为 JSON。`,
          `返回内容开头是: "${snippet}"`,
          ``,
          `请只输出一个合法的 JSON 对象，不要添加任何其他文字、解释或 markdown 标记。`,
          ``,
          userPrompt,
        ].join('\n');
        continue;
      }

      throw new Error(`DeepSeek 返回非法 JSON（已重试${retries}次）: ${raw.substring(0, 200)}`);
    } catch (err) {
      if (attempt < retries) {
        const delay = 1000 * Math.pow(2, attempt); // 退避 1s → 2s
        console.warn(`  ⚠️ API 调用失败（第${attempt+1}次）: ${err.message}，${delay}ms 后重试...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

async function generateWithDedup(type) {
  const MAX = 5;
  for (let attempt = 0; attempt < MAX; attempt++) {
    const strategy = pickStrategy();
    const template = loadPrompt(type);
    const prompt = buildPrompt(template, strategy);

    const content = await callDeepSeek(
      '你是一个专业的海外社交媒体内容营销专家。Always return valid JSON only, no markdown wrapping.',
      prompt
    );

    const title = content.title_zh;
    if (!title) throw new Error('DeepSeek 返回缺少标题');

    // 去重检查
    if (isDuplicate(title) && attempt < MAX - 1) {
      console.log(`  🔄 标题重复，换策略重试(${attempt+1}/${MAX-1})...`);
      continue;
    }

    // 导入去重模块保存标题
    const { saveTitle } = await import('./dedup.js');
    saveTitle(title, strategy.key);

    return { ...content, strategy };
  }
  throw new Error('生成失败：所有尝试都产生重复内容');
}

export async function generateVideoContent(topic) {
  if (topic) setUserTopic(topic);
  const result = await generateWithDedup('video');
  const check = validateVideoContent(result);
  if (!check.valid) {
    throw new Error(`视频内容校验失败: ${check.errors.join('; ')}`);
  }
  return result;
}

export async function generatePostContent(topic) {
  if (topic) setUserTopic(topic);
  const result = await generateWithDedup('post');
  const check = validatePostContent(result);
  if (!check.valid) {
    throw new Error(`图文内容校验失败: ${check.errors.join('; ')}`);
  }
  return result;
}

// ============ 导出（测试用） ============
export { robustJSONParse, validateVideoContent, validatePostContent };
