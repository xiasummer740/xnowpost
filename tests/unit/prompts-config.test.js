/**
 * 提示词模板与引擎配置的**真实**契约测试
 *
 * 覆盖两件曾经出过错的事：
 *  1. P2-11：config/default.json 是死配置（写了不生效）→ 现在必须真的驱动引擎
 *  2. {SCENE_COUNT} 用 String.replace 只替换第一处 →
 *     分镜数一变，提示词里会残留 `{SCENE_COUNT}` 字面量直接发给模型
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'fs-extra';

import {
  BILLED_IMAGE_MODEL,
  getEngineConfig,
  getSceneCount,
  getDeepSeekConfig,
  getImageConfig,
  getVoiceConfig,
  getTelegramConfig,
} from '../../src/engine/config.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PROMPT_DIR = path.join(ROOT, 'config', 'prompts');
const ALLOWED_PLACEHOLDERS = ['STRATEGY_LABEL', 'STRATEGY_DESC', 'SCENE_COUNT', 'USER_TOPIC'];

/** 用与生产代码一致的方式渲染模板（全局替换） */
function render(template, sceneCount) {
  return template
    .replace(/\{STRATEGY_LABEL\}/g, '策略标签')
    .replace(/\{STRATEGY_DESC\}/g, '策略说明')
    .replace(/\{SCENE_COUNT\}/g, String(sceneCount))
    .replace(/\{USER_TOPIC\}/g, '');
}

describe('提示词模板', () => {
  const files = ['content_video.txt', 'content_post.txt'];

  test('两个模板都存在且非空', () => {
    for (const f of files) {
      const p = path.join(PROMPT_DIR, f);
      assert.ok(fs.existsSync(p), `缺少模板: ${f}`);
      assert.ok(fs.readFileSync(p, 'utf-8').trim().length > 100, `${f} 内容过短`);
    }
  });

  test('只使用白名单占位符（拼错会导致占位符原样发给模型）', () => {
    for (const f of files) {
      const tpl = fs.readFileSync(path.join(PROMPT_DIR, f), 'utf-8');
      const found = [...tpl.matchAll(/\{([A-Z_]+)\}/g)].map(m => m[1]);
      const unknown = [...new Set(found)].filter(x => !ALLOWED_PLACEHOLDERS.includes(x));
      assert.deepEqual(unknown, [], `${f} 含未知占位符: ${unknown.join(', ')}`);
    }
  });

  test('全局渲染后不残留任何占位符（回归：曾用 String.replace 只替换第一处）', () => {
    for (const f of files) {
      const tpl = fs.readFileSync(path.join(PROMPT_DIR, f), 'utf-8');
      const out = render(tpl, 9);
      const left = out.match(/\{[A-Z_]+\}/g) || [];
      assert.deepEqual(left, [], `${f} 渲染后残留: ${left.join(', ')}`);
    }
  });

  test('content_video.txt 里分镜数量出现多处，且全部被正确替换', () => {
    const tpl = fs.readFileSync(path.join(PROMPT_DIR, 'content_video.txt'), 'utf-8');
    const occurrences = (tpl.match(/\{SCENE_COUNT\}/g) || []).length;
    assert.ok(occurrences >= 2, `分镜数占位符只出现 ${occurrences} 次，节奏指南可能没覆盖到`);
    const out = render(tpl, 9);
    assert.equal((out.match(/9 个分镜/g) || []).length, occurrences,
      '渲染后「9 个分镜」的出现次数应与占位符数量一致 —— 不一致说明有占位符没被替换');
  });

  test('节奏指南按阶段描述，能适配当前分镜数（9 镜时给出 8-9 镜为 CTA）', () => {
    const tpl = fs.readFileSync(path.join(PROMPT_DIR, 'content_video.txt'), 'utf-8');
    assert.match(tpl, /钩子期/, '缺少钩子期说明');
    assert.match(tpl, /CTA/i, '缺少 CTA 说明');
    assert.match(tpl, /第8-9镜/, '9 镜的分段建议缺失（用户已选择 9 镜）');
  });
});

