/* 在真机应用里验证「全部行」视图：滚到中间，等两个 5 秒轮询，看会不会被拽走 */
const http = require('node:http');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

(async () => {
    const targets = await getJson('http://127.0.0.1:9227/json/list');
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
    await new Promise((r) => { ws.onopen = r; });
    await send('Runtime.enable');
    const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value;

    const r = await ev(`(async () => {
        const chips = [...document.querySelectorAll('.filter-chip')];
        const flat = chips.find(c => c.textContent.includes('全部行'));
        if (!flat) return 'no-chip';
        flat.click();
        await new Promise(r => setTimeout(r, 2500));
        const el = document.querySelector('.log-container');
        const can = el.scrollHeight - el.clientHeight;
        if (can < 100) return JSON.stringify({ skipped: true, can, runs: 0 });
        el.scrollTop = Math.round(can * 0.5);
        el.dispatchEvent(new Event('scroll'));
        await new Promise(r => setTimeout(r, 300));
        const before = el.scrollTop;
        const firstId = () => {
            const box = el.getBoundingClientRect();
            const lines = [...el.querySelectorAll('.log-line')];
            const vis = lines.find(l => l.getBoundingClientRect().bottom > box.top + 2);
            return vis ? (vis.querySelector('.log-time') || {}).textContent + ' ' + (vis.querySelector('.log-msg') || {}).textContent.slice(0, 20) : 'none';
        };
        const t1 = firstId();
        await new Promise(r => setTimeout(r, 13000));   // 两个轮询周期
        return JSON.stringify({ can, before, after: el.scrollTop, shift: Math.abs(el.scrollTop - before), topBefore: t1, topAfter: firstId(), height: el.scrollHeight });
    })()`);
    console.log('📜 全部行滚动测试: ' + r);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    require('node:fs').writeFileSync(__dirname + '/../output/xnowpost-logs-flat-1.9.7.png', Buffer.from(shot.data, 'base64'));
    console.log('🖼  截图: output/xnowpost-logs-flat-1.9.7.png');
    ws.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
