import { checkLogins, foxDataDir } from '../src/login-state.js';
import fs from 'fs';
import path from 'path';

const envs = Array.from({ length: 10 }, (_, i) => `TK${String(i + 1).padStart(2, '0')}`);
const dir = foxDataDir();
console.log('camoufox_data =', dir);
const res = await checkLogins(envs, { dir });
for (const env of envs) {
  const one = res[env] || res.find?.((r) => r.env === env) || {};
  const db = path.join(dir, env, 'cookies.sqlite');
  let mt = '';
  try {
    mt = fs.statSync(db).mtime.toLocaleString('sv-SE');
  } catch (_) {
    mt = '无库';
  }
  console.log(`  ${env}  ${JSON.stringify(one)}  cookie库 mtime=${mt}`);
}
