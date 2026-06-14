import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'path';
import { connectBrowser, closeBrowser } from './browser.js';
import { scrapeTikTok } from './scrapers/tiktok.js';
import { scrapeXiaohongshu } from './scrapers/xiaohongshu.js';
import { scrapeFacebook } from './scrapers/facebook.js';
import { scrapeInstagram } from './scrapers/instagram.js';
import { scrapeYouTube } from './scrapers/youtube.js';
import { scrapeX } from './scrapers/x.js';
import { generateDailyReport } from '../analyzer/daily.js';

const DB_PATH = path.resolve('data/analytics.db');

function initDB() {
  const db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      platform TEXT NOT NULL,
      metric TEXT NOT NULL,
      value INTEGER NOT NULL,
      UNIQUE(date, platform, metric)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
    CREATE INDEX IF NOT EXISTS idx_daily_stats_platform ON daily_stats(platform);

    CREATE TABLE IF NOT EXISTS content_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      publish_date TEXT,
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      shares INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_content_performance_date ON content_performance(publish_date);
    CREATE INDEX IF NOT EXISTS idx_content_performance_platform ON content_performance(platform);
  `);

  return db;
}

function saveStats(db, platform, date, stats) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO daily_stats (date, platform, metric, value)
    VALUES (?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const [metric, value] of Object.entries(stats)) {
      if (typeof value === 'number' && !isNaN(value)) {
        insert.run(date, platform, metric, value);
      }
    }
  });

  tx();
}

export async function collectAll() {
  const date = new Date().toISOString().split('T')[0];
  const db = initDB();

  console.log(`\n📊 数据采集 — ${date}\n`);

  const result = await connectBrowser();
  if (!result) {
    console.error('❌ 无法连接浏览器，数据采集跳过');
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
        saveStats(db, name, date, stats);
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

  // 生成日报
  if (results.length > 0) {
    await generateDailyReport(date, results);
  }

  db.close();
  return results;
}

// 直接运行时执行采集
const isMain = process.argv[1] && (
  process.argv[1].includes('collector') ||
  process.argv[1].includes('index.js')
);

if (isMain && !process.argv[1].includes('src/index.js')) {
  collectAll().then(() => {
    console.log('\n✅ 数据采集完成');
    process.exit(0);
  }).catch(err => {
    console.error('\n❌ 采集失败:', err);
    process.exit(1);
  });
}
