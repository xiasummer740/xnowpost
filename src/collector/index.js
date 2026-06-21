import 'dotenv/config';
import path from 'path';
import fs from 'fs-extra';
import { openBitProfile, closeBitProfile, connectBrowser, closeBrowser } from './browser.js';
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

export async function collectAll() {
  const date = new Date().toISOString().split('T')[0];
  await ensureDB(DB_PATH);

  const accounts = loadAccounts();
  if (accounts.length === 0) {
    console.log('⚠️ 未配置账号，请在配置页添加账号');
    console.log('   或者使用旧版 CDP 模式...');
    // 旧模式兼容：直接连 CDP
    await collectLegacy(date);
    return;
  }

  const allResults = [];

  for (const acc of accounts) {
    console.log(`\n📊 采集账号: ${acc.name} (${acc.platform})`);

    const result = await openBitProfile(acc.bitEnvId);
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
      await closeBitProfile();
      continue;
    }

    try {
      const page = await context.newPage();
      console.log(`  📡 ${acc.platform}: 开始采集...`);
      const stats = await fn(page);
      if (stats) {
        const db = await openDB(DB_PATH);
        saveStats(db, acc.name, acc.platform, date, stats);
        fs.writeFileSync(DB_PATH, db.export());
        db.close();
        allResults.push({ account: acc.name, platform: acc.platform, stats });
        console.log(`  ✅ ${acc.name}: ${JSON.stringify(stats)}`);
      } else {
        console.log(`  ⚠️ ${acc.name}: 无数据`);
      }
      await page.close();
    } catch (err) {
      console.error(`  ❌ ${acc.name}: ${err.message}`);
    }

    await closeBitProfile();
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
      const stats = await fn(page);
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
  collectAll().then(() => process.exit(0)).catch(err => {
    console.error('\n❌ 采集失败:', err);
    process.exit(1);
  });
}
