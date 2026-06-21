import initSqlJs from 'sql.js';
import fs from 'fs';

const buf = fs.readFileSync('C:/Users/Administrator/AppData/Roaming/BitBrowser/db.sqlite');
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
