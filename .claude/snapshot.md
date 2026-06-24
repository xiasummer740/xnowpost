## 🏷️ 架构快照
- **时间**: 2026-06-23 00:33
- **提交**: docs: update PROGRESS.md for v1.1.1-dev
- **文件**: .claude/PROGRESS.md, .claude/snapshot.md, src/publisher/tiktok.js

## 📋 未完成项
- [时间选择器 bug 修复+体验优化] 三个问题一起修
- [better-sqlite3 → sql.js 迁移] 原生模块版本不匹配无法编译
- [TikTok 采集适配] 新版 TikTok Studio 页面
- [日报页面 📊] 全新页面展示采集数据
- [多账号支持] 采集器 + 日报页面
- [v1.0.15发布] 时间选择器升级 + CMD 窗口消除
- [v1.0.8发布] 安装版打包 + GitHub Release + 自动更新机制
- [自动更新] electron-updater + 侧边栏红点角标 + 关于弹窗
- [安装版崩溃修复]
- [文案丰富化] 提示词

## 🗺️ 代码库摘要
  src/publisher/tiktok.js  →  export async function publishToTikTok(options) {; const { sessionPath, videoFile, titleFile, envId, apiKey } = options;; const txt = fs.readFileSync(titleFile, 'utf-8');; const lines = txt.split('\n').filter(Boolean);; const found = line.match(/#[^\s#]+/g);
  src/scheduler.js  →  const DATA_DIR = process.env.XNOWPOST_DATA_DIR || path.resolve('.');; const ROOT = path.resolve('.');; const SCHEDULE_FILE = path.join(DATA_DIR, 'config', 'schedule.json');; const MAX_RETRIES = 2;; const RETRY_DELAY = 60_000;
  src/index.js  →  const TIME_LABEL = new Date().getHours() < 12 ? '早上' : '晚上';; const c = await generateVideoContent(topic);; const tags = [...(c.tags_zh||[]), ...(c.tags_en||[])].map(t => '#'+t).join(' ');; const desc = `${c.title_zh}\n${c.title_en}\n\n${c.scenes.map((s,i)=>`${i+1}. ${s.scene_text_zh}`).join('\n')}\n\n${tags}; const slidesDir = path.join(workDir, 'slides');
  src/publisher/debug-trace.js  →  export class BrowserTracer {; const idx = ++this._stepIndex;; const step = { idx, name, startedAt: Date.now(), events: [] };; const eventLog = [];; const origLog = console.log;
  src/publisher/index.js  →  const DATA_DIR = process.env.XNOWPOST_DATA_DIR || path.resolve('.');; const OUTPUT_DIR = path.join(DATA_DIR, 'output');; export function findUnpublished() {; const unpublished = [];; const cwd = process.cwd();
  src/collector/browser.js  →  const BIT_API = 'http://127.0.0.1:54345';; export async function openBitProfile(envId, apiKey) {; const key = apiKey || process.env.BIT_API_KEY || '';; const body = { id: String(envId) };; const wsUrl = await callBitAPI('/browser/open', body, '');
  src/collector/index.js  →  const DB_PATH = path.resolve('data/analytics.db');; const CONFIG_PATH = path.resolve('config/user.json');; function loadAccounts() {; const cfg = fs.readJsonSync(CONFIG_PATH);; const sql = 'INSERT OR REPLACE INTO daily_stats (date, account, platform, metric, value) VALUES (?, ?, ?, ?, ?)';
  src/db.js  →  export async function openDB(dbPath) {; const SQL = await getInit();; const db = new SQL.Database(buf);; const stmt = db.prepare(sql);; const rows = [];
  src/collector/scrapers/tiktok.js  →  export async function scrapeTikTok(page) {; const stats = {}; const data = await page.evaluate(() => {; const text = document.body.innerText; const lines = text
  src/analyzer/trends.js  →  const DB_PATH = path.resolve('data/analytics.db');; export async function analyzeTrends(platform, days = 7) {; const db = await openDB(DB_PATH, { readonly: true });; const today = new Date().toISOString().split('T')[0];; const weekAgo = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  src/analyzer/daily.js  →  const platformEmoji = {; const metricLabels = {; function getYesterday(dateStr) {; const d = new Date(dateStr);; export async function generateDailyReport(date, todayResults, db) {
  src/renderer/router/index.js  →  const routes = [; export default createRouter({

## ⚡ 建议操作
- [ ] 继续当前会话开发
- [ ] 重开新对话 → 把本文件发给 AI
