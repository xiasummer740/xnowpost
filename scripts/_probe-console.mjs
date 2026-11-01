// 一次性排查脚本：连 Electron 的 CDP，重载页面，抓渲染进程的报错
// 用法：先 XNOWPost.exe --remote-debugging-port=9223，再 node scripts/_probe-console.mjs
const PORT = process.argv[2] || '9223';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /index\.html|localhost|file:/.test(t.url)) || list.find((t) => t.type === 'page');
if (!page) {
  console.log('没有找到页面目标：', list.map((t) => `${t.type} ${t.url}`).join('\n'));
  process.exit(1);
}
console.log('目标:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => new Promise((resolve) => {
  const myId = ++id;
  const onMsg = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === myId) {
      ws.removeEventListener('message', onMsg);
      resolve(m);
    }
  };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id: myId, method, params }));
});

const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(`[console.${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    logs.push('[exception] ' + (d.exception?.description || d.text));
  }
});

await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, 6000));

const probe = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    href: location.href,
    bodyLen: document.body.innerText.length,
    appHtml: (document.querySelector('#app') || {}).innerHTML ? document.querySelector('#app').innerHTML.length : 0,
    text: document.body.innerText.slice(0, 200)
  })`,
  returnByValue: true,
});

console.log('页面状态:', probe.result?.result?.value);
console.log('--- 控制台/异常 ---');
console.log(logs.length ? logs.join('\n') : '（没有输出）');
ws.close();
