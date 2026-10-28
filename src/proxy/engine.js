/**
 * 内置代理内核（xray-core）的生命周期管理。
 *
 * 2026-10-28 用户口径：
 *   「最终这个软件要给到其它用户使用，用户都是小白……用户只有一个 vless:// 节点，该怎么使用呢」
 * → 安装包内置 xray.exe，用户只需粘节点；端口由本模块统一开好（1080–1109 各一条 socks），
 *   每个环境指向自己的那条，全自动。
 *
 * 取代的旧链路（只保留给命令行脚本兜底）：proxy_relay.py + SSH 隧道 + 软路由。
 * 这一层不依赖 Electron，dataDir / bin 路径全部由调用方传进来（方便单测）。
 */
import fs from 'fs-extra';
import net from 'net';
import path from 'path';
import tls from 'tls';
import { spawn } from 'child_process';
import { buildXrayConfig, DEFAULT_PORTS } from './xray-config.js';
import { parseProxyUri, describeNode } from './node.js';

let child = null;
let currentPorts = [];

export const ENGINE_PORTS = DEFAULT_PORTS;

export const nodeFile = (dataDir) => path.join(dataDir, 'data', 'proxy-node.json');
export const configFile = (dataDir) => path.join(dataDir, 'data', 'xray', 'config.json');
export const pidFile = (dataDir) => path.join(dataDir, 'data', 'xray', 'xray.pid');
export const logFile = (dataDir) => path.join(dataDir, 'logs', 'xray.log');

/**
 * 找 xray 可执行文件。优先安装包自带的（resources/bin/xray.exe），
 * 再退回本机常见位置 / PATH —— 开发机和打包环境都能跑起来。
 */
export function resolveXrayBin({ resourcesPath = '', devRoot = '' } = {}) {
  const cands = [];
  if (resourcesPath) {
    cands.push(path.join(resourcesPath, 'app.asar.unpacked', 'bin', 'xray.exe'));
    cands.push(path.join(resourcesPath, 'bin', 'xray.exe'));
  }
  if (devRoot) cands.push(path.join(devRoot, 'resources', 'bin', 'xray.exe'));
  if (process.env.XNOWPOST_XRAY) cands.push(process.env.XNOWPOST_XRAY);
  if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'xnowpost', 'bin', 'xray.exe'));
  cands.push('E:\\software\\xray\\xray.exe');
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (_) {
      /* 继续找 */
    }
  }
  return '';
}

export function readNode(dataDir) {
  try {
    const doc = fs.readJsonSync(nodeFile(dataDir));
    if (doc && doc.outbound) return doc;
    return null;
  } catch (_) {
    return null;
  }
}

/** 保存节点（原文一起留着，方便界面回显/改） */
export function saveNode(dataDir, { node, outbound, url }) {
  fs.ensureDirSync(path.dirname(nodeFile(dataDir)));
  fs.writeJsonSync(
    nodeFile(dataDir),
    { savedAt: new Date().toISOString(), node, outbound, url: String(url || '') },
    { spaces: 2 },
  );
  return nodeFile(dataDir);
}

export function clearNode(dataDir) {
  try {
    fs.removeSync(nodeFile(dataDir));
  } catch (_) {
    /* 忽略 */
  }
}

export function isRunning() {
  return !!(child && !child.killed && child.exitCode === null);
}

export function enginePid() {
  return isRunning() ? child.pid : 0;
}

function killStaleByPidFile(dataDir) {
  try {
    const pid = Number(fs.readFileSync(pidFile(dataDir), 'utf8').trim());
    if (pid > 0) {
      try {
        process.kill(pid, 0); // 还在 → 上一个实例没退干净
        process.kill(pid, 'SIGKILL');
      } catch (_) {
        /* 已经不在了 */
      }
    }
  } catch (_) {
    /* 没有 pid 文件 */
  }
  try {
    fs.removeSync(pidFile(dataDir));
  } catch (_) {
    /* 忽略 */
  }
}

