import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const base = 'E:/software/FoxProfile/camoufox_data';
const envs = Array.from({ length: 10 }, (_, i) => `TK${String(i + 1).padStart(2, '0')}`);
const out = [];
for (const env of envs) {
  const db = path.join(base, env, 'cookies.sqlite');
  if (!fs.existsSync(db)) {
    out.push({ env, state: 'no-db' });
    continue;
  }
  try {
    const d = new DatabaseSync(db, { readOnly: true });
    const row = d
      .prepare(
        `select
           sum(case when name in ('sessionid','sessionid_ss','sid_tt','sid_guard') then 1 else 0 end) as sess,
           count(*) as total,
           max(case when name='sessionid' then expiry end) as exp
         from moz_cookies where host like '%tiktok.com'`
      )
      .get();
    d.close();
    out.push({
      env,
      state: Number(row.sess) > 0 ? 'in' : 'out',
      sess: Number(row.sess),
      tiktokCookies: Number(row.total),
      dbMtime: fs.statSync(db).mtime.toLocaleString('sv-SE'),
    });
  } catch (e) {
    out.push({ env, state: 'err', err: e.message, dbMtime: fs.statSync(db).mtime.toLocaleString('sv-SE') });
  }
}
console.log(JSON.stringify(out, null, 1));
