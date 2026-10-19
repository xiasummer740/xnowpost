import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// 不要硬编码用户名/盘符 —— 用 %APPDATA% 推导（本仓库是公开的）
const dbFile = process.argv[2]
  || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'BitBrowser', 'db.sqlite');
if (!fs.existsSync(dbFile)) {
  console.error('未找到比特浏览器数据库: ' + dbFile);
  console.error('可传入路径: node scripts/read-bitbrowser-db.js <db.sqlite 路径>');
  process.exit(1);
}
const buf = fs.readFileSync(dbFile);
const SQL = await initSqlJs.default();
const db = new SQL.Database(buf);

const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
console.log('Tables:', tables[0]?.values?.map(r => r[0]).join(', '));

for (const t of tables[0]?.values || []) {
  const name = t[0];
  const cols = db.exec('PRAGMA table_info(' + JSON.stringify(name) + ')');
  console.log('\n=== ' + name + ' ===');
  console.log('Columns:', cols[0]?.values?.map(c => c[1]).join(', '));
  const rows = db.exec('SELECT * FROM ' + JSON.stringify(name) + ' LIMIT 20');
  if (rows[0]?.values) {
    for (const row of rows[0].values) {
      console.log('  ', row.map(c => String(c).substring(0, 60)).join(' | '));
    }
  }
}

db.close();