/**
 * 起内核。重复调用是安全的（已在跑就直接返回）。
 * @returns {Promise<{ok:boolean, pid?:number, ports?:number[], message?:string}>}
 */
export async function startEngine({ dataDir, bin, ports = ENGINE_PORTS, outbound }) {
  if (isRunning()) return { ok: true, pid: child.pid, ports: currentPorts, message: '已在运行' };
  const exe = bin || resolveXrayBin({});
  if (!exe) return { ok: false, message: '找不到代理内核 xray.exe（安装包里丢了 resources/bin）' };

  const node = outbound || readNode(dataDir)?.outbound;
  if (!node) return { ok: false, message: '还没配置节点' };

  let doc;
  try {
    doc = buildXrayConfig({ outbound: node, ports });
  } catch (e) {
    return { ok: false, message: `生成配置失败：${e?.message || e}` };
  }

  const cfg = configFile(dataDir);
  fs.ensureDirSync(path.dirname(cfg));
  fs.ensureDirSync(path.dirname(logFile(dataDir)));
  fs.writeFileSync(cfg, JSON.stringify(doc, null, 2), 'utf8');

  // 日志只追加不清理会越滚越大（每次重启一行 + xray 自己的 warn），超过 5MB 就轮转一次
  try {
    const lf = logFile(dataDir);
    if (fs.existsSync(lf) && fs.statSync(lf).size > 5 * 1024 * 1024) {
      fs.moveSync(lf, `${lf}.1`, { overwrite: true });
    }
  } catch (_) {
    /* 轮转失败不影响启动 */
  }

  killStaleByPidFile(dataDir);

  // xray 自己会写日志；这里再兜一层 stdout/stderr（配置错时错误只在 stderr）
  const logStream = fs.createWriteStream(logFile(dataDir), { flags: 'a' });
  logStream.write(`\n===== ${new Date().toISOString()} 启动内核：${describeNode(readNode(dataDir)?.node)} =====\n`);

  const p = spawn(exe, ['run', '-c', cfg], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child = p;
  currentPorts = ports.slice();
  p.stdout.on('data', (b) => logStream.write(b));
  p.stderr.on('data', (b) => logStream.write(b));
  p.on('exit', (code, sig) => {
    logStream.write(`\n===== ${new Date().toISOString()} 内核退出 code=${code} sig=${sig} =====\n`);
    if (child === p) {
      child = null;
      currentPorts = [];
    }
  });
  try {
    fs.writeFileSync(pidFile(dataDir), String(p.pid), 'utf8');
  } catch (_) {
    /* 忽略 */
  }

  // 等端口真的起来（最多 15 秒），别让上层"以为起来了"其实还没监听
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!isRunning()) return { ok: false, message: '内核启动后立刻退出了，去「日志」页看 logs/xray.log' };
    if (await portListening(ports[0])) {
      return { ok: true, pid: p.pid, ports: currentPorts };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false, message: `内核起来了但 ${ports[0]} 端口没监听（配置可能有问题）` };
}

export async function stopEngine() {
  const p = child;
  if (!p) return { ok: true };
  try {
    p.kill('SIGTERM');
  } catch (_) {
    /* 忽略 */
  }
  // 给它 3 秒优雅退出，再强杀
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isRunning()) await new Promise((r) => setTimeout(r, 200));
  if (isRunning()) {
    try {
      p.kill('SIGKILL');
    } catch (_) {
      /* 忽略 */
    }
  }
  child = null;
  currentPorts = [];
  return { ok: true };
}

/** 重启（换节点、改端口后调用） */
export async function restartEngine({ dataDir, bin, ports = ENGINE_PORTS, outbound }) {
  await stopEngine();
  return startEngine({ dataDir, bin, ports, outbound });
}

export function portListening(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try {
        s.destroy();
      } catch (_) {
        /* 忽略 */
      }
      resolve(v);
    };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
  });
}

