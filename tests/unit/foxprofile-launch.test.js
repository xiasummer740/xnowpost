/**
 * 「点启动 → 浏览器真的能用」这条链路的回归测试。
 *
 * 事故背景（2026-10-29 14:00 那轮养号）：11 个号里 TK06–TK11 全被判
 * 「养号失败：Browser is still starting」。真相是 FoxProfile 的 `/browser`
 * 只报**进程活着**，控制通道（`_controls[name]`）还没登记时任何页面动作都返回
 * `503 {"detail":"Browser is still starting"}`；旧版 launchAndWait 一看 running 里有它就
 * 当成功，于是第一个页面动作立刻 503，浏览器其实 20 秒后就完全可用了。
 *
 * 这里用一个假 FoxProfile（node:http）钉住正确行为：
 *  - 页面通道没好之前不能返回成功；
 *  - 好了之后必须返回成功；
 *  - 真的失败（端口/环境不存在）不能被"等 150 秒"掩盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { foxPageReady, launchAndWait } from '../../src/collector/foxprofile.js';

// 被测模块会 console.log（"⏳ 等它就绪…"）。测试里把它静音：
// 这些异步日志和 node:test 自己的 stdout 序列化消息交错时，runner 会报
// "Unable to deserialize cloned data due to invalid or unsupported version"（Node 24 实测）。
const realLog = console.log;
test.before(() => { console.log = () => {}; });
test.after(() => { console.log = realLog; });

/** 起一个假 FoxProfile：handler(pathname, method) → { status, body } */
async function fakeFox(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    calls.push(`${req.method} ${pathname}`);
    const { status = 200, body = {} } = handler(pathname, req.method) || {};
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    calls,
    close: () => new Promise((r) => server.close(r)),
    count: (pat) => calls.filter((c) => c.includes(pat)).length,
  };
}

const TABS_OK = { tabs: [{ index: 0, title: 'TikTok', url: 'https://www.tiktok.com/' }] };
const TABS_STARTING = { detail: 'Browser is still starting' };

test('页面通道没就绪 → foxPageReady 必须说 false（running 不算数）', async () => {
  const fox = await fakeFox((p) => (p.includes('/page/tabs') ? { status: 503, body: TABS_STARTING } : { body: TABS_OK }));
  try {
    assert.equal(await foxPageReady('TK06', fox.base), false);
    assert.equal(fox.count('/page/tabs'), 1);
  } finally {
    await fox.close();
  }
});

test('页面通道就绪 → foxPageReady 说 true', async () => {
  const fox = await fakeFox(() => ({ body: TABS_OK }));
  try {
    assert.equal(await foxPageReady('TK06', fox.base), true);
  } finally {
    await fox.close();
  }
});

test('launch 返回 202「still starting」但页面通道后来好了 → 等到就绪才算成功', async () => {
  let tabsHits = 0;
  const fox = await fakeFox((p, m) => {
    if (p.includes('/launch')) {
      // FoxProfile 等满 LAUNCH_TIMEOUT 后的真实形态：202 + success:true + still starting
      return { status: 202, body: { success: true, message: "Browser for 'TK06' is still starting" } };
    }
    if (p.includes('/page/tabs')) {
      tabsHits++;
      return tabsHits <= 2 ? { status: 503, body: TABS_STARTING } : { body: TABS_OK };
    }
    if (p === '/api/v1/browser' || p.endsWith('/browser')) return { body: { running: ['TK06'] } };
    return { body: {} };
  });
  try {
    const d = await launchAndWait('TK06', fox.base, { readySeconds: 5, pollMs: 20 });
    assert.equal(d.success, true, '页面通道好起来之后必须算成功');
    assert.ok(tabsHits >= 3, `应该轮询到通道就绪（实际 ${tabsHits} 次）`);
  } finally {
    await fox.close();
  }
});

test('页面通道一直不就绪 → 超时报失败（且文案说得清是"没就绪"不是"起不来"）', async () => {
  const fox = await fakeFox((p) => {
    if (p.includes('/launch')) return { status: 202, body: { success: true, message: 'still starting' } };
    if (p.includes('/page/tabs')) return { status: 503, body: TABS_STARTING };
    if (p.endsWith('/browser')) return { body: { running: ['TK11'] } };
    return { body: {} };
  });
  try {
    const t0 = Date.now();
    const d = await launchAndWait('TK11', fox.base, { readySeconds: 0.4, pollMs: 20 });
    assert.equal(d.success, false);
    assert.match(String(d.message), /没就绪/);
    assert.ok(Date.now() - t0 < 5000, '超时要真的收手，不能无限等');
  } finally {
    await fox.close();
  }
});

