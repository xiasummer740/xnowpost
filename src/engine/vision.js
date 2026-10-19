/**
 * 截图理解：把用户上传的界面截图读成文字，喂给文案生成器。
 *
 * 为什么需要这一步：
 *   以前上传截图只是"贴在画面里"，文案仍然是 AI 凭空写的，两者毫无关系，
 *   观众看到一张看不到重点的图 + 一段无关的旁白。
 *   真正有用的做法是先让视觉模型读出截图里的具体信息（产品名、数字、价格、
 *   对比、卖点），再把这份"材料"交给 DeepSeek，让它围绕截图的真实内容写脚本。
 *
 * 走 SiliconFlow 的 OpenAI 兼容接口（用户已配好的 Key 可以直接用），
 * 模型选 Qwen3-VL-8B：便宜、快，识界面截图足够。
 * 任何失败都返回空字符串 —— 截图理解只是增强，绝不能让整条视频因此失败。
 */
import fs from 'fs-extra';
import path from 'path';

const MODEL = 'Qwen/Qwen3-VL-8B-Instruct';
const BASE = process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1';
const MAX_IMAGES = 4;        // 再多也没有信息增量，只会烧钱
const TIMEOUT_MS = 90000;

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.bmp': 'image/bmp',
};

const INSTRUCTION = `你是内容分析师。请仔细阅读这些截图，输出中文要点，供短视频脚本使用。

要求：
1. 先判断截图是什么：产品后台 / 数据面板 / 聊天记录 / 商品页 / 广告后台 / 教程步骤……
2. 逐项列出截图里**真实出现**的信息：页面标题、产品名、关键数字（粉丝数、播放量、价格、涨幅）、功能按钮、用户评价、对比关系。
3. 特别标出"最抓人的那个点"——比如某个很夸张的涨幅、很低的价格、很明显的对比。
4. 只写截图里确实有的内容，绝对不要编造。看不清就写"不清晰"。
5. 300 字以内，分条列出，不要客套话。`;

function toDataUri(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'image/png';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

/**
 * 读一组截图，返回中文要点文本。
 * @param {string[]} imagePaths 图片绝对路径
 * @param {object} opts { apiKey, model, timeoutMs }
 * @returns {Promise<string>} 失败返回 ''
 */
export async function describeScreenshots(imagePaths, opts = {}) {
  const list = (imagePaths || [])
    .filter(p => typeof p === 'string' && p && fs.existsSync(p))
    .slice(0, MAX_IMAGES);
  if (!list.length) return '';

  const apiKey = opts.apiKey || process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    console.log('  ⚠️ 没有 SiliconFlow Key，跳过截图理解');
    return '';
  }

  const model = opts.model || MODEL;
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;

  const content = [{ type: 'text', text: INSTRUCTION }];
  for (const p of list) {
    try {
      content.push({ type: 'image_url', image_url: { url: toDataUri(p) } });
    } catch (e) {
      console.log(`  ⚠️ 截图读取失败（跳过）: ${path.basename(p)} — ${e.message}`);
    }
  }
  if (content.length === 1) return '';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    console.log(`  👁️ 正在理解你上传的 ${list.length} 张截图（${model}）...`);
    const resp = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: 800,
        temperature: 0.3,
      }),
      signal: ctrl.signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      // 402 = 硅基流动余额不足。这个必须说清楚，否则只是静默降级成"没读懂截图"，
      // 用户会以为功能坏了（实际已经发生过：14:07 起一直是这个错）。
      if (resp.status === 402) {
        console.log('  ⚠️ 硅基流动余额不足（HTTP 402），已跳过截图理解；充值后自动恢复');
      } else if (resp.status === 401) {
        console.log('  ⚠️ 硅基流动 Key 无效（HTTP 401），已跳过截图理解');
      } else {
        console.log(`  ⚠️ 截图理解失败 HTTP ${resp.status}: ${body.slice(0, 160)}`);
      }
      return '';
    }

    const data = await resp.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();
    if (!text) {
      console.log('  ⚠️ 截图理解返回空内容');
      return '';
    }
    const oneLine = text.replace(/\s+/g, ' ').slice(0, 90);
    console.log(`  ✅ 截图内容: ${oneLine}...`);
    return text;
  } catch (e) {
    const reason = e.name === 'AbortError' ? '超时' : e.message;
    console.log(`  ⚠️ 截图理解失败（${reason}），不影响生成`);
    return '';
  } finally {
    clearTimeout(timer);
  }
}
