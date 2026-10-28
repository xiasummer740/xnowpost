/** 头像真相核查：主页上现在挂的是哪张图？
 *  - 截图（肉眼）
 *  - img[class*=ImgAvatar] 的 src + 自然尺寸
 *  - 用 node 直接把这个 URL 再抓一遍（换随机 query 破缓存），比哈希
 *  - 顺带读 data/avatars/<env>.jpg 的哈希
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { openFoxPage, closeFoxPage } from '../src/collector/foxpw.js';

const API = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENVS = (process.argv[2] || 'TK01').split(',').map((s) => s.trim().toUpperCase());
const SHOT = path.join(process.env.TEMP || '.', 'xnow-probe');
fs.mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex').slice(0, 12);
const AVATAR_DIR = path.join(process.env.APPDATA || '', 'xnowpost', 'data', 'avatars');

const fetchBuf = (url, redirects = 0) =>
  new Promise((resolve, reject) => {
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { headers: { 'user-agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 4) {
        res.resume();
        return resolve(fetchBuf(res.headers.location, redirects + 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });

const out = [];
for (const env of ENVS) {
  const rec = { env };
  let page = null;
  try {
    const opened = await openFoxPage(env, API);
    page = opened.page;
    // 用户名：从 env-accounts 读（避免用旧 handle）
    const st = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'xnowpost', 'data', 'env-accounts.json'), 'utf8'));
    const handle = (st[env] && st[env].username) || '';
    rec.handle = handle;
    for (let i = 0; i < 3; i++) {
      try {
        await page.goto(`https://www.tiktok.com/@${handle}?lang=en&_r=${Date.now()}`, { waitUntil: 'commit' });
        break;
      } catch {
        await sleep(2000);
      }
    }
    await sleep(7000);
    rec.dom = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img[class*="ImgAvatar"], img.user-avatar')];
      const pick = imgs.find((i) => i.naturalWidth > 40) || imgs[0];
      return {
        count: imgs.length,
        src: pick ? pick.src : '',
        natural: pick ? `${pick.naturalWidth}x${pick.naturalHeight}` : '',
        title: document.title,
      };
    });
    const p = path.join(SHOT, `${env}-now.png`);
    await page.screenshot({ path: p }).catch(() => {});
    rec.shot = p;

    if (rec.dom.src) {
      const bust = rec.dom.src + (rec.dom.src.includes('?') ? '&' : '?') + '_cb=' + Date.now();
      try {
        const r = await fetchBuf(bust);
        rec.cdn = { status: r.status, bytes: r.buf.length, sha1: sha1(r.buf) };
      } catch (e) {
        rec.cdn = { error: String(e.message || e) };
      }
      // 从 URL 里抠出图片对象 id（tiktok 的头像 id 形如 …-avt-0068-xxxx）
      const m = rec.dom.src.match(/avt-[0-9a-f]+-([0-9a-zA-Z]+)/);
      rec.avatarId = m ? m[1].slice(0, 16) : '';
    }
    const localFile = path.join(AVATAR_DIR, `${env}.jpg`);
    if (fs.existsSync(localFile)) {
      const b = fs.readFileSync(localFile);
      rec.local = { bytes: b.length, sha1: sha1(b) };
    }
  } catch (e) {
    rec.error = String(e.message || e);
  } finally {
    if (page) await closeFoxPage(env, API).catch(() => {});
    out.push(rec);
  }
}
console.log(JSON.stringify(out, null, 1));
