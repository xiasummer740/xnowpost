import 'dotenv/config';
import fs from 'fs-extra';
import { dataPath } from '../paths.js';
import { writeJsonAtomicSync } from '../fs-atomic.js';
import { todayStr } from '../organizer.js';
import { openBitProfile, closeBitProfile, closeAllBitProfiles, connectBrowser, closeBrowser } from './browser.js';
import { openFoxProfile, closeFoxProfile, closeAllFoxProfiles } from './foxprofile.js';
import { normalizeResult, resolveUsername } from './result.js';
import { scrapeTikTok } from './scrapers/tiktok.js';
import { scrapeXiaohongshu } from './scrapers/xiaohongshu.js';
import { scrapeFacebook } from './scrapers/facebook.js';
import { scrapeInstagram } from './scrapers/instagram.js';
import { scrapeYouTube } from './scrapers/youtube.js';
import { scrapeX } from './scrapers/x.js';
import { generateDailyReport } from '../analyzer/daily.js';
import { openDB, ensureDB } from '../db.js';

// 数据目录统一走 paths.js 这个唯一入口（安装版 = %APPDATA%/xnowpost）
const DB_PATH = dataPath('data', 'analytics.db');
const CONFIG_PATH = dataPath('config', 'user.json');
const ACCOUNT_META_PATH = dataPath('data', 'account-meta.json');
const COLLECT_META_PATH = dataPath('data', 'collect-meta.json');

const SCRAPERS = {
  tiktok: scrapeTikTok,
  xiaohongshu: scrapeXiaohongshu,
  facebook: scrapeFacebook,
  instagram: scrapeInstagram,
  youtube: scrapeYouTube,
  x: scrapeX,
};

/** 保存/更新账号元数据（用户名、主页链接等） */
function saveAccountMeta(account, platform, username) {
  try {
    let meta = {};
    if (fs.existsSync(ACCOUNT_META_PATH)) meta = fs.readJsonSync(ACCOUNT_META_PATH);
    const profileUrl = platform === 'tiktok' ? `https://www.tiktok.com/${username}` : '';
    meta[account] = { platform, username, profileUrl, updatedAt: new Date().toISOString() };
    writeJsonAtomicSync(ACCOUNT_META_PATH, meta, 2);   // 原子写，避免半截 JSON
  } catch (e) {
    console.warn(`  ⚠️ 保存账号元数据失败: ${e.message}`);
  }
}

/** 将用户名写回 user.json 配置，日报直接从配置读取无需手动填写 */
function saveUsernameToConfig(account, username) {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const cfg = fs.readJsonSync(CONFIG_PATH);
    const acc = cfg.accounts?.find(a => a.name === account);
    if (acc && acc.username !== username) {
      acc.username = username;
      writeJsonAtomicSync(CONFIG_PATH, cfg, 2);        // 用户配置也必须原子写
      console.log(`  ✅ 已保存用户名 ${username} 到配置`);
    }
  } catch (e) {
    console.warn(`  ⚠️ 保存用户名到配置失败: ${e.message}`);
  }
}

function loadAccounts() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = fs.readJsonSync(CONFIG_PATH);
      return cfg.accounts || [];
    }
  } catch (_) {}
  return [];
}

async function saveStats(db, account, platform, date, stats) {
  const sql = 'INSERT OR REPLACE INTO daily_stats (date, account, platform, metric, value) VALUES (?, ?, ?, ?, ?)';
  db.transaction(() => {
    for (const [metric, value] of Object.entries(stats)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        db.run(sql, [date, account, platform, metric, value]);
      }
    }
  });
}


