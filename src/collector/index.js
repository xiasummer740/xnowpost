import 'dotenv/config';
import path from 'path';
import fs from 'fs-extra';
import { openBitProfile, closeBitProfile, closeAllBitProfiles, connectBrowser, closeBrowser } from './browser.js';
import { scrapeTikTok } from './scrapers/tiktok.js';
import { scrapeXiaohongshu } from './scrapers/xiaohongshu.js';
import { scrapeFacebook } from './scrapers/facebook.js';
import { scrapeInstagram } from './scrapers/instagram.js';
import { scrapeYouTube } from './scrapers/youtube.js';
import { scrapeX } from './scrapers/x.js';
import { generateDailyReport } from '../analyzer/daily.js';
import { openDB, ensureDB } from '../db.js';

const DB_PATH = path.resolve('data/analytics.db');
const CONFIG_PATH = path.resolve('config/user.json');
const ACCOUNT_META_PATH = path.resolve('data/account-meta.json');

// 保存/更新账号元数据（用户名、主页链接等）
function saveAccountMeta(account, platform, username) {
  try {
    fs.ensureDirSync(path.dirname(ACCOUNT_META_PATH));
    let meta = {};
    if (fs.existsSync(ACCOUNT_META_PATH)) meta = fs.readJsonSync(ACCOUNT_META_PATH);
    const profileUrl = platform === 'tiktok' ? `https://www.tiktok.com/${username}` : '';
    meta[account] = { platform, username, profileUrl, updatedAt: new Date().toISOString() };
    fs.writeJsonSync(ACCOUNT_META_PATH, meta, { spaces: 2 });
  } catch (e) {
    console.warn(`  ⚠️ 保存账号元数据失败: ${e.message}`);
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
      if (typeof value === 'number' && !isNaN(value)) {
        db.run(sql, [date, account, platform, metric, value]);
      }
    }
  });
}

export async function collectAll(filterAccounts = null) {
  const date = new Date().toISOString().split('T')[0];
  await ensureDB(DB_PATH);

  // 采集前清理所有残留比特窗口，防止堆积
  console.log('🧹 清理残留比特窗口...');
  await closeAllBitProfiles();

  let accounts = loadAccounts();
  // 过滤指定账号
  if (filterAccounts && filterAccounts.length > 0) {
    accounts = accounts.filter(a => filterAccounts.includes(a.name));
    if (accounts.length === 0) {
      console.log('⚠️ 没有匹配的账号，检查账号名称是否正确');
      return;
    }
    console.log(`📋 将采集 ${accounts.length} 个账号: ${accounts.map(a=>a.name).join(', ')}`);
  }

  if (accounts.length === 0) {
    console.log('⚠️ 未配置账号，请在配置页添加账号');
    console.log('   或者使用旧版 CDP 模式...');
    // 旧模式兼容：直接连 CDP
    await collectLegacy(date);
    return;
  }

  const allResults = [];

  // 读取比特 API 密钥
  let bitApiKey = '';
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = fs.readJsonSync(CONFIG_PATH);
      bitApiKey = cfg.bitApiKey || '';
    }
  } catch (_) {}

  for (const acc of accounts) {
    console.log(`\n📊 采集账号: ${acc.name} (${acc.platform})`);

    const result = await openBitProfile(acc.bitEnvId, bitApiKey);
    if (!result) {
      console.log(`  ⚠️ 跳过账号 ${acc.name}`);
      continue;
    }

    const { context } = result;

    const scrapers = {
      tiktok: scrapeTikTok,
      xiaohongshu: scrapeXiaohongshu,
      facebook: scrapeFacebook,
      instagram: scrapeInstagram,
      youtube: scrapeYouTube,
      x: scrapeX,
    };

    const fn = scrapers[acc.platform];
    if (!fn) {
      console.log(`  ⚠️ 不支持的平台: ${acc.platform}`);
      await closeBitProfile(acc.bitEnvId);
      continue;
    }

    try {
      const page = await context.newPage();
      console.log(`  📡 ${acc.platform}: 开始采集...`);
      const result = await fn(page);
      const stats = result && result.stats ? result.stats : result;
      const username = result?.username || '';
      // 保存用户名到账号元数据
      if (username) saveAccountMeta(acc.name, acc.platform, username);
      if (stats) {
        const db = await openDB(DB_PATH);
        saveStats(db, acc.name, acc.platform, date, stats);
        fs.writeFileSync(DB_PATH, db.export());
        db.close();
        allResults.push({ account: acc.name, platform: acc.platform, stats });
        console.log(`  ✅ ${acc.name}: ${JSON.stringify(stats)}${username ? ' (@' + username + ')' : ''}`);
      } else {
        console.log(`  ⚠️ ${acc.name}: 无数据`);
      }
      await page.close();
    } catch (err) {
      console.error(`  ❌ ${acc.name}: ${err.message}`);
    } finally {
      // 无论成功失败都要关闭浏览器窗口，防止堆积
      await closeBitProfile(acc.bitEnvId);
    }
  }

  // 生成日报
  if (allResults.length > 0) {
    await generateDailyReport(date, allResults);
  }

  console.log('\n✅ 数据采集完成');
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
  const scrapers = [
    { name: 'tiktok', fn: scrapeTikTok },
    { name: 'xiaohongshu', fn: scrapeXiaohongshu },
    { name: 'facebook', fn: scrapeFacebook },
    { name: 'instagram', fn: scrapeInstagram },
    { name: 'youtube', fn: scrapeYouTube },
    { name: 'x', fn: scrapeX },
  ];

  const results = [];
  for (const { name, fn } of scrapers) {
    try {
      const page = await context.newPage();
      console.log(`  📡 ${name}: 开始采集...`);
      const result = await fn(page);
      const stats = result && result.stats ? result.stats : result;
      if (stats) {
        saveStats(db, 'default', name, date, stats);
        results.push({ platform: name, stats });
        console.log(`  ✅ ${name}: ${JSON.stringify(stats)}`);
      } else {
        console.log(`  ⚠️ ${name}: 无数据`);
      }
      await page.close();
    } catch (err) {
      console.error(`  ❌ ${name}: ${err.message}`);
    }
  }

  await closeBrowser();
  fs.writeFileSync(DB_PATH, db.export());
  db.close();

  if (results.length > 0) {
    await generateDailyReport(date, results);
  }
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
    console.error('\n❌ 采集失败:', err);
    process.exit(1);
  });
}
