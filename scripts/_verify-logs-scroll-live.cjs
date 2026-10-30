/*
 * 在真机上验证：装好的 XNOWPost 1.9.7，日志页滚到中间还会不会被 5 秒轮询拽回顶部。
 *
 * 前提：应用已用 --remote-debugging-port=9227 启动。
 * 判据：等两个轮询周期（12 秒）后，「视野里第一个任务轮次」不变、偏移不变。
 */
const http = require('node:http');

const PORT = 9227;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = (u) => new Promise((res, rej) => {
    http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
    const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    if (!page) { console.error('❌ 没找到应用窗口'); process.exit(1); }
    console.log('🪟 窗口: ' + page.title + '  ' + page.url.slice(0, 60));

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    const send = (method, params = {}) => new Promise((res) => {
        const i = ++id;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
    await new Promise((r) => { ws.onopen = r; });
    await send('Runtime.enable');
    await send('Page.enable');

    const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

    // ① 进「日志」页
    const nav = await ev(`(async () => {
        const item = [...document.querySelectorAll('a,div,span,button')].filter(e => (e.innerText||'').trim() === '日志')
            .sort((a,b) => a.innerText.length - b.innerText.length)[0];
        if (!item) return 'no-nav';
        item.click();
        await new Promise(r => setTimeout(r, 4000));
        return document.querySelector('.log-container') ? 'ok' : 'no-container';
    })()`);
    console.log('📄 进入日志页: ' + nav);
    await wait(2500);

    const meta = await ev(`(() => {
        const el = document.querySelector('.log-container');
        const runs = document.querySelectorAll('.run').length;
        return JSON.stringify({ runs, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, canScroll: el.scrollHeight - el.clientHeight });
    })()`);
    console.log('📊 页面数据: ' + meta);

    // ② 滚到中间，等两个轮询周期
    const result = await ev(`(async () => {
        const el = document.querySelector('.log-container');
        if (el.scrollHeight - el.clientHeight < 50) return JSON.stringify({ skipped: '内容太短，滚不动' });
        el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.35);
        el.dispatchEvent(new Event('scroll'));
        await new Promise(r => setTimeout(r, 300));
        const pick = () => {
            const box = el.getBoundingClientRect();
            const runs = [...el.querySelectorAll('.run')];
            const vis = runs.find(r => r.getBoundingClientRect().bottom > box.top + 2);
            return vis ? { id: (vis.querySelector('.run-time')||{}).textContent || '?', off: Math.round(vis.getBoundingClientRect().top - box.top) } : { id: 'none', off: 0 };
        };
        const before = pick();
        const topBefore = el.scrollTop;
        await new Promise(r => setTimeout(r, 13000));   // 2.6 个轮询周期
        const after = pick();
        return JSON.stringify({ topBefore, topAfter: el.scrollTop, before, after, sameRun: before.id === after.id, offShift: Math.abs(after.off - before.off), height: el.scrollHeight });
    })()`);
    console.log('🧪 滚动测试: ' + result);

    // ③ 截图
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const fs = require('node:fs');
    const path = require('node:path');
    const out = path.join(__dirname, '..', 'output', 'xnowpost-logs-1.9.7.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('🖼  截图: ' + out);
    ws.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