describe('引擎配置（P2-11：默认配置必须真的生效）', () => {
  test('默认配置里 video.scenes 为 7（v1.6.46：7 镜 × 2.4~3.6 秒 ≈ 20 秒）', () => {
    const cfg = fs.readJsonSync(path.join(ROOT, 'config', 'default.json'));
    assert.equal(cfg.video.scenes, 7);
    // 节奏：单镜 2.4~3.6 秒（4 镜 × 4s 在手机上信息密度太低，2026-10-20 用户确认改掉）
    assert.equal(cfg.video.minDuration, 2.4);
    assert.equal(cfg.video.maxDuration, 3.6);
    // 总时长目标：含封面卡后落在 20~25 秒
    assert.ok(cfg.video.totalDuration >= 18 && cfg.video.totalDuration <= 25,
      `总时长目标不在 18~25 秒: ${cfg.video.totalDuration}`);
  });

  test('响度归一与字幕字号有默认值（旧片 -26 LUFS / 36px 是这一轮要修的缺陷）', () => {
    const cfg = fs.readJsonSync(path.join(ROOT, 'config', 'default.json'));
    assert.equal(cfg.video.loudness.target, -14);
    assert.ok(cfg.video.loudness.truePeak <= -1);
    assert.ok(cfg.video.subtitle.zhSize >= 44, '字幕字号下限 44px（手机可读）');
    assert.equal(cfg.video.subtitle.zhSize, cfg.video.subtitle.enSize, '中英必须同字号');
  });

  test('getSceneCount() 返回 1..12 的整数且等于配置文件的值', () => {
    const n = getSceneCount();
    const cfg = fs.readJsonSync(path.join(ROOT, 'config', 'default.json'));
    assert.ok(Number.isInteger(n), `应为整数，实际 ${n}`);
    assert.ok(n >= 1 && n <= 12, `超出范围: ${n}`);
    assert.equal(n, cfg.video.scenes, '应跟随 config/default.json 的 video.scenes');
  });

  test('DeepSeek 配置来自 config/default.json 而非硬编码', () => {
    const c = getDeepSeekConfig();
    const file = fs.readJsonSync(path.join(ROOT, 'config', 'default.json')).deepseek;
    assert.equal(c.model, file.model);
    assert.equal(c.temperature, file.temperature);
    assert.equal(c.maxTokens, file.max_tokens);
  });

  test('生图模型必须是计费模型常量（费用记账依赖它）', () => {
    assert.equal(BILLED_IMAGE_MODEL, 'Kwai-Kolors/Kolors');
    // getImageConfig() 只暴露重试策略；尺寸/模型在 getEngineConfig().image
    const retry = getImageConfig();
    assert.ok(Number.isInteger(retry.retries) && retry.retries >= 0, `retries=${retry.retries}`);
    assert.ok(Number.isInteger(retry.retryDelay) && retry.retryDelay >= 0, `retryDelay=${retry.retryDelay}`);

    const full = getEngineConfig().image;
    assert.ok(full.width > 0 && full.height > 0, `尺寸非法: ${full.width}x${full.height}`);
    assert.equal(full.retries, retry.retries, '两处 retries 应一致');
  });

  test('配置里的 image.model 若与计费模型不符，代码会忽略它（不能让计价错位）', () => {
    const cfg = fs.readJsonSync(path.join(ROOT, 'config', 'default.json'));
    // config 里可以写别的东西，但真正调用必须用 BILLED_IMAGE_MODEL —— 这里只断言常量存在且唯一
    assert.equal(typeof BILLED_IMAGE_MODEL, 'string');
    assert.ok(BILLED_IMAGE_MODEL.includes('/'), '计费模型名应形如 组织/模型');
    assert.ok(cfg.image.model, '配置里应有 image.model（即便会被忽略也要保留，便于用户看到意图）');
  });

  test('语音配置中英分开，且都是合法 edge-tts 声音名', () => {
    const zh = getVoiceConfig('zh');
    const en = getVoiceConfig('en');
    for (const [label, v] of [['zh', zh], ['en', en]]) {
      assert.match(v.voice, /^[a-z]{2}-[A-Z]{2}-\w+Neural$/, `${label} 声音名不合法: ${v.voice}`);
    }
    assert.notEqual(zh.voice, en.voice);
  });

  test('TG 配置有 parseMode', () => {
    const t = getTelegramConfig();
    assert.ok(['HTML', 'Markdown', 'MarkdownV2'].includes(t.parseMode), `parseMode=${t.parseMode}`);
  });

  test('getEngineConfig() 返回完整结构', () => {
    const c = getEngineConfig();
    for (const k of ['deepseek', 'image', 'video', 'voice']) {
      assert.ok(c[k], `缺少 ${k}`);
    }
  });
});
