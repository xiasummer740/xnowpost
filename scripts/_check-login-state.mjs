/** 临时自检：登录态模块（不参与打包） */
import fs from 'fs';
import path from 'path';
import { checkLogin, describeLogin, resolveEnvs, allConfigEnvs, cookieDbFor } from '../src/login-state.js';

const cfgFile = path.join(process.env.APPDATA, 'xnowpost', 'config', 'user.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));

console.log('  环境 cookie 库: ' + cookieDbFor('TK01'));
console.log('');
for (const env of ['TK01', 'TK03', 'TK10', 'TK99']) {
  const r = await checkLogin(env);
  console.log('  ' + describeLogin(r));
}
console.log('');
console.log('  resolveEnvs("03")      -> ' + JSON.stringify(resolveEnvs('03', cfg)));
console.log('  resolveEnvs("07,TK09") -> ' + JSON.stringify(resolveEnvs('07,TK09', cfg)));
console.log('  allConfigEnvs()        -> ' + allConfigEnvs(cfg).join(','));
