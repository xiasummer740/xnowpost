/**
 * 建/更新本地实拍素材库（assets/broll-library/）。
 *
 * 为什么需要：Pexels 的排序是"关键词相关度"，不是"画面像不像那句话"。
 * 实测「network switch」→ 货车司机/摄像机/保洁，「data center」→ 接线员办公室。
 * 用户 2026-10-20 两次反馈「素材对不上关键词或者语句」——
 * 解决方案是把**人看过的片段**固化进库，按标签命中，库外才退回搜索。
 *
 * 用法：node scripts/build-broll-library.mjs
 *   源文件默认取 output/exp-2026-10-20/candidates/（那批已经逐张看过的候选）；
 *   加 --from <目录> 可以换来源。
 */
import fs from 'fs-extra';
import path from 'path';

const ROOT = process.cwd();
const LIB = path.join(ROOT, 'assets', 'broll-library');
const fromArg = process.argv.indexOf('--from');
const SRC = fromArg > -1 ? path.resolve(process.argv[fromArg + 1]) : path.join(ROOT, 'output', 'exp-2026-10-20', 'candidates');

/**
 * 人挑清单：编号来自对照图（sheets/*.png），标签是"这段画面是什么"，
 * 不是"搜它时用的词"——命中靠标签，所以要写画面上真有的东西。
 */
const PICKS = [
  { src: 's1-3.mp4', tags: ['editing', 'laptop', 'timeline', 'video'], note: '笔记本上跑剪辑软件，时间线清晰' },
  { src: 's1-2.mp4', tags: ['editing', 'timeline', 'screen'], note: '倾斜视角的剪辑时间线' },
  { src: 's1-4.mp4', tags: ['editing', 'audio', 'waveform'], note: '音频波形（配音/声音相关）' },
  { src: 's1-6.mp4', tags: ['editing', 'workstation', 'monitor', 'desktop'], note: '双屏工作站 + 剪辑轨道' },
  { src: 's3-3.mp4', tags: ['network', 'device', 'cable', 'server', 'blue'], note: '蓝光网络设备 + 手（科技感）' },
  { src: 's3-4.mp4', tags: ['data', 'numbers', 'screen', 'dashboard'], note: '数字滚动的数据屏' },
  { src: 's3-6.mp4', tags: ['server', 'room', 'monitor', 'control', 'office'], note: '机房/控制室大屏' },
  { src: 's4-1.mp4', tags: ['clock', 'time', 'desk'], note: '桌面大数字时钟 05:31' },
  { src: 's4-2.mp4', tags: ['clock', 'time'], note: '复古闹钟组' },
  { src: 's4-4.mp4', tags: ['desk', 'phone', 'notes', 'planning'], note: '桌面待办 + 手机（不用盯着）' },
  { src: 's4-5.mp4', tags: ['desk', 'writing', 'notes', 'planning'], note: '手写笔记' },
  { src: 's5-1.mp4', tags: ['phone', 'chat', 'comment', 'typing'], note: '手机聊天/评论输入框 + 键盘' },
  { src: 's5-5.mp4', tags: ['phone', 'tablet', 'hands'], note: '双手操作平板/手机' },
  { src: 's5-6.mp4', tags: ['phone', 'hand', 'smartphone'], note: '手持手机' },
];

async function main() {
  await fs.ensureDir(LIB);
  const indexFile = path.join(LIB, 'library.json');
  const old = (await fs.pathExists(indexFile)) ? await fs.readJson(indexFile) : { version: 1, clips: [] };
  const byFile = new Map((old.clips || []).map((c) => [c.file, c]));
  const added = [];
  const missing = [];

  for (const p of PICKS) {
    const src = path.join(SRC, p.src);
    if (!(await fs.pathExists(src))) {
      missing.push(p.src);
      continue;
    }
    const safe = p.tags[0];
    const file = `${safe}__${p.src.replace(/\.mp4$/, '')}.mp4`;
    const dest = path.join(LIB, file);
    if (!(await fs.pathExists(dest))) await fs.copy(src, dest);
    byFile.set(file, {
      file,
      tags: p.tags,
      note: p.note,
      bytes: (await fs.stat(dest)).size,
      addedAt: byFile.get(file)?.addedAt || new Date().toISOString(),
    });
    if (!added.includes(file)) added.push(file);
  }

  const clips = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
  await fs.writeJson(indexFile, { version: 1, updatedAt: new Date().toISOString(), clips }, { spaces: 2 });
  const totalMB = clips.reduce((s, c) => s + (c.bytes || 0), 0) / 1024 / 1024;
  console.log(`✅ 素材库：${clips.length} 段 / ${totalMB.toFixed(1)} MB → ${LIB}`);
  console.log(`   本次新增 ${added.length} 段${missing.length ? `，缺 ${missing.length} 个源文件（${missing.join(', ')}）` : ''}`);
  const tagCount = new Map();
  for (const c of clips) for (const t of c.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  console.log(`   标签：${[...tagCount.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}(${n})`).join(' ')}`);
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
