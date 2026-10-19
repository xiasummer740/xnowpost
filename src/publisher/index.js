/**
 * 发布器入口
 * 遍历产出目录，把未发布的视频发布到各平台
 *
 * ⚠️ 2026-10-19 全盘审查 P0-1/P0-6：扫描逻辑原来在这里自己写了一份，
 *    与 electron/main.js 的三份实现规则各不相同 —— 这里**没有 FAILED 拦截、`--all` 全发、
 *    不认 confirmed、所有条目都发到 accounts[0]**，而无人值守走的正是这一份。
 *    现在统一走 `src/output-scan.js`（纯函数 + 12 条单测），默认只发当天、
 *    跳过 FAILED、默认最多 3 条。老会话必须显式 `--any-date`。
 */
import path from 'path';
import fs from 'fs-extra';
import { publishToTikTok } from './tiktok.js';
import { envBudgetMs } from './waits.js';
import { resolveDataDir } from '../paths.js';
import { writeJsonAtomicSync } from '../fs-atomic.js';
import { closeFoxProfile } from '../collector/foxprofile.js';
import { scanUnpublished, summarizeSkips, DEFAULT_MAX_PER_RUN } from '../output-scan.js';

// 数据目录统一走 paths.js（打包版 = %APPDATA%/xnowpost）
// —— 不要再自己拼 path.resolve('.')，否则安装版会读写安装目录
function outputDir() {
  return path.join(resolveDataDir(), 'output');
}

/** 本地日期 YYYY-MM-DD（本地时区，别用 toISOString —— 凌晨会把日志/目录算到前一天） */
function localToday() {
  return new Date().toLocaleDateString('sv-SE');
}

/**
 * 查找未发布的产出（= 可发布候选）。
 * @param {object} [options]
 * @param {boolean} [options.onlyToday=true] 只认当天（安全默认）
 * @param {number} [options.maxCount=0] 0 = 不限
 */
export function findUnpublished(options = {}) {
  const { onlyToday = true, maxCount = 0 } = options;
  const OUTPUT_DIR = outputDir();
  console.log(`  [PUB] DATA_DIR=${resolveDataDir()} OUTPUT_DIR=${OUTPUT_DIR}`);

  if (!fs.existsSync(OUTPUT_DIR)) {
    console.log(`  ⚠️ 目录不存在: ${OUTPUT_DIR}`);
    return [];
  }
  const today = localToday();
  const { items, skipped, pending } = scanUnpublished({ outputDir: OUTPUT_DIR, today, onlyToday, maxCount });
  const scope = onlyToday ? `当天 ${today}` : '全部日期（--any-date）';
  console.log(`  📋 扫描范围：${scope}；未发布 ${pending.length} 个，本轮候选 ${items.length} 个`);
  const summary = summarizeSkips(skipped);
  if (summary) console.log(`  ⏭️ 跳过：${summary}`);
  for (const it of items) {
    console.log(`  ✅ 候选 ${it.date}/${it.session}${it.retry ? '（上次卡在发布阶段，重试）' : ''} — ${String(it.title || '').slice(0, 40)}`);
  }
  return items;
}

/**
 * 写 .published 标记（原子写，避免半截 JSON 让下一轮误判为未发布 → 重复上传）。
 * ⚠️ 兜底写入一律带 `confirmed: false` —— 没有"确认点到过 Post"的证据就不许写成成功。
 */
function markUnconfirmedMarker(sessionPath, url = '', reason = '发布器未写入标记，兜底写为未确认') {
  writeJsonAtomicSync(path.join(sessionPath, '.published'), {
    publishedAt: new Date().toISOString(),
    platform: 'tiktok',
    url,
    confirmed: false,
    note: 'post-clicked-unconfirmed',
    unconfirmedReason: reason,
  }, 2);
}

/**
 * 发布所有未发布的内容
 * @param {object} options
 * @param {string} [options.envId] - 指纹浏览器环境名，如 TK01（不传则跳过浏览器操作）
 * @param {string} [options.apiKey] - 已废弃：FoxProfile 不需要 API 密钥
 * @param {string} [options.platform] - 指定平台（默认全部）
 * @param {number} [options.maxCount] - 最多发布几个（默认 3 条，0 = 不限）
 * @param {boolean} [options.onlyToday] - 只发当天（默认 true）
 * @param {number} [options.budgetMs] - 单条内容的发布耗时预算（P2-5，默认取环境变量/30 分钟）
 */