export async function collectAll(filterAccounts = null) {
  // 本地日期（原来用 toISOString() 是 UTC，北京时间 00:00–08:00 会记成"昨天"，与日报查询错位）
  const date = todayStr();
  await ensureDB(DB_PATH);

  // 读取浏览器引擎配置
  //   browserType = 'foxprofile'（默认，FoxProfile 指纹浏览器）
  //               = 'bitbrowser'（旧的比特浏览器，保留兼容）
  let bitApiKey = '';
  let engine = 'foxprofile';
  let foxApi = '';
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = fs.readJsonSync(CONFIG_PATH);
      bitApiKey = cfg.bitApiKey || '';
      if (cfg.browserType === 'bitbrowser') engine = 'bitbrowser';
      foxApi = cfg.foxApiBase || '';
    }
  } catch (_) {}

  const useFox = engine === 'foxprofile';
  console.log(`🧩 浏览器引擎: ${useFox ? 'FoxProfile 指纹浏览器' : '比特浏览器'}`);

  // 采集前清理所有残留窗口，防止堆积
  console.log('🧹 清理残留浏览器窗口...');
  if (useFox) await closeAllFoxProfiles(foxApi);
  else await closeAllBitProfiles(bitApiKey);

  let accounts = loadAccounts();
  // 过滤指定账号
  if (filterAccounts && filterAccounts.length > 0) {
    accounts = accounts.filter(a => filterAccounts.includes(a.name));
    if (accounts.length === 0) {
      console.log('⚠️ 没有匹配的账号，检查账号名称是否正确');
      return;
    }
    console.log(`📋 将采集 ${accounts.length} 个账号: ${accounts.map(a => a.name).join(', ')}`);
  }

  if (accounts.length === 0) {
    console.log('⚠️ 未配置账号，请在配置页添加账号');
    console.log('   或者使用旧版 CDP 模式...');
    // 旧模式兼容：直接连 CDP
    await collectLegacy(date);
    return;
  }

  const allResults = [];
  const failures = [];
  let insufficientCount = 0;   // 分析页只给「--」且什么都没拿到
  let partialCount = 0;        // 分析页只给「--」，但主页读到了粉丝/关注/获赞
  // 本地已有的用户名（Studio 分析页不给 @handle，靠这个兜底）
  let envAccounts = {};
  try {
    const p = dataPath('data', 'env-accounts.json');
    if (fs.existsSync(p)) envAccounts = fs.readJsonSync(p);
  } catch (_) {}
  // 整个采集过程共用一个连接：每个账号采集完立刻原子落盘（db.persist）
  const db = await openDB(DB_PATH);

  try {
    for (const acc of accounts) {
      console.log(`\n📊 采集账号: ${acc.name} (${acc.platform})`);

      // 环境标识：FoxProfile 用环境名（如 TK01），比特用 32 位环境 ID
      const envId = String(acc.browserEnv || acc.bitEnvId || '').trim();
      if (!envId) {
        console.log(`  ⚠️ 跳过账号 ${acc.name}（未配置浏览器环境）`);
        failures.push({ account: acc.name, reason: '未配置浏览器环境' });
        continue;
      }

      let opened = null;
      try {
        opened = useFox
          ? await openFoxProfile(envId, foxApi)
          : await openBitProfile(envId, bitApiKey);
      } catch (e) {
        console.log(`  ⚠️ 跳过账号 ${acc.name}（${e.message}）`);
        failures.push({ account: acc.name, reason: e.message });
        continue;
      }
      if (!opened) {
        console.log(`  ⚠️ 跳过账号 ${acc.name}（浏览器环境打开失败）`);
        failures.push({ account: acc.name, reason: '浏览器环境打开失败' });
        continue;
      }

      const { context } = opened;
      const fn = SCRAPERS[acc.platform];
      if (!fn) {
        console.log(`  ⚠️ 不支持的平台: ${acc.platform}`);
        if (useFox) await closeFoxProfile(envId, foxApi);
        else await closeBitProfile(envId, bitApiKey);
        continue;
      }

      try {
        const page = await context.newPage();
        console.log(`  📡 ${acc.platform}: 开始采集...`);
        // 把账号信息传下去：Instagram 需要 username 才能定位自己的主页
        const result = await fn(page, { account: acc.name, username: acc.username || '' });
        const { stats, username, insufficient, partial } = normalizeResult(result);
        // 页面抓不到用户名就用本地已有的（env-accounts.json > 配置 accounts[].username）
        const finalUsername = resolveUsername(username, envAccounts, accounts, envId, acc.name);

        // 保存用户名（写两份：元数据文件 + user.json 配置，日报直接从配置读取）
        if (finalUsername) {
          saveAccountMeta(acc.name, acc.platform, finalUsername);
          saveUsernameToConfig(acc.name, finalUsername);
        }

        if (stats) {
          await saveStats(db, acc.name, acc.platform, date, stats);
          db.persist();   // 原子写：进程被杀也不会把整个历史库截断
          allResults.push({ account: acc.name, platform: acc.platform, stats, username: finalUsername });
          console.log(`  ✅ ${acc.name}: ${JSON.stringify(stats)}${finalUsername ? ' (@' + finalUsername + ')' : ''}`);
          if (partial) {
            partialCount++;
            console.log(`  ℹ️ ${acc.name}: 只拿到主页的粉丝/关注/获赞，播放/点赞/评论 TikTok 仍是「--」`);
          }
        } else if (insufficient) {
          insufficientCount++;
          console.log(`  ℹ️ ${acc.name}: 数据不足（TikTok 只给「--」占位，不是页面结构问题）`);
          failures.push({ account: acc.name, reason: '数据不足（页面显示 --）', insufficient: true });
        } else {
          console.log(`  ⚠️ ${acc.name}: 无数据（未登录或页面结构变化，详见上方日志）`);
          failures.push({ account: acc.name, reason: '未解析到指标' });
        }
        await page.close();
      } catch (err) {
        console.error(`  ❌ ${acc.name}: ${err.message}`);
        failures.push({ account: acc.name, reason: err.message });
      } finally {
        // 无论成功失败都要关闭浏览器窗口，防止堆积
        if (useFox) await closeFoxProfile(envId, foxApi);
        else await closeBitProfile(envId, bitApiKey);
      }
    }

    // 采集证据：每轮都留一份（很小的 JSON），失败/数据不足时靠它复盘，界面也读它
    // 为什么要有：以前"什么都没采到"只体现在 stdout 里（调度器用 spawnSync，退出才回放），
    // 用户看到的却是界面上的「今天已采集」+ ✅ 完成。
    try {
      const evidence = {
        date,
        at: new Date().toISOString(),
        atLocal: new Date().toLocaleString('zh-CN', { hour12: false }),
        ok: allResults.length > 0,
        total: accounts.length,
        collected: allResults.length,
        insufficient: insufficientCount + partialCount,
        partial: partialCount,
        accounts: allResults.map((r) => ({ account: r.account, platform: r.platform, metrics: Object.keys(r.stats).length })),
        failures,
      };
      const stamp = new Date().toTimeString().slice(0, 5).replace(':', '');
      writeJsonAtomicSync(dataPath('output', date, `collect-${stamp}.json`), evidence, 2);
    } catch (e) {
      console.warn(`  ⚠️ 保存采集证据失败: ${e.message}`);
    }

    // 保存采集时间戳 —— **只有真的采到数据才写**
    // 否则界面会拿今天的时间戳去配一页空白/旧数据，等于骗人（2026-10-19 事故）
    if (allResults.length > 0) {
      try {
        writeJsonAtomicSync(COLLECT_META_PATH, {
          date,
          collectedAt: new Date().toISOString(),
          collectedAtLocal: new Date().toLocaleString('zh-CN', { hour12: false }),
          accounts: allResults.length,
        }, 2);
      } catch (e) {
        console.warn(`  ⚠️ 保存采集时间戳失败: ${e.message}`);
      }
    } else {
      console.log('  ⚠️ 本轮没有任何数据入库，不更新「已采集」时间戳');
    }

    // 生成日报：必须把 db 传进去，否则"环比 ↑↓"永远是死代码（查询不到昨天的数据）
    if (allResults.length > 0) {
      await generateDailyReport(date, allResults, db);
    }
  } finally {
    db.close();
  }

  if (failures.length > 0) {
    console.log(`\n⚠️ ${failures.length} 个账号采集失败：${failures.map(f => `${f.account}(${f.reason})`).join('; ')}`);
    if (insufficientCount > 0) {
      console.log(`   ℹ️ 其中 ${insufficientCount} 个号是「数据不足」：Studio 分析页指标显示为「--」，`);
      console.log('     意思是这些号还没有可统计的播放/粉丝数据（不是采集器选错地方）。');
    }
  }
  if (partialCount > 0) {
    console.log(`\nℹ️ ${partialCount} 个号只有主页数字（粉丝/关注/获赞）入库：`);
    console.log('   Studio 分析页的播放/点赞/评论仍是「--」，等那些号有播放数据后会自动补上。');
  }
  // 全军覆没时必须非零退出，否则调度器会把"什么都没采到"记成 ✅ 完成
  if (allResults.length === 0 && failures.length > 0) {
    const allInsufficient = insufficientCount === failures.length;
    const why = allInsufficient
      ? `全部 ${failures.length} 个账号数据不足（TikTok 分析页只给「--」占位），未获得任何数据`
      : `全部 ${failures.length} 个账号采集失败，未获得任何数据`;
    const err = new Error(why);
    // 退出码 2 = 纯"数据不足"：重试没有意义（等数据长出来才有用），调度器据此不重试
    err.insufficient = allInsufficient;
    throw err;
  }

  console.log(`\n✅ 数据采集完成（${allResults.length}/${accounts.length} 个账号有数据）`);
}