/**
 * 走本机 socks 端口实测出口 IP（走 TLS 到 api.ipify.org）。
 * 这是"节点到底能不能用"的唯一硬证据 —— 不看内核进程在不在，只看能不能出网。
 */
export function probeExitIp(port, { host = 'api.ipify.org', timeout = 12000 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    let done = false;
    const fin = (r) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch (_) {
        /* 忽略 */
      }
      resolve(r);
    };
    sock.setTimeout(timeout);
    sock.once('timeout', () => fin({ ok: false, error: `socks ${port} 超时` }));
    sock.once('error', (e) => fin({ ok: false, error: `socks ${port} 连不上：${e.message}` }));
    sock.once('connect', () => {
      // SOCKS5 无认证握手
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
      sock.once('data', (b) => {
        if (b[0] !== 0x05 || b[1] !== 0x00) return fin({ ok: false, error: 'socks 握手被拒绝' });
        const hostBuf = Buffer.from(host, 'utf8');
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          Buffer.from([0x01, 0xbb]), // 443
        ]);
        sock.write(req);
        sock.once('data', (r) => {
          if (r[1] !== 0x00) return fin({ ok: false, error: `socks CONNECT 失败（code ${r[1]}）` });
          // 换成 TLS，再发一条最小 HTTP 请求
          const t = tls.connect({ socket: sock, servername: host }, () => {
            t.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
          });
          let buf = '';
          t.setTimeout(timeout, () => fin({ ok: false, error: '出口响应超时' }));
          t.on('data', (d) => {
            buf += d.toString('utf8');
            if (buf.length > 8192) buf = buf.slice(0, 8192);
          });
          t.on('end', () => {
            const ip = (buf.match(/(\d{1,3}(?:\.\d{1,3}){3})/) || [])[1] || '';
            fin(ip ? { ok: true, ip } : { ok: false, error: '出口有响应但没读到 IP' });
          });
          t.on('error', (e) => fin({ ok: false, error: `TLS 失败：${e.message}` }));
        });
      });
    });
  });
}

/** 界面用的一句话状态 */
export async function status({ dataDir, bin }) {
  const saved = readNode(dataDir);
  const running = isRunning();
  const ports = running ? currentPorts : [];
  const first = ports[0] || ENGINE_PORTS[0];
  let probe = null;
  if (running && (await portListening(first))) {
    probe = await probeExitIp(first);
  }
  return {
    configured: !!saved,
    node: saved?.node || null,
    url: saved?.url || '',
    describe: saved?.node ? describeNode(saved.node) : '未配置',
    savedAt: saved?.savedAt || '',
    bin: bin || resolveXrayBin({}),
    running,
    pid: enginePid(),
    ports,
    exitIp: probe?.ok ? probe.ip : '',
    probeError: probe && !probe.ok ? probe.error : '',
    logFile: logFile(dataDir),
  };
}

/** 粘一条链接就用：解析 → 保存 → 重启内核 → 实测出口 */
export async function importNode({ dataDir, bin, url, ports = ENGINE_PORTS }) {
  const parsed = parseProxyUri(url);
  if (!parsed.ok) return { ok: false, message: parsed.error };
  saveNode(dataDir, { node: parsed.node, outbound: parsed.outbound, url });
  const r = await restartEngine({ dataDir, bin, ports, outbound: parsed.outbound });
  if (!r.ok) return { ok: false, message: r.message, node: parsed.node };
  const probe = await probeExitIp(ports[0]);
  return {
    ok: true,
    node: parsed.node,
    describe: describeNode(parsed.node),
    ports: r.ports || ports,
    exitIp: probe.ok ? probe.ip : '',
    probeError: probe.ok ? '' : probe.error,
  };
}

export default {
  ENGINE_PORTS,
  resolveXrayBin,
  readNode,
  saveNode,
  clearNode,
  startEngine,
  stopEngine,
  restartEngine,
  importNode,
  status,
  probeExitIp,
  portListening,
  enginePid,
  isRunning,
  nodeFile,
  configFile,
  logFile,
};
