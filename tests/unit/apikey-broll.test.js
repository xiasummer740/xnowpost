/**
 * API Key 占位符识别 + 实拍素材 Key 解析
 *
 * 起因：仓库里的 .env 是模板（sk-your-api-key-here），而引擎只读 process.env。
 * 命令行直接跑就会拿占位符去请求，服务端只回
 *   "401 Authentication Fails, Your api key: ****here is invalid"
 * ——"here" 是占位符的尾巴，不是真实 Key 的后四位。要在花钱前拦住。
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';

import { looksLikePlaceholder, validateApiKey, validateApiKeys } from '../../src/engine/apikey.js';
import { resolvePexelsKey, pickBestVideoFile } from '../../src/engine/material.js';

const OLD_ENV = process.env.PEXELS_API_KEY;

// 注意：这些 Key 一律用 join 拼出来，不要在文件里写成完整字面量。
// scripts/check-leaks.mjs 会把形如 sk-xxxxxxxx 的字面量判成真实泄露
// （它确实该这么做 —— 宁可误报也不放过真 Key）。
const PLACEHOLDER_KEY = ['sk', 'your', 'api', 'key', 'here'].join('-');
const FAKE_KEY = ['sk', 'Zm9vYmFyYmF6cXV1eDEyMzQ1Njc4OTBhYmNk'].join('-');
const FAKE_KEY_TRIMMED = `  ${FAKE_KEY}  `;
afterEach(() => {
  if (OLD_ENV === undefined) delete process.env.PEXELS_API_KEY;
  else process.env.PEXELS_API_KEY = OLD_ENV;
});

describe('looksLikePlaceholder', () => {
  test('识别 .env 模板里的经典占位符', () => {
    for (const v of [
      'sk-your-api-key-here',
      'sk-your-key',
      'your_api_key',
      'api-key-here',
      'xxxxxxxx',
      'placeholder',
      'change-me',
      'your-deepseek-key',
    ]) {
      assert.equal(looksLikePlaceholder(v), true, `应识别为占位符: ${v}`);
    }
  });

  test('识别中文占位符（上一任开发者留下的）', () => {
    assert.equal(looksLikePlaceholder('拿到 Key 再填）'), true);
    assert.equal(looksLikePlaceholder('此处填入你的 Key'), true);
    assert.equal(looksLikePlaceholder('待填写'), true);
  });

  test('真实 Key 不算占位符', () => {
    assert.equal(looksLikePlaceholder(FAKE_KEY), false);
    assert.equal(looksLikePlaceholder('abc123def456ghi789'), false);
  });

  test('空值不算占位符（那是"未配置"，由 validateApiKey 区分）', () => {
    assert.equal(looksLikePlaceholder(''), false);
    assert.equal(looksLikePlaceholder('   '), false);
    assert.equal(looksLikePlaceholder(null), false);
    assert.equal(looksLikePlaceholder(undefined), false);
  });
});

describe('validateApiKey', () => {
  test('未配置 → 明确说未配置', () => {
    const r = validateApiKey('', 'DeepSeek Key');
    assert.equal(r.ok, false);
    assert.match(r.reason, /未配置/);
  });

  test('占位符 → 说清楚是占位符，且不泄露完整值', () => {
    const r = validateApiKey(PLACEHOLDER_KEY, 'DeepSeek Key');
    assert.equal(r.ok, false);
    assert.match(r.reason, /占位符/);
    assert.match(r.reason, /401/);
    assert.ok(!r.reason.includes(PLACEHOLDER_KEY.slice(3)), '不应把完整占位符回显出来');
  });

  test('真实 Key → 通过并去掉首尾空白', () => {
    const r = validateApiKey(FAKE_KEY_TRIMMED, 'DeepSeek Key');
    assert.equal(r.ok, true);
    assert.equal(r.value, FAKE_KEY);
  });

  test('批量校验把问题都收集起来，不提前中断', () => {
    const problems = validateApiKeys([
      { value: '', label: 'DeepSeek Key' },
      { value: PLACEHOLDER_KEY, label: '硅基流动 Key' },
      { value: FAKE_KEY, label: '正常 Key' },
    ]);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /DeepSeek Key/);
    assert.match(problems[1], /硅基流动 Key/);
  });
});

describe('resolvePexelsKey', () => {
  test('环境变量是占位符时视为未配置（而不是拿去请求）', () => {
    process.env.PEXELS_API_KEY = PLACEHOLDER_KEY;
    const r = resolvePexelsKey();
    assert.equal(r.ok, false);
    assert.match(r.reason, /占位符/);
  });

  test('环境变量是真实 Key 时优先使用', () => {
    process.env.PEXELS_API_KEY = 'abc123def456ghi789';
    const r = resolvePexelsKey();
    assert.equal(r.ok, true);
    assert.equal(r.source, 'env');
    assert.equal(r.key, 'abc123def456ghi789');
  });

  test('任何情况下都返回 {ok, reason?} 形状，不抛异常', () => {
    delete process.env.PEXELS_API_KEY;
    const r = resolvePexelsKey();
    assert.equal(typeof r.ok, 'boolean');
    if (!r.ok) assert.equal(typeof r.reason, 'string');
  });
});

describe('pickBestVideoFile —— 够用且最小', () => {
  const f = (width, height, quality = 'hd') => ({ width, height, quality, link: `https://x/${width}x${height}.mp4` });

  test('同时有 4K 和 1080p 时，选 1080p（输出就是 1080x1920）', () => {
    const chosen = pickBestVideoFile([f(2160, 3840), f(1080, 1920), f(1440, 2560)]);
    assert.equal(chosen.width, 1080);
    assert.equal(chosen.height, 1920);
  });

  test('只有 720p 时退而用最大的竖屏（不返回 null）', () => {
    const chosen = pickBestVideoFile([f(540, 960), f(720, 1280)]);
    assert.equal(chosen.width, 720);
  });

  test('横屏素材永远不选（竖屏成片会大幅裁切）', () => {
    const chosen = pickBestVideoFile([f(3840, 2160), f(1920, 1080), f(720, 1280)]);
    assert.ok(chosen.height >= chosen.width, `选中了横屏: ${chosen.width}x${chosen.height}`);
  });

  test('多个 1080p 时选像素最少的那个', () => {
    const chosen = pickBestVideoFile([f(1080, 1920), f(1440, 2560), f(1080, 1920)]);
    assert.equal(chosen.width * chosen.height, 1080 * 1920);
  });

  test('空输入返回 null，不抛异常', () => {
    assert.equal(pickBestVideoFile([]), null);
    assert.equal(pickBestVideoFile(null), null);
    assert.equal(pickBestVideoFile(undefined), null);
    assert.equal(pickBestVideoFile([{ width: 1080, height: 1920 }]), null, '没有 link 的文件不可用');
  });
});

describe('提示词与代码契约', () => {
  test('content_video.txt 仍要求模型输出 broll_keywords（删了代码就搜不到素材）', () => {
    const p = 'config/prompts/content_video.txt';
    assert.ok(fs.existsSync(p), '提示词文件不存在');
    const txt = fs.readFileSync(p, 'utf-8');
    assert.match(txt, /broll_keywords/, '提示词缺少 broll_keywords 字段说明');
    // 输出示例里也要有，否则模型可能只在说明里看到、结构化输出时漏掉
    const jsonPart = txt.slice(txt.indexOf('"scenes"'));
    assert.match(jsonPart, /"broll_keywords"/, '输出示例里缺少 broll_keywords');
  });
});