/**
 * 旧版 CDP 直连（兼容无账号配置）
 */
async function collectLegacy(date) {
  const db = await openDB(DB_PATH);
  const result = await connectBrowser();
  if (!result) {
    console.log('❌ 无法连接浏览器，跳过');
    db.close();
    return;
  }

  const { context } = result;
  const results = [];
  const failed = [];

  try {
    for (const [name, fn] of Object.entries(SCRAPERS)) {
      try {
        const page = await context.newPage();
        console.log(`  📡 ${name}: 开始采集...`);
        const { stats } = normalizeResult(await fn(page, { account: 'default', username: '' }));
        if (stats) {
          await saveStats(db, 'default', name, date, stats);
          results.push({ account: 'default', platform: name, stats });
          console.log(`  ✅ ${name}: ${JSON.stringify(stats)}`);
        } else {
          console.log(`  ⚠️ ${name}: 无数据`);
          failed.push(name);
        }
        await page.close();
      } catch (err) {
        console.error(`  ❌ ${name}: ${err.message}`);
        failed.push(name);
      }
    }

    if (results.length > 0) {
      db.persist();
      await generateDailyReport(date, results, db);
    }
  } finally {
    await closeBrowser();
    db.close();
  }

  if (failed.length) console.log(`  ⚠️ 失败/无数据的平台: ${failed.join(', ')}`);
}

// 直接运行时
const isMain = process.argv[1] && (
  process.argv[1].includes('collector') ||
  process.argv[1].includes('index.js')
);

if (isMain && !process.argv[1].includes('src/index.js')) {
  // 解析 --accounts 参数：只采集指定的账号
  const accIdx = process.argv.indexOf('--accounts');
  const filterAccounts = accIdx > -1 && accIdx + 1 < process.argv.length
    ? process.argv[accIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
    : null;

  if (filterAccounts) console.log(`📋 过滤账号: ${filterAccounts.join(', ')}`);

  collectAll(filterAccounts).then(() => process.exit(0)).catch(err => {
    console.error('\n❌ 采集失败:', err.message || err);
    // 退出码 2 = 只是"数据不足"（页面全是 -- 占位）：调度器据此不重试、不当成偶发故障
    process.exit(err && err.insufficient ? 2 : 1);
  });
}
