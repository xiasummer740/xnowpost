import initSqlJs from 'sql.js';
import fs from 'fs';

const dbPath = process.argv[2] || 'F:/summer/vs-code/xnowpost/tmp.db';

if (!fs.existsSync(dbPath)) {
  // Try to copy from BitBrowser
  const src = 'C:/Users/Administrator/AppData/Roaming/BitBrowser/db.sqlite';
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dbPath);
    console.log('Copied to', dbPath);
  } else {
    console.error('Source not found:', src);
    process.exit(1);
  }
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
