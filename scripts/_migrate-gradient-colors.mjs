/**
 * 一次性配色迁移：把写死的 TikTok 粉（#ff2e5b / rgba(255,46,91,…) / 相关暖色）
 * 换成 theme.css 里的品牌渐变变量（XX-UI 那套 紫 → 蓝 → 青）。
 *
 * 为什么用脚本：这些色值散在 8 个 .vue 的样式块里，一共几十处，
 * 手改容易漏一两处（漏掉的就是"新旧界面观感割裂"的来源）。
 *
 * 用法：node scripts/_migrate-gradient-colors.mjs [--dry-run]
 */
import fs from 'fs-extra';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DRY = process.argv.includes('--dry-run');

const FILES = [
  'src/renderer/App.vue',
  'src/renderer/views/Dashboard.vue',
  'src/renderer/views/Accounts.vue',
  'src/renderer/views/Schedule.vue',
  'src/renderer/views/Assistant.vue',
  'src/renderer/views/DailyReport.vue',
  'src/renderer/views/History.vue',
  'src/renderer/views/Logs.vue',
];

// alpha → color-mix 百分比（保持原来的浓淡关系，只换色相）
const ALPHAS = [0.05, 0.08, 0.1, 0.11, 0.12, 0.14, 0.16, 0.18, 0.2, 0.22, 0.25, 0.26, 0.28, 0.3, 0.32, 0.35, 0.38, 0.4, 0.42, 0.45, 0.48, 0.5, 0.55, 0.6, 0.65, 0.7];

const REPLACERS = [
  // rgba(255, 46, 91, A) / rgba(255,46,91,A) → color-mix(in srgb, var(--brand) P%, transparent)
  [
    /rgba\(\s*255\s*,\s*46\s*,\s*91\s*,\s*(0?\.\d+|1|0)\s*\)/g,
    (m, a) => {
      const p = Math.round(Number(a) * 100);
      // 就近吸附到表里的百分比，避免出现 11.99999% 这种
      const near = ALPHAS.map((x) => Math.round(x * 100)).reduce((best, x) => (Math.abs(x - p) < Math.abs(best - p) ? x : best), p);
      return `color-mix(in srgb, var(--brand) ${near}%, transparent)`;
    },
  ],
  // 品牌实色
  [/#ff2e5b/gi, 'var(--brand)'],
  [/#ff4d73/gi, 'var(--brand-hover)'],
  // 浅粉文字（用在品牌软底上的小字）
  [/#ff8aa0/gi, '#c9b6ff'],
  [/#ffb3c2/gi, '#ded1ff'],
  [/#ffb3c1/gi, '#ded1ff'],
  // 品牌渐变的老搭档（粉→橙）
  [/linear-gradient\(\s*135deg\s*,\s*var\(--brand\)\s*,\s*#ff7a45\s*\)/gi, 'var(--brand-grad)'],
  [/linear-gradient\(\s*90deg\s*,\s*var\(--brand\)\s*,\s*#ff7a45\s*\)/gi, 'linear-gradient(90deg, var(--brand-1), var(--brand-2), var(--brand-3))'],
  // 单独一根进度条/分隔线：粉 → 紫蓝
  [/linear-gradient\(\s*90deg\s*,\s*transparent\s*,\s*var\(--brand\)\s*,\s*transparent\s*\)/gi, 'linear-gradient(90deg, transparent, var(--brand-2), transparent)'],
  // 转圈 loader：上边框用纯粉 → 用渐变起点色
  [/border-top-color:\s*var\(--brand\);/g, 'border-top-color: var(--brand-2);'],
];

let total = 0;
for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.log(`跳过（不存在）：${rel}`);
    continue;
  }
  const before = fs.readFileSync(abs, 'utf8');
  let after = before;
  const hits = [];
  for (const [re, rep] of REPLACERS) {
    after = after.replace(re, (...args) => {
      const m = args[0];
      const out = typeof rep === 'function' ? rep(...args) : rep;
      if (out !== m) hits.push(`${m} → ${out}`);
      return out;
    });
  }
  if (after === before) {
    console.log(`  无变化：${rel}`);
    continue;
  }
  const n = hits.length;
  total += n;
  console.log(`  ${rel}：${n} 处`);
  if (!DRY) fs.writeFileSync(abs, after, 'utf8');
}
console.log(`${DRY ? '（--dry-run，没有写盘）' : '✅ 已写入'}  共 ${total} 处`);