test('真失败（环境不存在/端口配错）立刻报，不许拿"等待"掩盖', async () => {
  const fox = await fakeFox((p) => {
    if (p.includes('/launch')) return { status: 502, body: { success: false, message: 'Launch failed: cannot start browser' } };
    return { body: {} };
  });
  try {
    const t0 = Date.now();
    const d = await launchAndWait('TK99', fox.base, { readySeconds: 30, pollMs: 20 });
    assert.equal(d.success, false);
    assert.match(String(d.message), /Launch failed/);
    assert.ok(Date.now() - t0 < 3000, '真失败不该触发等待循环');
    assert.equal(fox.count('/page/tabs'), 0, '真失败别再去探页面通道');
  } finally {
    await fox.close();
  }
});

test('进程在、控制通道一直不上来 → 自动清理（停环境 + 删 parent.lock）后重开，并最终就绪', async () => {
  const os = await import('node:os');
  const fsmod = await import('node:fs');
  const pathmod = await import('node:path');
  const dataDir = fsmod.mkdtempSync(pathmod.join(os.tmpdir(), 'foxdata-'));
  const envDir = pathmod.join(dataDir, 'TK02');
  fsmod.mkdirSync(envDir, { recursive: true });
  fsmod.writeFileSync(pathmod.join(envDir, 'parent.lock'), '');
  const oldData = process.env.FOXPROFILE_DATA;
  process.env.FOXPROFILE_DATA = dataDir;

  let stopped = false;
  let tabsHits = 0;
  const fox = await fakeFox((p, m) => {
    if (p.includes('/stop')) { stopped = true; return { body: { success: true } }; }
    if (p.includes('/launch')) return { status: 202, body: { success: true, message: 'still starting' } };
    if (p.includes('/page/tabs')) {
      // 清理之前永远 503；清理（stop）之后才真的就绪
      tabsHits++;
      return stopped ? { body: TABS_OK } : { status: 503, body: TABS_STARTING };
    }
    if (p.endsWith('/browser')) return { body: { running: stopped ? [] : ['TK02'] } };
    return { body: {} };
  });
  try {
    const d = await launchAndWait('TK02', fox.base, { readySeconds: 6, pollMs: 20, hardResetAfterMs: 150 });
    assert.equal(d.success, true, '清理之后必须重开成功');
    assert.equal(fox.count('/stop'), 1, '卡住的启动必须被 foxHardReset 停一次');
    assert.equal(fsmod.existsSync(pathmod.join(envDir, 'parent.lock')), false, 'parent.lock 必须被删掉');
  } finally {
    await fox.close();
    fsmod.rmSync(dataDir, { recursive: true, force: true });
    if (oldData === undefined) delete process.env.FOXPROFILE_DATA; else process.env.FOXPROFILE_DATA = oldData;
  }
});

test('启动本身超时（LAUNCH_FAILED + Timeout 180000ms）→ 清理后重开一次，别直接判死', async () => {
  const os = await import('node:os');
  const fsmod = await import('node:fs');
  const pathmod = await import('node:path');
  const dataDir = fsmod.mkdtempSync(pathmod.join(os.tmpdir(), 'foxdata-'));
  fsmod.mkdirSync(pathmod.join(dataDir, 'TK09'), { recursive: true });
  fsmod.writeFileSync(pathmod.join(dataDir, 'TK09', 'parent.lock'), '');
  const oldData = process.env.FOXPROFILE_DATA;
  process.env.FOXPROFILE_DATA = dataDir;

  let launchCalls = 0;
  const fox = await fakeFox((p) => {
    if (p.includes('/launch')) {
      launchCalls++;
      // 第一次复现 2026-10-30 20:18 TK09 的真实形态：耗满 180 秒后报超时
      return launchCalls === 1
        ? { status: 500, body: { success: false, message: 'LAUNCH_FAILED: TimeoutError: BrowserType.launch_persistent_context: Timeout 180000ms exceeded' } }
        : { body: { success: true, message: 'Browser started' } };
    }
    if (p.includes('/stop')) return { body: { success: true } };
    if (p.includes('/page/tabs')) return launchCalls === 1 ? { status: 503, body: TABS_STARTING } : { body: TABS_OK };
    if (p.endsWith('/browser')) return { body: { running: [] } };
    return { body: {} };
  });
  try {
    const d = await launchAndWait('TK09', fox.base, { readySeconds: 5, pollMs: 20, hardResetAfterMs: 100000 });
    assert.equal(d.success, true, '清理后第二次启动成功就该算成功');
    assert.equal(launchCalls, 2, '必须重开一次');
    assert.equal(fox.count('/stop'), 1, '重开前必须先停干净');
    assert.equal(fsmod.existsSync(pathmod.join(dataDir, 'TK09', 'parent.lock')), false, 'parent.lock 必须被删掉');
  } finally {
    await fox.close();
    fsmod.rmSync(dataDir, { recursive: true, force: true });
    if (oldData === undefined) delete process.env.FOXPROFILE_DATA; else process.env.FOXPROFILE_DATA = oldData;
  }
});
