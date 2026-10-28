// 临时脚本（不入库）：验证 TK01 能否真正打开 TikTok 首页并出网
import fs from 'fs-extra';

const BASE = 'http://127.0.0.1:8000/api/v1';
const env = process.argv[2] || 'TK01';
const url = process.argv[3] || 'https://www.tiktok.com/';

const post = async (path, body, timeout = 90000) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeout),
  });
  const t = await r.text();
  try {
    return { status: r.status, data: JSON.parse(t) };
  } catch {
    return { status: r.status, data: { raw: t.slice(0, 300) } };
  }
};

console.log('运行中：', JSON.stringify((await (await fetch(`${BASE}/browser`)).json()).running));

const nav = await post(`/browser/${env}/page/navigate`, { url, wait_until: 'domcontentloaded' });
console.log(`导航 → ${nav.status}`, JSON.stringify(nav.data).slice(0, 200));

await new Promise((r) => setTimeout(r, 6000));

const probe = await post(`/browser/${env}/page/evaluate`, {
  script: `JSON.stringify({
    url: location.href,
    title: document.title,
    loggedIn: !!document.querySelector('[data-e2e="profile-icon"]'),
    hasVideo: !!document.querySelector('video'),
    bodyLen: document.body.innerText.length,
    first120: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 120)
  })`,
});
console.log('页面自证 →', probe.data?.result || JSON.stringify(probe.data).slice(0, 300));

const shot = await fetch(`${BASE}/browser/${env}/page/screenshot`, {
  signal: AbortSignal.timeout(90000),
});
const ct = shot.headers.get('content-type') || '';
const buf = Buffer.from(await shot.arrayBuffer());
if (ct.includes('image') || (buf[0] === 0x89 && buf[1] === 0x50)) {
  const out = 'output/tk01-home.png';
  fs.writeFileSync(out, buf);
  console.log(`截图已保存 ${out}（${Math.round(buf.length / 1024)} KB, ${ct}）`);
} else {
  console.log('截图接口返回异常：', ct, buf.toString('utf8').slice(0, 200));
}
