/**
 * 发布全过程监测器（只读，不点任何按钮）
 *
 * 用途：用户设好闹钟后，盯住「生成 → 上传 → 填文案 → 检查 → 发布」整条链路，
 * 每轮把关键状态打出来；页面卡在哪一步一眼能看到。
 *
 *   node scripts/_watch-publish.mjs TK04 --minutes 20
 *
 * 只做三件只读的事：读调度器日志尾巴、看当天会话目录产物、调 /page/evaluate 读页面状态。
 */
import fs from 'fs';
import path from 'path';

const BASE = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = process.argv[2] || 'TK04';
const MINUTES = Number((process.argv.find((a) => a.startsWith('--minutes')) || '').split('=')[1] || process.argv[process.argv.indexOf('--minutes') + 1] || 20);
const DATA_DIR = process.env.APPDATA ? path.join(process.env.APPDATA, 'xnowpost') : process.cwd();
const LOG_DIR = path.join(DATA_DIR, 'logs');

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const stamp = () => new Date().toTimeString().slice(0, 8);

async function call(p, opts = {}) {
  const res = await fetch(BASE + p, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeout || 15000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text };
  }
}

const PAGE_SCRIPT = `(() => {
  const txt = (document.body.innerText || '');
  const btn = document.querySelector('[data-e2e="post_video_button"]');
  const cap = document.querySelector('[data-e2e="caption-input"], div[contenteditable="true"]');
  const dlg = document.querySelector('[role="dialog"], div[class*="Modal"], div[class*="modal"]');
  const sw = document.querySelector('[data-e2e="aigc_container"] .Switch__content');
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  return {
    url: location.href,
    title: document.title,
    uploadPct: (txt.match(/(\\d{1,3})%/) || [null])[0],
    uploaded: /Uploaded|上传完成/i.test(txt),
    postBtn: btn ? { disabled: btn.getAttribute('data-disabled'), aria: btn.getAttribute('aria-disabled') } : null,
    postVisible: vis(btn),
    captionLen: cap ? (cap.innerText || cap.textContent || '').length : 0,
    aigc: sw ? sw.getAttribute('aria-checked') : 'no-switch',
    dialog: dlg && vis(dlg) ? (dlg.innerText || '').replace(/\\s+/g, ' ').slice(0, 120) : null,
    checking: /Checking|正在检查/i.test(txt),
    noIssues: txt.includes('No issues found') || txt.includes('未发现问题'),
    snippet: txt.replace(/\\s+/g, ' ').slice(0, 160),
  };
})()`;

const seen = new Set();
function logLine(line) {
  if (!line || seen.has(line)) return;
  seen.add(line);
  if (seen.size > 400) seen.clear();
  console.log(`  [${stamp()}] ${line}`);
}

function tailLog() {
  const f = path.join(LOG_DIR, `scheduler-${today()}.log`);
  try {
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    for (const l of lines.slice(-8)) logLine(l.trim());
  } catch (_) {}
}

function sessionState() {
  const dir = path.join(DATA_DIR, 'output', today());
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^(am|pm)_\d{4}$/.test(d.name))
      .map((d) => ({ name: d.name, at: fs.statSync(path.join(dir, d.name)).mtimeMs }));
  } catch (_) {
    return { dir: dir, latest: null };
  }
  dirs.sort((a, b) => b.at - a.at);
  if (!dirs.length) return { dir, latest: null };
  const full = path.join(dir, dirs[0].name);
  const files = fs.readdirSync(full).filter((n) => !n.startsWith('dialog-'));
  const flags = {
    txt: files.includes('文案.txt'),
    cover: files.includes('封面.png'),
    video: files.includes('video.mp4'),
    published: files.includes('.published'),
    failed: files.includes('FAILED'),
  };
  const size = flags.video ? Math.round(fs.statSync(path.join(full, 'video.mp4')).size / 1024) : 0;
  return { dir, latest: dirs[0].name, full, flags, size, dialogs: fs.readdirSync(full).filter((n) => n.startsWith('dialog-') && n.endsWith('.png')).length };
}

const started = Date.now();
const deadline = started + MINUTES * 60 * 1000;
let lastSession = '';
let lastPhase = '';
let probes = 0;

console.log(`  监测 ${ENV} 的发布全过程，最长 ${MINUTES} 分钟（只读，不点页面）`);

while (Date.now() < deadline) {
  tailLog();

  const st = sessionState();
  if (st.latest) {
    const key = `${st.latest}|${JSON.stringify(st.flags)}`;
    if (key !== lastSession) {
      lastSession = key;
      logLine(`📁 会话 ${st.latest}: 文案=${st.flags.txt} 封面=${st.flags.cover} 视频=${st.flags.video}(${st.size}KB) 已发布=${st.flags.published} 失败=${st.flags.failed} 弹窗截图=${st.dialogs || 0}`);
    }
  } else {
    logLine('⏳ 还没生成会话目录（引擎可能在做图片/视频）');
  }

  let page = null;
  try {
    const r = await call(`/browser/${encodeURIComponent(ENV)}/page/evaluate`, { method: 'POST', body: { script: PAGE_SCRIPT } });
    page = r?.data || r?.result || null;
    if (page && page.url) probes++;
  } catch (_) {
    page = null;
  }

  if (page && page.url) {
    const phase = page.url.includes('tiktokstudio')
      ? page.uploaded
        ? 'uploaded'
        : 'uploading'
      : 'other';
    const summary = `🌐 ${phase} url=${String(page.url).replace(/^https?:\/\/(www\.)?/, '').slice(0, 48)} 上传=${page.uploadPct || '-'} Post=${page.postBtn ? `dis=${page.postBtn.disabled}/aria=${page.postBtn.aria}/vis=${page.postVisible}` : '无'} 文案=${page.captionLen}字 AI=${page.aigc} 检查中=${page.checking} 无问题=${page.noIssues}`;
    if (summary !== lastPhase) {
      lastPhase = summary;
      console.log(`\n  [${stamp()}] ${summary}`);
      if (page.dialog) console.log(`             ⚠️ 有弹窗: ${page.dialog}`);
    } else if (page.dialog) {
      console.log(`  [${stamp()}] ⚠️ 弹窗仍在: ${page.dialog.slice(0, 80)}`);
    }
    if (st.flags.published) {
      console.log(`\n  ✅ [${stamp()}] 已发布（.published 已写入）`);
      break;
    }
    if (st.flags.failed) {
      console.log(`\n  ❌ [${stamp()}] 出现 FAILED 标记`);
      break;
    }
  }

  await new Promise((r) => setTimeout(r, 8000));
}

const st = sessionState();
console.log(`\n  ── 监测结束 ── 探测页面 ${probes} 次`);
console.log(`  最新会话: ${st.latest || '无'}  ${JSON.stringify(st.flags || {})}`);
