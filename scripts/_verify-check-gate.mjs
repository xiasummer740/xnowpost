/**
 * 用真实页面数据验证新版「检查判定」逻辑（只读，不点任何按钮）
 * 复刻 src/publisher/tiktok.js 里那段三态判定，看会不会在 2 轮内放行。
 */
const BASE = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = process.argv[2] || 'TK01';
const seg = encodeURIComponent(ENV);

async function call(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeout || 20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text };
  }
}

const snapResp = await call(`/browser/${seg}/page/evaluate`, {
  method: 'POST',
  body: {
    script: `(() => {
      const txt = document.body.innerText || '';
      const btn = document.querySelector('[data-e2e="post_video_button"]');
      return {
        url: location.href,
        txt,
        postReady: !!btn && btn.getAttribute('data-disabled') !== 'true' && btn.getAttribute('aria-disabled') !== 'true',
      };
    })()`,
  },
});

const snap = snapResp.result || snapResp;
const text = snap.txt || '';
const okIdx = Math.max(text.lastIndexOf('未发现问题'), text.lastIndexOf('No issues found'));
const musicIdx = Math.max(text.indexOf('音乐版权检查'), text.indexOf('Music copyright check'));
const contentIdx = Math.max(text.indexOf('内容快速检查'), text.indexOf('Content check lite'));
const checking = /正在检查|Checking your content|Checking/i.test(text);

const musicOk = musicIdx < 0 || okIdx > musicIdx;
const contentOk = contentIdx < 0 || okIdx > contentIdx;
const fastPass = musicOk && contentOk && !checking;
const fallback = !checking && musicIdx < 0 && okIdx < 0 && snap.postReady;

console.log(`  环境 ${ENV} → ${snap.url}`);
console.log(`  Post 可点: ${snap.postReady}`);
console.log(`  音乐检查项: ${musicIdx >= 0 ? '有' : '无'} · 内容检查项: ${contentIdx >= 0 ? '有' : '无'} · "未发现问题": ${okIdx >= 0 ? '有' : '无'} · 检查进行中: ${checking ? '是' : '否'}`);
console.log('');
console.log(`  判定 a（有检查项且都通过）: ${fastPass ? '✅ 放行' : '—'}`);
console.log(`  判定 c（无自动检查 + Post 可点）: ${fallback ? '✅ 两轮后放行（约 10 秒）' : '—'}`);
console.log('');
if (fastPass || fallback) {
  console.log('  结论：新版逻辑会放行，不会卡 15 分钟。');
} else {
  console.log('  结论：仍会继续等（页面确实在检查或按钮不可点，属于正常等待）。');
}
