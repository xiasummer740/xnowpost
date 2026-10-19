/**
 * 引擎配置加载 —— config/default.json 的**唯一读取入口**
 *
 * 背景（P2-11）：此前全项目没有任何地方读 config/default.json，它是"死配置"：
 * 模型名/温度/max_tokens 硬编码在 text.js，分镜数量写死 5，
 * default.json 里写着 "scenes": 9 却永远不生效 —— 改配置毫无作用，还会误导人。
 * 现在把它真正接上；字段缺失或非法时回退到内置默认值并给出一次性警告，
 * 保证"配置坏了也不会把引擎带崩"。
 */
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { dataPath } from '../paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', '..', 'config', 'default.json');

// 内置默认值 = 过去硬编码的实际行为，配置读不到时行为不变
const FALLBACK = {
  deepseek: { model: 'deepseek-chat', temperature: 0.8, retryTemperature: 0.3, max_tokens: 4096 },
  image: { width: 1080, height: 1920, model: 'Kwai-Kolors/Kolors', retries: 2, retryDelay: 2000 },
  video: {
    scenes: 5, minDuration: 5, maxDuration: 7,
    // 成片观感相关（此前 default.json 里配了却无人读取，等于死配置）
    bgmVolume: 0.15, fadeIn: 0.5, fadeOut: 1.0,
    motion: true, transitionSec: 0.5,
    // 开场镜用 AI 图生视频（SiliconFlow Wan2.2 I2V）。默认关闭：它是唯一付费的画面增强
    heroI2V: false, heroScenes: 1,
  },
  voice: {
    zh: { voice: 'zh-CN-XiaoxiaoNeural', rate: '+10%' },
    en: { voice: 'en-US-JennyNeural', rate: '+10%' },
  },
  telegram: { parseMode: 'HTML', disableNotification: false },
};

// 引擎实际计费的生图模型（cost.js 的价格表只覆盖它）
export const BILLED_IMAGE_MODEL = 'Kwai-Kolors/Kolors';

let cached = null;
const warned = new Set();

function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`  ⚠️ [config] ${msg}`);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!isPlainObject(override)) return out;
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** 读取并缓存引擎配置（进程内只读一次，改配置需重启引擎） */
export function getEngineConfig() {
  if (cached) return cached;
  let raw = {};
  try {
    raw = fs.readJsonSync(CONFIG_FILE);
  } catch (e) {
    warnOnce('read', `读取 ${CONFIG_FILE} 失败，使用内置默认值: ${e.message}`);
  }
  cached = deepMerge(FALLBACK, raw);
  return cached;
}

function num(value, fallback, { min, max, key, name }) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    warnOnce(key, `${name} 配置值非法 (${JSON.stringify(value)})，回退为 ${fallback}`);
    return fallback;
  }
  return n;
}

/** 分镜数量（提示词里的 {SCENE_COUNT} 与生图数量都由它决定） */
export function getSceneCount() {
  const cfg = getEngineConfig();
  return Math.round(num(cfg.video?.scenes, FALLBACK.video.scenes, {
    min: 1, max: 12, key: 'scenes', name: 'video.scenes',
  }));
}

/**
 * 内容合规策略。
 *
 * 起因：截图里带着"千粉¥13""用28925"这类信息，视觉模型读出来后模型就照着写进了
 * 旁白和标题——价格、优惠码、联系方式、涨粉承诺这类东西不适合公开投放。
 * 默认全部关闭（不写），需要时可在 config/default.json 的 content 段打开。
 */
export function getContentPolicy() {
  const c = getEngineConfig().content || {};
  let user = {};
  try {
    const f = dataPath('config', 'user.json');
    if (fs.existsSync(f)) user = fs.readJsonSync(f) || {};
  } catch (_) { /* 读不到就用默认 */ }
  const pick = (k, dflt) => (typeof user[k] === 'boolean' ? user[k] : (typeof c[k] === 'boolean' ? c[k] : dflt));
  return {
    noPrice: pick('noPrice', true),        // 不出现价格 / 金额 / 优惠 / 折扣
    noContact: pick('noContact', true),    // 不出现微信 / QQ / TG / 网址 / 邮箱
    noPromise: pick('noPromise', true),    // 不做涨粉数量 + 时间的硬承诺
    // 自动把截图里的优惠码 / 邀请码遮掉
    maskPromoCode: pick('maskPromoCode', true),
    // 品牌官网：以前是代码里硬拼 "xnow.taikon.top" 加到文案末尾，
    // 一边说"不出现网址"一边自己加，自相矛盾。现在默认不加，要引流就填这里。
    brandUrl: typeof c.brandUrl === 'string' ? c.brandUrl : '',
  };
}

/**
 * 成片观感参数（运镜 / 转场 / 配乐 / 淡入淡出 / 开场镜图生视频）。
 *
 * 这些字段一直写在 config/default.json 里，但从来没有人读过 ——
 * 所以成片一直是"静态图硬切拼接"。这里统一暴露出来。
 * 「设置」里能改的项（heroI2V / heroScenes）优先读 user.json。
 */
