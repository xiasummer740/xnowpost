import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ⚠️ 不要把数据库副本提交进仓库 —— 本仓库是公开的，其中含比特浏览器的浏览器/账号 ID。
// 默认写到系统临时目录，避免污染工作区、也避免被误提交。
const dbPath = process.argv[2] || path.join(os.tmpdir(), 'xnowpost-bitbrowser-dump.db');

if (!fs.existsSync(dbPath)) {
  // 从比特浏览器的实际安装位置复制（%APPDATA%，不要硬编码用户名）
  const candidates = [
    path.join(process.env.APPDATA || '', 'BitBrowser', 'db.sqlite'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'BitBrowser', 'db.sqlite'),
  ];
  const src = candidates.find(p => p && fs.existsSync(p));
  if (!src) {
    console.error('未找到比特浏览器数据库，尝试过:');
    for (const c of candidates) console.error('  ' + c);
    process.exit(1);
  }
  fs.copyFileSync(src, dbPath);
  console.log('Copied to', dbPath);
}

const buf = fs.readFileSync(dbPath);
const SQL = await initSqlJs.default();
const db = new SQL.Database(buf);

const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
console.log('Tables:', tables[0]?.values?.map(r => r[0]).join(', '));

for (const t of tables[0]?.values || []) {
  const name = t[0];
  const cols = db.exec('PRAGMA table_info(' + JSON.stringify(name) + ')');
  console.log('\n=== ' + name + ' ===');
  console.log('Columns:', cols[0]?.values?.map(c => c[1]).join(', '));
  const cnt = db.exec('SELECT COUNT(*) FROM ' + JSON.stringify(name));
  console.log('Rows:', cnt[0]?.values?.[0]?.[0] || 0);

  // Show all rows for small tables
  const rows = db.exec('SELECT * FROM ' + JSON.stringify(name) + ' LIMIT 30');
  if (rows[0]?.values) {
    for (const row of rows[0].values) {
      console.log('  ', row.map(c => String(c).substring(0, 80)).join(' | '));
    }
  }
}

db.close();
