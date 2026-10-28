/**
 * 素材库挑片 + 字幕关键词染色（v1.6.46）的单测。
 *
 * 守的是这一轮用户两次反馈的核心问题：
 * 「素材对不上关键词或者语句」「字幕英文被缩成小注解」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { pickFromLibrary } from '../../src/engine/material.js';
import { highlightKeyword, deriveKeyword, wrapCjkTagged } from '../../src/engine/video.js';
import { buildQualityReport, inspectAss, QUALITY_TARGETS } from '../../src/quality.js';

const CLIPS = [
  { file: 'editing__1.mp4', tags: ['editing', 'laptop', 'timeline'] },
  { file: 'network__1.mp4', tags: ['network', 'device', 'cable'] },
  { file: 'phone__1.mp4', tags: ['phone', 'chat', 'comment'] },
];

test('pickFromLibrary：按标签命中，不是按原句', () => {
  const hit = pickFromLibrary(CLIPS, 'network switch blue light');
  assert.ok(hit, '应当命中 network 段');
  assert.equal(hit.file, 'network__1.mp4');
});

test('pickFromLibrary：命中多个标签的优先', () => {
  const clips = [
    { file: 'a.mp4', tags: ['editing'] },
    { file: 'b.mp4', tags: ['editing', 'laptop', 'timeline'] },
  ];
  const hit = pickFromLibrary(clips, 'editing laptop timeline close up');
  assert.equal(hit.file, 'b.mp4');
});

test('pickFromLibrary：已用过的降权，但没别的可选时仍然给', () => {
  const clips = [{ file: 'only.mp4', tags: ['clock', 'time'] }];
  const used = new Set(['only.mp4']);
  const hit = pickFromLibrary(clips, 'clock desk', used);
  assert.ok(hit, '只有一条时不能返回 null（宁可重复也不黑屏）');
  assert.equal(hit.reused, true, '用了已用过的素材要标记出来');
});

test('pickFromLibrary：同义词能命中（smartphone → phone）', () => {
  const clips = [{ file: 'phone__1.mp4', tags: ['phone', 'hand'] }];
  const hit = pickFromLibrary(clips, 'smartphone close up');
  assert.equal(hit.file, 'phone__1.mp4');
});

test('pickFromLibrary：优先没用过的 —— 7 镜不许 4 镜用同一段', () => {
  const clips = [
    { file: 'phone__a.mp4', tags: ['phone', 'smartphone'] },
    { file: 'phone__b.mp4', tags: ['phone'] },
    { file: 'phone__c.mp4', tags: ['phone'] },
  ];
  const used = new Set();
  const picks = [];
  for (let i = 0; i < 3; i++) {
    const hit = pickFromLibrary(clips, 'smartphone', used);
    picks.push(hit.file);
    used.add(hit.file);
  }
  assert.equal(new Set(picks).size, 3, '三段应当各不相同，实际 ' + picks.join(','));
});

test('pickFromLibrary：完全不相关就返回 null（交给 Pexels 兜底）', () => {
  const hit = pickFromLibrary(CLIPS, 'airplane runway sunset');
  assert.equal(hit, null);
});

test('pickFromLibrary：空关键词/空库不报错', () => {
  assert.equal(pickFromLibrary(CLIPS, ''), null);
  assert.equal(pickFromLibrary([], 'editing'), null);
});

test('highlightKeyword：只染第一处，且包上白色还原', () => {
  const out = highlightKeyword('上传卡了 3 次，真的 3 次', '3 次');
  const red = '{\\1c&H5B2EFF&}';
  assert.equal(out.indexOf(red), out.lastIndexOf(red), '只应出现一次红色');
  assert.ok(out.includes('{\\1c&HFFFFFF&}'), '后面要还原成白色');
  assert.equal(out.replace(/\{[^}]*\}/g, ''), '上传卡了 3 次，真的 3 次', '去掉标记后文本必须一字不差');
});

test('highlightKeyword：关键词没配 / 没命中时原样返回', () => {
  assert.equal(highlightKeyword('随便一句', ''), '随便一句');
  assert.equal(highlightKeyword('随便一句', '不存在的词'), '随便一句');
});

test('deriveKeyword：模型漏字段时从文案里挑重点（数字优先）', () => {
  assert.equal(deriveKeyword('上传卡了 3 次'), '3 次');
  assert.equal(deriveKeyword('10 条专线，哪条都不掉'), '10 条专线');
  assert.equal(deriveKeyword('掉了自动补，不用盯着'), '自动补');
  assert.equal(deriveKeyword('随便一句没有重点'), '');
  assert.equal(deriveKeyword(''), '');
});

test('deriveKeyword 的产物必须能在原句里找到（否则会染一个不存在的词）', () => {
  for (const t of ['上传卡了 3 次', '10 条专线，哪条都不掉', '一条片子，省回 2 小时']) {
    const k = deriveKeyword(t);
    assert.ok(k && t.includes(k), `「${t}」推出「${k}」但原句里找不到`);
  }
});
test('wrapCjkTagged：先染色再折行，标记绝不被劈开', () => {
  // 造一个"关键词一定跨行"的句子：一行 6 字，关键词正好压在断行处
  const zh = '前面五个字然后10 条专线不掉';
  const kw = deriveKeyword(zh);
  const colored = highlightKeyword(zh, kw);
  const out = wrapCjkTagged(colored, 6);
  assert.ok(out.includes('{\\1c&H5B2EFF&}'), '染色标记必须还在');
  assert.ok(out.includes('\\N'), '必须真的折了行');
  for (const m of out.match(/\{[^}]*\}/g) || []) {
    assert.ok(!m.includes('\\N'), `标记里被塞进了换行: ${m}`);
  }
  // 去掉标记和换行后，文字必须与原句一致
  assert.equal(out.replace(/\{[^}]*\}/g, '').replace(/\\N/g, ''), zh);
});

test('wrapCjkTagged：折行按可见字数算，标记不占字数', () => {
  const out = wrapCjkTagged('{\\1c&H5B2EFF&}一二三四五六七八九十{\\1c&HFFFFFF&}', 5);
  const visibleLines = out.split('\\N').map((l) => l.replace(/\{[^}]*\}/g, ''));
  assert.deepEqual(visibleLines.map((l) => l.length), [5, 5]);
});

test('inspectAss：读得出中英行数、字号、染色行数', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ass-'));
  const f = path.join(dir, 'x.ass');
  await fs.writeFile(f, [
    '[V4+ Styles]',
    'Style: ZH,Microsoft YaHei,60,&H00FFFFFF,&H000000FF,&H00000000,&H90000000,1,0,0,0,100,100,1,0,1,4,3,2,70,70,660,1',
    'Style: EN,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H90000000,0,0,0,0,100,100,0,0,1,4,3,2,70,70,520,1',
    '[Events]',
    'Dialogue: 0,0:00:00.00,0:00:03.00,ZH,,0,0,0,,上传卡了 {\\1c&H5B2EFF&}3 次{\\1c&HFFFFFF&}',
    'Dialogue: 0,0:00:00.00,0:00:03.00,EN,,0,0,0,,Upload failed three times.',
  ].join('\n'), 'utf-8');
  const r = inspectAss(f);
  assert.equal(r.zhLines, 1);
  assert.equal(r.enLines, 1);
  assert.equal(r.zhSize, 60);
  assert.equal(r.enSize, 60, '中英必须同字号');
  assert.equal(r.highlightedLines, 1);
  await fs.remove(dir);
});

test('buildQualityReport：文件不存在也不抛异常，只报"未测出"', () => {
  const rep = buildQualityReport({
    videoFile: path.join(os.tmpdir(), 'definitely-missing-xyz.mp4'),
    scenes: [{ scene_text_zh: '上传卡了 3 次', scene_text_en: 'Upload failed' }],
    assFile: null,
  });
  assert.equal(rep.ok, false);
  const joined = rep.problems.join('｜');
  assert.match(joined, /未测出/);
  assert.doesNotMatch(joined, /响度 -?\d/, '测不出来时绝不能编个数字出来');
  assert.ok(Array.isArray(rep.lines));
});

test('buildQualityReport：达标区间是"社交标准"而不是随便定的', () => {
  assert.deepEqual(
    { min: QUALITY_TARGETS.loudness.min, max: QUALITY_TARGETS.loudness.max },
    { min: -16, max: -12 },
  );
  assert.ok(QUALITY_TARGETS.subtitleZhSizeMin >= 44, '字幕字号下限不能低于 44px（手机可读）');
  assert.ok(QUALITY_TARGETS.sceneSec.max <= 4.2 && QUALITY_TARGETS.sceneSec.min >= 2.2);
});

test('内容校验的时长区间必须跟 config 一致（改配置不能让校验器写死）', async () => {
  const { validateVideoContentForTest } = await import('../../src/engine/text.js');
  const cfg = (await import('../../src/engine/config.js')).getEngineConfig();
  const scenes = Array.from({ length: 7 }, (_, i) => ({
    scene_text_zh: `第${i + 1}句有数字 3 次`,
    scene_text_en: 'line',
    image_desc: 'desc',
    duration: cfg.video.minDuration, // 贴着下限，旧写死的 3 秒会把它判死
  }));
  const r = validateVideoContentForTest({ title_zh: 't', title_en: 't', scenes });
  assert.equal(r.valid, true, `贴着下限量程（${cfg.video.minDuration}）不该被判非法: ${r.errors.join(';')}`);
});

test('wrapCjkTagged：孤字不能单独占一行', () => {
  // 17 个可见字符、每行 17 → 必须一行；16 字 + 每行 15 → 15/1 要被并成一行
  const one = wrapCjkTagged('试试 XNOW，30秒注册不用密码！', 15);
  const segs = one.split('\\N');
  assert.equal(segs.length, 1, '总长只多 1~2 个字时应并成一行，实际: ' + segs.join('|'));
});

test('createAss：英文折成两行时不许盖住中文（靠 \\pos 定位而不是固定边距）', async () => {
  const fs2 = (await import('fs-extra')).default;
  const os2 = (await import('os')).default;
  const path2 = (await import('path')).default;
  const { createAssForTest } = await import('../../src/engine/video.js');
  const dir = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'ass2-'));
  const out = path2.join(dir, 'x.ass');
  createAssForTest(
    [
      { scene_text_zh: '中文一句话', scene_text_en: 'This English line is deliberately long enough to wrap onto two lines', keyword_zh: '一句话' },
    ],
    out, 1080, 1920, 'cn+en', [3],
  );
  const txt = await fs2.readFile(out, 'utf-8');
  const zh = txt.split('\n').find((l) => l.includes(',ZH,'));
  const en = txt.split('\n').find((l) => l.includes(',EN,'));
  assert.ok(zh && en, '中英两条都要出');
  const yOf = (line) => Number(line.match(/\\pos\(\d+,(\d+)\)/)[1]);
  assert.ok(yOf(en) > yOf(zh), `英文底边(${yOf(en)})必须在中文底边(${yOf(zh)})下方`);
  await fs2.remove(dir);
});

test('同分时人挑的优先于自动补进来的（自动素材相关性没人看过）', () => {
  const clips = [
    { file: 'auto.mp4', tags: ['phone'], source: 'auto', used: 0 },
    { file: 'curated.mp4', tags: ['phone'], source: 'curated', used: 5 },
  ];
  const hit = pickFromLibrary(clips, 'smartphone', new Set());
  assert.equal(hit.file, 'curated.mp4', '自动素材不能因为"用得少"就挤掉人挑的');
});

test('都没人挑过时，优先用得少的（轮换，避免同一条反复出现）', () => {
  const clips = [
    { file: 'a.mp4', tags: ['desk'], source: 'auto', used: 7 },
    { file: 'b.mp4', tags: ['desk'], source: 'auto', used: 0 },
  ];
  const hit = pickFromLibrary(clips, 'desk', new Set());
  assert.equal(hit.file, 'b.mp4');
});
test('首句没数字会重问（提示词管不住模型时的兜底，规则不许被删）', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../../src/engine/text.js', import.meta.url), 'utf-8');
  assert.match(src, /第 1 镜没有数字/, '重问日志不见了 → 兜底逻辑被删');
  assert.match(src, /type === 'video' && attempt < 2/, '只对视频模式生效，且最多重问两次');
  assert.match(src, /超过 16 字/, '超长镜头也要重问（18 字会折两行，观感变差）');
});