/*
 * 验证「日志页滚动会不会被 5 秒轮询拽回顶部」
 *
 * 做法：把 dist 用静态服务跑起来，用无头 Chrome 打开 #/logs，
 * 把 window.xnowpost 换成假的（返回一天的日志，并且每 5 秒像真调度器那样往上加新轮次），
 * 然后：滚到中间 → 等两个轮询周期 → 看 scrollTop 有没有被改动。
 *
 * 判据：变位 < 4px 视为「不跳」。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DIST = path.join(__dirname, '..', 'dist');
const PORT = 8231;
const CDP = 'http://127.0.0.1:9223';

// ── ① 用真实日志造数据（时间戳真实、消息真实，分组逻辑才有意义）
const LOG_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'xnowpost', 'logs');
function readLog(name, source) {
    const f = path.join(LOG_DIR, name);
    if (!fs.existsSync(f)) return [];
    const raw = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    const out = [];
    for (const line of raw) {
        const m = line.match(/^\[?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})[^\]]*\]?\s*(?:\[(\w+)\]\s*)?(.*)$/);
        if (!m) continue;
        const [, d, t, tag, msg] = m;
        const text = msg || '';
        const type = /✅|成功|完成/.test(text) ? 'success'
            : /❌|失败|错误|Error/.test(text) ? 'error'
                : /⚠|警告|WARN/.test(text) ? 'warning' : 'info';
        out.push({ time: `${d} ${t}`, type, source: tag === 'scheduler' ? 'scheduler' : source, message: text });
    }
    return out;
}

(async () => {
    const day = '2026-10-30';
    let logs = [...readLog(`app-${day}.log`, 'app'), ...readLog(`scheduler-${day}.log`, 'scheduler')]
        .sort((a, b) => a.time.localeCompare(b.time));
    if (logs.length < 200) { console.error('真实日志太少（' + logs.length + ' 行），换一天再试'); process.exit(1); }
    console.log(`📄 用真实日志 ${logs.length} 行做数据`);

    // ── ② 静态服务
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
    const server = http.createServer((req, res) => {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p === '/') p = '/index.html';
        const f = path.join(DIST, p);
        if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nope'); }
        res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' });
        fs.createReadStream(f).pipe(res);
    }).listen(PORT);

    // ── ③ 连无头 Chrome，开新标签
    const http_ = require('node:http');
    const getJson = (u) => new Promise((res, rej) => http_.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));
    const ver = await getJson(`${CDP}/json/version`);
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    const send = (method, params = {}, sessionId) => new Promise((res) => {
        const i = ++id;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    };
    await new Promise((r) => { ws.onopen = r; });

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p) => send(m, p, sessionId);
    await S('Page.enable');
    await S('Runtime.enable');
    await S('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });

    // 假 preload：给一天的日志；每 5 秒在**最前面**塞进新的一轮（模拟新任务开始）
    // 让分组视图也能滚动：再补 40 轮「像真的一样」的任务（每轮 9 行）
    const synthetic = [];
    for (let r = 0; r < 40; r++) {
        const hh = String(Math.floor(r / 60) + 1).padStart(2, '0');
        const mm = String(r % 60).padStart(2, '0');
        const stamp = `2026-10-30 ${hh}:${mm}:05`;
        synthetic.push({ time: stamp, type: 'info', source: 'scheduler', message: `🚀 补数据轮次 #${r + 1} 任务开始` });
        for (let i = 0; i < 7; i++) synthetic.push({ time: stamp, type: 'info', source: 'scheduler', message: `第 ${r + 1} 轮：处理第 ${i + 1} 条（模拟中间过程日志，用来把高度撑起来）` });
        synthetic.push({ time: stamp, type: 'success', source: 'scheduler', message: `✅ 补数据轮次 #${r + 1} 任务完成，发布 2 个号` });
    }
    logs = [...synthetic, ...logs];
    console.log(`   + 合成 ${synthetic.length} 行（40 轮），总计 ${logs.length} 行`);
    const seed = JSON.stringify(logs);
    const stub = `
    (() => {
      const base = ${seed};
      let extra = 0;
      window.__logs = base.slice();
      const newRun = () => {
        extra++;
        const t = new Date();
        const hh = String(t.getHours()).padStart(2,'0'), mm = String(t.getMinutes()).padStart(2,'0'), ss = String(t.getSeconds()).padStart(2,'0');
        const stamp = '2026-10-30 ' + hh + ':' + mm + ':' + ss;
        const lines = [];
        for (let i = 0; i < 6; i++) {
          lines.push({ time: stamp, type: 'info', source: 'scheduler', message: '🚀 轮询-新轮次 #' + extra + ' 任务开始（第 ' + (i+1) + ' 步）' });
        }
        lines.push({ time: stamp, type: 'success', source: 'scheduler', message: '✅ 新轮次任务完成，发布 1 个号' });
        return lines;
      };
      setInterval(() => { window.__logs = window.__logs.concat(newRun()); }, 5000);
      window.xnowpost = {
        getLogs: async () => window.__logs,
        getLogsByDate: async () => window.__logs,
        clearLogs: async () => {},
        openLogFolder: async () => ({ ok: true }),
        getConfig: async () => ({}),
      };
    })();`;
    await S('Page.addScriptToEvaluateOnNewDocument', { source: stub });
    await S('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html#/logs` });
    await new Promise((r) => setTimeout(r, 6000));

    const evalJs = async (expr) => (await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

    const ready = await evalJs(`(() => { const el = document.querySelector('.log-container'); return el ? el.scrollHeight + '/' + el.clientHeight : 'no-container'; })()`);
    console.log('📦 容器就绪: ' + ready);

    // ── ④ 分组视图：滚到 40% 处，等 2 个轮询周期
    const runsTest = await evalJs(`(async () => {
        const el = document.querySelector('.log-container');
        const runs = document.querySelectorAll('.run').length;
        if (el.scrollHeight - el.clientHeight < 50) return JSON.stringify({ skipped: true, runs, height: el.scrollHeight });
        const target = Math.round((el.scrollHeight - el.clientHeight) * 0.4);
        el.scrollTop = target;
        el.dispatchEvent(new Event('scroll'));
        // 分组视图新轮次插在顶部 → scrollTop 会"故意"变大，真正该看的是
        // 「视野里第一个轮次还是不是同一轮、偏移有没有变」（内容不跳）
        const pickTop = () => {
            const box = el.getBoundingClientRect();
            const runs2 = [...el.querySelectorAll('.run')];
            const vis = runs2.find(r => r.getBoundingClientRect().bottom > box.top + 2);
            if (!vis) return { id: 'none', off: 0 };
            return {
                id: (vis.querySelector('.run-time') || {}).textContent || '?',
                off: Math.round(vis.getBoundingClientRect().top - box.top),
            };
        };
        const b = pickTop();
        const before = el.scrollTop;
        await new Promise(r => setTimeout(r, 12000));   // 两个 5 秒轮询 + 新轮次插到顶部
        const a = pickTop();
        return JSON.stringify({ runs, before, after: el.scrollTop, topBefore: b, topAfter: a, sameRun: b.id === a.id, offShift: Math.abs(a.off - b.off) });
    })()`);
    console.log('🧩 分组视图 ' + runsTest);

    // ── ⑤ 切到「全部行」，同样滚到中间再等
    const flatTest = await evalJs(`(async () => {
        const chips = [...document.querySelectorAll('.filter-chip')];
        const flat = chips.find(c => c.textContent.includes('全部行'));
        flat.click();
        await new Promise(r => setTimeout(r, 1200));
        const el = document.querySelector('.log-container');
        const target = Math.round((el.scrollHeight - el.clientHeight) * 0.5);
        el.scrollTop = target;
        el.dispatchEvent(new Event('scroll'));
        const before = el.scrollTop;
        await new Promise(r => setTimeout(r, 12000));
        const after = el.scrollTop;
        return JSON.stringify({ before, after, shift: Math.abs(after - before), height: el.scrollHeight });
    })()`);
    console.log('📜 全部行   ' + flatTest);

    // ── ⑥ 回分组视图，确认「贴顶时仍然跟着最新」
    const stickTest = await evalJs(`(async () => {
        const chips = [...document.querySelectorAll('.filter-chip')];
        chips.find(c => c.textContent.includes('按任务分组')).click();
        await new Promise(r => setTimeout(r, 1500));
        const el = document.querySelector('.log-container');
        el.scrollTop = 0;
        el.dispatchEvent(new Event('scroll'));
        await new Promise(r => setTimeout(r, 11000));
        return JSON.stringify({ scrollTop: el.scrollTop, firstText: (el.querySelector('.run-time')||{}).textContent || '' });
    })()`);
    console.log('🎯 贴顶跟随 ' + stickTest);

    const shot = await S('Page.captureScreenshot', { format: 'png' });
    const out = path.join(__dirname, '..', 'output', 'logs-scroll-fix.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('🖼  截图已存 ' + out);

    await send('Target.closeTarget', { targetId });
    ws.close();
    server.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
