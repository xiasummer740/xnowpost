/** 只读看一下 TK01 当前打开的页面状态（不动页面、不点按钮） */
const BASE = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = process.argv[2] || 'TK01';

async function call(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeout || 20000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  return data;
}

const seg = encodeURIComponent(ENV);
const info = await call(`/browser/${seg}/page/info`).catch((e) => ({ error: e.message }));
console.log('  页面信息:', JSON.stringify(info).slice(0, 300));

const ev = await call(`/browser/${seg}/page/evaluate`, {
  method: 'POST',
  body: {
    script: `(() => {
      const btn = document.querySelector('[data-e2e="post_video_button"]');
      const cap = document.querySelector('[data-e2e="caption-input"], div[contenteditable="true"]');
      const txt = (document.body.innerText || '');
      return {
        url: location.href,
        postBtn: btn ? { disabled: btn.getAttribute('data-disabled'), aria: btn.getAttribute('aria-disabled'), text: (btn.innerText||'').trim().slice(0,30) } : null,
        caption: cap ? (cap.innerText || cap.textContent || '').slice(0, 120) : null,
        hasNoIssues: txt.includes('No issues found'),
        hasMusicCheck: txt.includes('Music copyright check') || txt.includes('音乐版权检查'),
        hasContentCheck: txt.includes('Content check lite') || txt.includes('内容快速检查'),
        checking: /Checking|正在检查/i.test(txt),
        uploadPct: (txt.match(/(\\d{1,3})%/) || [null])[0],
        textSnippet: txt.replace(/\\s+/g, ' ').slice(0, 400),
      };
    })()`,
  },
});
console.log('  状态:', JSON.stringify(ev.data || ev, null, 1));
