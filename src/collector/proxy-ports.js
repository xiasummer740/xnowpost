/**
 * 新环境（TK11、TK12…）的**本地代理端口分配** —— 一条环境一条，按顺序递增。
 *
 * 为什么必须有这个：
 *   Camoufox/Firefox 不支持带认证的 SOCKS5，所以本机跑 `proxy_relay.py` 起一堆
 *   「无认证的本地 SOCKS5」，每条各自转给带认证的上游。老 10 个环境 = 1080–1089。
 *   新建环境如果照抄模板环境的代理，会出现 **TK11 和 TK01 共用 127.0.0.1:1080** ——
 *   两条隧道挤一个端口，一条挂了另一条跟着挂（用户 2026-10-24 明确否掉：
 *   「肯定不能共用一个端口呀，按顺序递增嘛」）。
 *
 * 规则：新环境拿「当前最大端口 + 1」，且不低于 `FIRST_PORT`（1090）。
 *   TK11 → 1090、TK12 → 1091 …（编号和端口各走各的，不用对齐）
 *
 * 配置在 `E:\software\FoxProfile\relay_config.10ports.json`（`instances[].listen`）。
 * 端口不在配置里时 `ensureRelayPort()` 会补一条并重启 relay —— 重启期间所有环境的隧道会断
 * 两三秒，所以只能在「没有浏览器窗口开着」的时候调用（新建环境那一步天然满足）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const FIRST_PORT = 1090;
export const RELAY_CONFIG =
  process.env.FOXPROFILE_RELAY_CONFIG || 'E:/software/FoxProfile/relay_config.10ports.json';
export const RELAY_PY =
  process.env.FOXPROFILE_RELAY_PY || 'E:/software/FoxProfile/.venv/Scripts/pythonw.exe';
export const RELAY_SCRIPT =
  process.env.FOXPROFILE_RELAY_SCRIPT || 'E:/software/FoxProfile/proxy_relay.py';

/** 从 relay 配置的 `listen`（形如 `127.0.0.1:1080`，没有 scheme）里取端口。 */
export function listenPort(s) {
  const m = String(s || '').trim().match(/^(?:127\.0\.0\.1|localhost|0\.0\.0\.0):(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** 从 `socks5://127.0.0.1:1080` 这类地址里取端口；不是本地中继就返回 null。 */
export function localRelayPort(proxy) {
  const s = String(proxy || '').trim();
  if (!s) return null;
  const m = s.match(/^socks5h?:\/\/(?:[^@/]*@)?(127\.0\.0\.1|localhost):(\d+)\/?$/i);
  return m ? Number(m[2]) : null;
}

/** 现有环境已经用掉的本地端口（升序去重）。 */
export function usedRelayPorts(profiles = []) {
  const set = new Set();
  for (const p of profiles) {
    const port = localRelayPort(p && p.proxy);
    if (port) set.add(port);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * 下一个该用的端口：`max(已用 ∪ {1089}) + 1`，保证顺序递增、不撞车。
 * 中间的空号不回收（用户口径是"按顺序递增"）。
 */
export function nextRelayPort(profiles = [], { first = FIRST_PORT, reservedMax = 1089 } = {}) {
  const used = usedRelayPorts(profiles);
  const top = Math.max(reservedMax, ...used);
  return Math.max(first, top + 1);
}

export function proxyUrl(port) {
  return `socks5://127.0.0.1:${port}`;
}

export function readRelayConfig(file = RELAY_CONFIG) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(doc.instances) ? doc.instances : [];
  const ports = list.map((i) => listenPort(i.listen)).filter(Boolean);
  return { doc, ports, upstream: (list[0] || {}).upstream || '' };
}

export function relayPorts(file = RELAY_CONFIG) {
  return readRelayConfig(file).ports.sort((a, b) => a - b);
}

/** 把某端口补进 relay 配置（照抄第一条的上游）。返回是否真的改了文件。 */
export function addRelayPort(port, file = RELAY_CONFIG) {
  const { doc, ports, upstream } = readRelayConfig(file);
  if (ports.includes(port)) return false;
  if (!upstream) throw new Error('relay 配置里没有可照抄的 upstream');
  doc.instances = Array.isArray(doc.instances) ? doc.instances : [];
  doc.instances.push({ listen: `127.0.0.1:${port}`, upstream });
  doc.instances.sort((a, b) => (listenPort(a.listen) || 0) - (listenPort(b.listen) || 0));
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return true;
}

/** 端口有没有在监听（只查监听表，不连它）。 */
export async function portListening(port) {
  const { execFileSync } = await import('node:child_process');
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count`],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    );
    return Number(String(out).trim()) > 0;
  } catch {
    return false;
  }
}

/**
 * 确保 relay 在该端口上监听。缺端口时补配置 + 重启 relay（**会短暂中断所有环境**）。
 * @returns {Promise<{port:number, added:boolean, ok:boolean}>}
 */
export async function ensureRelayPort(port, opts = {}) {
  const file = opts.configFile || RELAY_CONFIG;
  const added = addRelayPort(port, file);
  if (!added && (await portListening(port))) return { port, added: false, ok: true };

  const { spawn, execFileSync } = await import('node:child_process');
  // 1) 结束旧的 relay 进程（keepalive 看到端口掉下去本来也会重启，这里主动做，省最多 60 秒）
  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" | Where-Object { $_.CommandLine -like '*proxy_relay*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { windowsHide: true, timeout: 20000 },
    );
  } catch {
    /* 没有进程也无所谓 */
  }
  await new Promise((r) => setTimeout(r, 1200));

  // 2) 用新配置起 relay
  const child = spawn(RELAY_PY, [RELAY_SCRIPT, '--config', file], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.dirname(file),
  });
  child.unref();

  // 3) 等端口起来（最多 12 秒）
  for (let i = 0; i < 24; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (await portListening(port)) return { port, added, ok: true };
  }
  return { port, added, ok: false };
}
