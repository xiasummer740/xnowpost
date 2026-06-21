import initSqlJs from 'sql.js';
import fs from 'fs';

const dbPath = process.argv[2];
if (!dbPath) { console.error('Usage: node read-sqlite.mjs <path>'); process.exit(1); }
if (!fs.existsSync(dbPath)) { console.error('File not found:', dbPath); process.exit(1); }

const buf = fs.readFileSync(dbPath);
const SQL = await initSqlJs.default();
const db = new SQL.Database(buf);

const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
console.log('Tables:', tables[0]?.values?.map(r => r[0]).join(', '));

for (const t of tables[0]?.values || []) {
  const name = t[0];
  const cols = db.exec('PRAGMA table_info(' + JSON.stringify(name) + ')');
  const colNames = cols[0]?.values?.map(c => c[1]).join(', ') || '';
  console.log('\n=== ' + name + ' ===');
  console.log('Columns:', colNames);

  // Skip large tables - only show count
  const cnt = db.exec('SELECT COUNT(*) FROM ' + JSON.stringify(name));
  const count = cnt[0]?.values?.[0]?.[0] || 0;
  console.log('Rows:', count);

  if (count > 0 && count < 100) {
    const rows = db.exec('SELECT * FROM ' + JSON.stringify(name) + ' LIMIT 20');
    if (rows[0]?.values) {
      for (const row of rows[0].values) {
        console.log('  ', row.map(c => String(c).substring(0, 60)).join(' | '));
      }
    }
  }
}

db.close();
