import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const dbPath = path.join(process.env.APPDATA || '', 'xnowpost', 'data', 'analytics.db');
const db = new DatabaseSync(dbPath);
const tables = db.prepare("select name from sqlite_master where type='table'").all();
console.log('  db:', dbPath);
console.log('  表:', tables.map((t) => t.name).join(', '));
for (const t of tables) {
  const cols = db.prepare(`pragma table_info(${t.name})`).all().map((c) => c.name);
  const n = db.prepare(`select count(*) c from ${t.name}`).get().c;
  console.log(`  ${t.name} (${n} 行): ${cols.join(', ')}`);
  const rows = db.prepare(`select * from ${t.name} order by rowid desc limit 3`).all();
  for (const r of rows) console.log('     ', JSON.stringify(r).slice(0, 300));
}
db.close();
