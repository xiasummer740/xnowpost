/** 验证「环境名写进窗口标题」在真实 TikTok 页面上生效 */
import { envTitleScript } from '../src/env-label.js';

const base = 'http://127.0.0.1:8000/api/v1';

async function post(path, body) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

const b = await (await fetch(`${base}/browser`)).json();
const running = Array.isArray(b.running) ? b.running : [];
console.log(`  运行中: ${running.join(',') || '(无)'}`);

for (const env of running) {
  const d = await post(`/browser/${env}/page/evaluate`, { script: envTitleScript(env) });
  console.log(`  ${env} → document.title = ${JSON.stringify(d.result)}`);
}

// 等 1.5 秒让 OS 窗口标题更新
await new Promise((r) => setTimeout(r, 1500));
console.log('  下面用 PowerShell 读真实窗口标题：');