export async function publishAll(options = {}) {
  const {
    envId,
    apiKey,
    platform = 'tiktok',
    maxCount = DEFAULT_MAX_PER_RUN,
    onlyToday = true,
    budgetMs,
  } = options;
  const items = findUnpublished({ onlyToday, maxCount: 0 });

  if (items.length === 0) {
    console.log('📭 没有未发布的内容');
    return { published: 0, total: 0, failed: 0, skipped: 0, unconfirmed: 0 };
  }

  // 上限在扫描之后截断（扫描已经把"为什么没发"写进日志了）
  const limit = Number(maxCount) > 0 ? Number(maxCount) : 0;
  const toPublish = limit ? items.slice(0, limit) : items;
  if (limit && items.length > limit) {
    console.log(`📦 待发布 ${items.length} 个，本轮只处理 ${limit} 个（多余的下轮继续）`);
  } else {
    console.log(`📦 待发布 ${items.length} 个，本轮全部处理`);
  }
  let published = 0;
  let failed = 0;
  let skipped = 0;
  let unconfirmed = 0;

  try {
  for (const item of toPublish) {
    console.log(`\n📤 发布: ${item.date}/${item.session}`);
    console.log(`   ${item.title}`);

    try {
      if (platform === 'tiktok') {
        if (!envId) {
          console.log('  ⚠️ 未配置指纹浏览器环境名，跳过浏览器发布');
          skipped++;
          continue;
        }
        const url = await publishToTikTok({
          sessionPath: item.path,
          videoFile: item.videoFile ? path.join(item.path, item.videoFile) : null,
          imageFiles: item.imageFiles.map(f => path.join(item.path, f)),
          titleFile: item.txtFile,
          envId,
          apiKey,
          budgetMs,
        });
        // ⚠️ .published 是 tiktok.js 在「确认点到发布按钮」时写的。
        //    这里只在标记缺失时兜底写入（且写成"未确认"，绝不假装成功）——
        //    覆盖已有标记会把 "post-clicked-unconfirmed" 这类证据抹掉。
        const markerPath = path.join(item.path, '.published');
        if (!fs.existsSync(markerPath)) {
          markUnconfirmedMarker(item.path, typeof url === 'string' ? url : '');
        }
        let marker = {};
        try { marker = fs.readJsonSync(markerPath); } catch (_) { /* ignore */ }
        // 🔴 2026-10-19 P0-2：未确认**不算成功**（原来这里只打一行 warning 然后 published++，
        //    调度器就记「✅ 完成任务」，真实结果无人知晓）。
        if (marker && (marker.confirmed === false || marker.note === 'post-clicked-unconfirmed')) {
          unconfirmed++;
          console.log(`  ⚠️ 已点击发布按钮，但结果未确认（${marker.unconfirmedReason || '未知原因'}）—— 不重试、不重发，请人工核对`);
          continue;
        }
        console.log(`  ✅ 发布成功并已确认: ${url || '(链接未知)'}`);
      } else {
        console.log(`  ⚠️ 不支持的平台: ${platform}`);
        skipped++;
        continue;
      }

      published++;
    } catch (err) {
      // 图文 session 没有 mp4 → 发布器只支持视频，这是"已知不支持"而非故障，
      // 计入 skipped，避免调度器每轮都因为图文目录告警
      if (/没有视频可发布/.test(err.message || '')) {
        console.log(`  ⏭️ 跳过（发布器目前只支持视频）: ${err.message}`);
        skipped++;
      } else if (/演练模式/.test(err.message || '')) {
        // 演练模式在点发布前主动停止：既没发布也不算失败，更不能写 .published
        console.log(`  🧪 演练完成（未发布）: ${err.message}`);
        skipped++;
      } else {
        console.error(`  ❌ 发布失败: ${err.message}`);
        failed++;
      }
      // 继续发布下一个，不中断
    }
  }

  console.log(
    `\n📊 发布完成: ${published}/${toPublish.length}`
    + `${skipped ? `（跳过 ${skipped}）` : ''}`
    + `${failed ? `（失败 ${failed}）` : ''}`
    + `${unconfirmed ? `（未确认 ${unconfirmed}）` : ''}`,
  );
  if (unconfirmed) {
    console.log('   ℹ️ 未确认 = 点过 Post 但没能证明已公开：不算成功、也不重发（重发会产生重复作品），请人工核对');
  }
  return { published, total: items.length, failed, skipped, unconfirmed };
  } finally {
    // 发完把指纹浏览器窗口关掉（发布器原来从头到尾**没有**关环境的地方，
    // 每跑一轮就留一个 camoufox 窗口，越跑越多、还占着 cookie 库）。
    // 调试想留窗口看现场：设 XNOWPOST_KEEP_BROWSER=1。
    if (envId && platform === 'tiktok' && process.env.XNOWPOST_KEEP_BROWSER !== '1') {
      console.log('  🧹 关闭指纹浏览器窗口...');
      await closeFoxProfile(envId).catch((e) => console.warn(`  ⚠️ 关闭环境失败: ${e.message}`));
      const left = await import('../collector/foxprofile.js')
        .then((m) => m.foxRunning())
        .catch(() => []);
      if (Array.isArray(left) && left.length) {
        console.log(`  ⚠️ 仍有环境在运行: ${left.join(', ')}`);
      } else {
        console.log('  ✅ 已确认没有残留环境');
      }
    }
  }
}

