// 开场镜图生视频（SiliconFlow Wan2.2 I2V）
//
// 为什么需要"图生视频"而不是"文生视频"：
//   文生视频每次生成的产品/人物都长得不一样，多镜之间会跳戏；
//   图生视频以我们自己生成的 AI 图为第一帧，画面主体保持一致，只让它动起来。
//
// 接口契约（docs.siliconflow.com/cn/api-reference/videos）：
//   POST /v1/video/submit  → { requestId }
//   POST /v1/video/status  → { status: Succeed|InQueue|InProgress|Failed, results.videos[].url }
//   ⚠️ 结果链接仅 1 小时有效，必须立刻下载
//   ⚠️ 竖屏最大档是 720x1280（成片 1080x1920，合成时放大）
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';

export const I2V_MODEL = 'Wan-AI/Wan2.2-I2V-A14B';
export const I2V_SIZE = '720x1280';
// 提示词统一追加"镜头运动"，否则模型常给出几乎静止的画面
const MOTION_HINT = 'cinematic camera push in, subtle natural movement, smooth motion';

function apiBase() {
  return process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1';
}

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'image/png';
}

/** 把本地图片转成接口要求的 data URI */
export function toDataUri(filePath) {
  const buf = fs.readFileSync(filePath);
  return `data:${mimeOf(filePath)};base64,${buf.toString('base64')}`;
}

/** 提交一个图生视频任务，返回 requestId */
export async function submitI2V({ imagePath, prompt, apiKey, seed }) {
  const body = {
    model: I2V_MODEL,
    prompt: `${prompt || ''}, ${MOTION_HINT}`.trim(),
    negative_prompt: 'blurry, distorted, extra limbs, watermark, text artifacts, low quality',
    image_size: I2V_SIZE,
    image: toDataUri(imagePath),
  };
  if (Number.isInteger(seed)) body.seed = seed;

  const resp = await axios.post(`${apiBase()}/video/submit`, body, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 60000,
    maxBodyLength: 64 * 1024 * 1024,
  });
  const requestId = resp.data?.requestId;
  if (!requestId) throw new Error(`提交成功但未返回 requestId: ${JSON.stringify(resp.data).slice(0, 200)}`);
  return requestId;
}

/** 查询一次任务状态 */
export async function queryI2V(requestId, apiKey) {
  const resp = await axios.post(`${apiBase()}/video/status`,
    { requestId },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 });
  return resp.data || {};
}

/**
 * 生成一段开场镜并保存到 outPath。
 * 失败返回 {ok:false, reason}，绝不抛出 —— 上游会静默回退到实拍素材/AI 图，
 * 一镜生成失败不能让整条视频白跑。
 */
export async function generateHeroClip({
  imagePath, prompt, outPath, apiKey,
  timeoutMs = 10 * 60 * 1000, pollMs = 5000,
}) {
  if (!apiKey) return { ok: false, reason: '未配置硅基流动 Key' };
  if (!fs.existsSync(imagePath)) return { ok: false, reason: `首帧图片不存在: ${path.basename(imagePath)}` };

  let requestId;
  try {
    requestId = await submitI2V({ imagePath, prompt, apiKey });
    console.log(`  🎬 图生视频已提交（requestId ${requestId.slice(0, 8)}…），等待生成…`);
  } catch (e) {
    const detail = e.response?.data?.message || e.response?.data?.data || e.message;
    return { ok: false, reason: `提交失败: ${String(detail).slice(0, 200)}` };
  }

  const started = Date.now();
  let lastStatus = '';
  while (Date.now() - started < timeoutMs) {
    await new Promise(r => setTimeout(r, pollMs));
    let s;
    try {
      s = await queryI2V(requestId, apiKey);
    } catch (e) {
      lastStatus = `查询失败: ${e.message}`;
      continue;
    }
    const status = s.status || '';
    if (status !== lastStatus) {
      console.log(`  🎬 图生视频状态: ${status || '未知'}${status === 'InProgress' ? '（生成中）' : ''}`);
      lastStatus = status;
    }
    if (status === 'Succeed') {
      const url = s.results?.videos?.[0]?.url;
      if (!url) return { ok: false, reason: '生成成功但没有返回视频地址' };
      try {
        // 链接 1 小时过期，必须立刻落盘
        const bin = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
        await fs.ensureDir(path.dirname(outPath));
        await fs.writeFile(outPath, Buffer.from(bin.data));
        const secs = s.results?.timings?.inference;
        console.log(`  ✅ 图生视频完成: ${path.basename(outPath)} (${(bin.data.length / 1024).toFixed(0)}KB` +
          `${secs ? `, 推理 ${secs.toFixed(1)}s` : ''})`);
        return { ok: true, path: outPath, inferenceSec: secs, elapsedMs: Date.now() - started };
      } catch (e) {
        return { ok: false, reason: `下载生成结果失败: ${e.message}` };
      }
    }
    if (status === 'Failed') {
      return { ok: false, reason: `生成失败: ${String(s.reason || '未知原因').slice(0, 200)}` };
    }
  }
  return {
    ok: false,
    reason: `等待超时（${Math.round(timeoutMs / 1000)}s），最后状态: ${lastStatus || '未知'}`,
  };
}