export function getVideoStyleConfig() {
  const v = getEngineConfig().video || {};
  let user = {};
  try {
    const f = dataPath('config', 'user.json');
    if (fs.existsSync(f)) user = fs.readJsonSync(f) || {};
  } catch (_) { /* 用户配置读不到就用默认值，不影响出片 */ }

  const heroI2V = user.heroI2V !== undefined ? user.heroI2V === true : v.heroI2V === true;
  const heroScenesRaw = user.heroScenes !== undefined ? user.heroScenes : v.heroScenes;

  // 配音语言：auto = 跟字幕走（旧行为）；zh / en = 强制中文或英文配音。
  // 引擎层的 generateVoice() 本来就支持双语（en 时读 scene_text_en），
  // 之前只是被 subtitleLang 硬绑成中文，没法选。
  // ⚠️ 本次生成时在控制台选的优先级最高（环境变量），其次才是持久设置。
  const vlRaw = String(user.voiceLang || 'auto').toLowerCase();
  let voiceLang = (vlRaw === 'zh' || vlRaw === 'en') ? vlRaw : 'auto';
  const envVoice = String(process.env.XNOWPOST_VOICE_LANG || '').toLowerCase();
  if (envVoice === 'zh' || envVoice === 'en') voiceLang = envVoice;

  // 用户自带截图目录：有图就用图（比图库素材更贴合自己的产品）
  const materialsDir = typeof user.materialsDir === 'string' ? user.materialsDir.trim() : '';

  return {
    // 运镜开关：关掉就退回旧的静态图拼接（出问题时可一键回退）
    motion: v.motion !== false,
    // 转场时长（秒）。0 = 硬切。不得超过任何单镜时长的一半，否则时间轴会崩
    transitionSec: num(v.transitionSec, FALLBACK.video.transitionSec, {
      min: 0, max: 2, key: 'transition', name: 'video.transitionSec',
    }),
    bgmVolume: num(v.bgmVolume, FALLBACK.video.bgmVolume, {
      min: 0, max: 1, key: 'bgm', name: 'video.bgmVolume',
    }),
    fadeIn: num(v.fadeIn, FALLBACK.video.fadeIn, { min: 0, max: 5, key: 'fadein', name: 'video.fadeIn' }),
    fadeOut: num(v.fadeOut, FALLBACK.video.fadeOut, { min: 0, max: 5, key: 'fadeout', name: 'video.fadeOut' }),
    // 开场镜图生视频：默认关闭（这是唯一会额外花钱的画面增强）
    heroI2V,
    heroScenes: Math.round(num(heroScenesRaw, FALLBACK.video.heroScenes, {
      min: 1, max: 3, key: 'hero', name: 'video.heroScenes',
    })),
    /** 'auto' = 跟字幕语言；'zh' / 'en' = 强制中文 / 英文配音 */
    voiceLang,
    /** 用户自带截图目录（为空 = 不用） */
    materialsDir,
    /** 截图最多占用几个分镜（其余分镜用实拍/AI 画面，避免全片都是截图） */
    materialsMaxScenes: Number.isFinite(Number(v.materialsMaxScenes))
      ? Math.max(1, Math.min(9, Number(v.materialsMaxScenes))) : 2,
  };
}

/** DeepSeek 调用参数 */
export function getDeepSeekConfig() {
  const cfg = getEngineConfig().deepseek || {};
  const model = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : FALLBACK.deepseek.model;
  if (model !== FALLBACK.deepseek.model) {
    warnOnce('ds-model', `deepseek.model=${model} 与 cost.js 的价格表 (${FALLBACK.deepseek.model}) 不一致，费用会按旧单价估算`);
  }
  return {
    model,
    temperature: num(cfg.temperature, FALLBACK.deepseek.temperature, {
      min: 0, max: 2, key: 'ds-temp', name: 'deepseek.temperature',
    }),
    retryTemperature: num(cfg.retryTemperature, FALLBACK.deepseek.retryTemperature, {
      min: 0, max: 2, key: 'ds-temp-retry', name: 'deepseek.retryTemperature',
    }),
    maxTokens: Math.round(num(cfg.max_tokens, FALLBACK.deepseek.max_tokens, {
      min: 256, max: 32768, key: 'ds-max-tokens', name: 'deepseek.max_tokens',
    })),
  };
}

/** 生图参数（model 仅用于一致性校验，实际调用与计价固定在 Kolors） */
export function getImageConfig() {
  const cfg = getEngineConfig().image || {};
  if (cfg.model && cfg.model !== BILLED_IMAGE_MODEL) {
    warnOnce('img-model', `image.model=${cfg.model} 被忽略：生图与计价固定为 ${BILLED_IMAGE_MODEL}（cost.js 只有它的单价）`);
  }
  return {
    retries: Math.round(num(cfg.retries, FALLBACK.image.retries, {
      min: 0, max: 5, key: 'img-retries', name: 'image.retries',
    })),
    retryDelay: Math.round(num(cfg.retryDelay, FALLBACK.image.retryDelay, {
      min: 0, max: 30000, key: 'img-retry-delay', name: 'image.retryDelay',
    })),
  };
}

/** 配音参数 */
export function getVoiceConfig(lang = 'zh') {
  const cfg = getEngineConfig().voice || {};
  const pick = cfg[lang];
  const fb = FALLBACK.voice[lang] || FALLBACK.voice.zh;
  return {
    voice: typeof pick?.voice === 'string' && pick.voice.trim() ? pick.voice.trim() : fb.voice,
    rate: typeof pick?.rate === 'string' && pick.rate.trim() ? pick.rate.trim() : fb.rate,
  };
}

/** Telegram 推送参数 */
export function getTelegramConfig() {
  const cfg = getEngineConfig().telegram || {};
  return {
    parseMode: typeof cfg.parseMode === 'string' && cfg.parseMode ? cfg.parseMode : FALLBACK.telegram.parseMode,
    disableNotification: cfg.disableNotification === true,
  };
}