// 直接运行时
const isMain = process.argv[1] && (
  process.argv[1].includes('publisher') ||
  process.argv[1].includes('publish')
);

if (isMain) {
  const args = process.argv.slice(2);
  // 安全默认：只发当天、最多 3 条。老会话必须显式 --any-date（P0-1 护栏）
  const options = { budgetMs: envBudgetMs(), onlyToday: true, maxCount: DEFAULT_MAX_PER_RUN };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env') options.envId = args[++i];
    else if (args[i] === '--account') options.account = String(args[++i] || '').trim();
    else if (args[i] === '--platform') options.platform = args[++i];
    else if (args[i] === '--max') {
      const n = parseInt(args[++i], 10);
      if (Number.isFinite(n) && n >= 0) options.maxCount = n;
    } else if (args[i] === '--all') {
      // 语义收紧：--all = 「当天全部」（不限条数），**不再**意味着把两个月的积压全推出去
      options.maxCount = 0;
    } else if (args[i] === '--any-date') {
      options.onlyToday = false;
      console.log('  ⚠️ --any-date：允许发布非当天的旧会话（慎用，会发出老内容）');
    } else if (args[i] === '--include-old') {
      options.onlyToday = false;
      console.log('  ⚠️ --include-old：同 --any-date（兼容旧写法）');
    }
  }

  // 从 config 读取指纹浏览器环境名（走数据目录，打包后才不会读到安装目录里的模板配置）
  const configPath = path.join(resolveDataDir(), 'config', 'user.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = fs.readJsonSync(configPath);
      // --account 01 → TK01（定时页里 account 存的是 name，不是环境名）
      if (!options.envId && options.account) {
        const env = `TK${String(options.account).replace(/^TK/i, '').padStart(2, '0')}`;
        const hit = (cfg.accounts || []).find((a) => String(a.name) === String(options.account));
        options.envId = (hit && (hit.browserEnv || hit.bitEnvId)) || env;
        console.log(`  🎯 --account ${options.account} → 环境 ${options.envId}`);
      }
      if (!options.envId) {
        options.envId = cfg.accounts?.[0]?.browserEnv || cfg.accounts?.[0]?.bitEnvId;
        if (options.envId) {
          console.log(`  ⚠️ 没指定 --env/--account，退回 accounts[0] = ${options.envId}（所有条目都发到这个环境）`);
        }
      }
      options.apiKey = cfg.bitApiKey || '';
    } catch (_) {}
  }

  publishAll(options).then(r => {
    console.log(`\n✅ 发布器完成 (${r.published}/${r.total})${r.unconfirmed ? ` 未确认 ${r.unconfirmed}` : ''}`);
    // 退出码：0 = 全部确认成功；1 = 有失败；3 = 只有"点了发布但未确认"
    // （调度器见到 3 不重试、也不记成功 —— 与采集器的"数据不足=2"同一套约定）
    let code = 0;
    if (r.failed > 0) code = 1;
    else if (r.unconfirmed > 0) code = 3;
    process.exit(code);
  }).catch(err => {
    console.error('\n❌ 发布器失败:', err);
    process.exit(1);
  });
}
