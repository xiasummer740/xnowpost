/**
 * 代理节点解析：把用户粘贴的分享链接变成 xray 的 outbound。
 *
 * 为什么要这一层（2026-10-28 用户口径）：
 *   「最终这个软件要给到其它用户使用，用户都是小白……用户只有一个 vless:// 节点，该怎么使用」
 *   小白手里只有服务商给的一串链接，不可能去配软路由/SSH/relay。
 *   所以：粘链接 → 解析 → 开本地 socks 端口 → 每个环境一条，全自动。
 *
 * 支持：vless:// vmess:// trojan:// ss:// socks5:// http://（socks:// https:// 视同）
 * 所有解析都是纯函数，单测在 tests/unit/proxy-node.test.js。
 */

const SUPPORTED = ['vless', 'vmess', 'trojan', 'ss', 'socks5', 'socks', 'http', 'https'];

/** base64（标准或 URL-safe，可缺 padding）→ utf8 字符串 */
export function b64decode(s) {
  const t = String(s || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .trim();
  const pad = t.length % 4 === 0 ? '' : '='.repeat(4 - (t.length % 4));
  return Buffer.from(t + pad, 'base64').toString('utf8');
}

/** 解析 `a=1&b=2` 查询串（保留 %2F 这类编码解出来的值） */
export function parseQuery(q) {
  const out = {};
  for (const part of String(q || '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? '' : part.slice(i + 1);
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v);
    } catch (_) {
      out[k] = v;
    }
  }
  return out;
}

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());

/** vless:// vmess-host 之外的公共部分：host/port/userinfo 拆解 */
function splitHostPort(hostport) {
  const s = String(hostport || '');
  const m = s.match(/^\[([^\]]+)\]:(\d+)$/) || s.match(/^([^:]+):(\d+)$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (!(port > 0 && port < 65536)) return null;
  return { address: m[1], port };
}

/** 传输层（network）与安全层（security）统一映射成 xray streamSettings */
function streamSettings({ network, security, params, sniFallback, hostFallback }) {
  const net = String(network || 'tcp').toLowerCase();
  const sec = String(security || 'none').toLowerCase();
  const s = {
    network:
      net === 'ws'
        ? 'ws'
        : net === 'grpc'
          ? 'grpc'
          : net === 'h2' || net === 'http'
            ? 'http'
            : net === 'kcp' || net === 'mkcp'
              ? 'kcp'
              : 'tcp',
    security: sec === 'tls' ? 'tls' : sec === 'reality' ? 'reality' : sec === 'xtls' ? 'tls' : 'none',
  };

  const host = params.host || hostFallback || '';
  const path = params.path || params.serviceName || '/';
  if (s.network === 'ws') {
    s.wsSettings = { path, headers: host ? { Host: host } : {} };
  } else if (s.network === 'grpc') {
    s.grpcSettings = { serviceName: params.serviceName || params.path || '' };
  } else if (s.network === 'http') {
    s.httpSettings = { path, host: host ? host.split(',') : [] };
  } else if (s.network === 'kcp') {
    s.kcpSettings = { header: { type: params.headerType || params.type || 'none' } };
  }
  if (s.network === 'tcp' && params.headerType && params.headerType !== 'none') {
    s.tcpSettings = { header: { type: params.headerType } };
  }

  const sni = params.sni || params.peer || sniFallback || host || '';
  if (s.security === 'tls') {
    s.tlsSettings = {
      serverName: sni,
      fingerprint: params.fp || undefined,
      allowInsecure: truthy(params.allowInsecure) || truthy(params.insecure),
      alpn: params.alpn ? String(params.alpn).split(',') : undefined,
    };
  } else if (s.security === 'reality') {
    // REALITY 缺少公钥就没法用，宁可解析失败也不要生成一份"看起来能用其实是死的"配置
    if (!params.pbk) throw new Error('REALITY 节点缺少 pbk（公钥）');
    s.realitySettings = {
      serverName: sni || 'www.microsoft.com',
      fingerprint: params.fp || 'chrome',
      publicKey: params.pbk,
      shortId: params.sid || '',
      spiderX: params.spx || '/',
    };
  }
  return s;
}

function labelOf(params, remark) {
  const raw = params.ps || params.remark || params.remarks || '';
  if (raw) return decodeURIComponentSafe(raw);
  // 调用方传进来的 remark 已经是 `#` 后面那段（不用再 split）
  return decodeURIComponentSafe(remark || '');
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return String(s || '');
  }
}

function parseVless(url) {
  // vless://uuid@host:port?params#remark
  const body = url.slice('vless://'.length);
  const hashAt = body.indexOf('#');
  const remark = hashAt >= 0 ? body.slice(hashAt + 1) : '';
  const noHash = hashAt >= 0 ? body.slice(0, hashAt) : body;
  const qAt = noHash.indexOf('?');
  const head = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
  const params = parseQuery(qAt >= 0 ? noHash.slice(qAt + 1) : '');
  const at = head.lastIndexOf('@');
  if (at < 0) throw new Error('vless 链接里没有 @（缺 uuid 或地址）');
  const uuid = head.slice(0, at);
  const hp = splitHostPort(head.slice(at + 1));
  if (!hp) throw new Error('vless 链接的地址/端口看不懂');
  const outbound = {
    protocol: 'vless',
    settings: {
      vnext: [
        {
          address: hp.address,
          port: hp.port,
          users: [
            {
              id: uuid,
              encryption: params.encryption || 'none',
              flow: params.flow || undefined,
            },
          ],
        },
      ],
    },
    streamSettings: streamSettings({
      network: params.type || params.network,
      security: params.security,
      params,
    }),
  };
  return { outbound, node: { protocol: 'vless', address: hp.address, port: hp.port, label: labelOf(params, remark) } };
}

function parseVmess(url) {
  // vmess://base64(json)
  const json = b64decode(url.slice('vmess://'.length).split('#')[0]);
  let d;
  try {
    d = JSON.parse(json);
  } catch (e) {
    throw new Error('vmess 的 base64 不是合法 JSON');
  }
  const address = d.add;
  const port = Number(d.port);
  if (!address || !port) throw new Error('vmess 缺少地址或端口');
  const params = {
    sni: d.sni || d.host || '',
    fp: d.fp || '',
    host: d.host || '',
    path: d.path || '/',
    serviceName: d.path || '',
    headerType: d.type || 'none',
    alpn: d.alpn || '',
  };
  const outbound = {
    protocol: 'vmess',
    settings: {
      vnext: [
        {
          address,
          port,
          users: [
            {
              id: d.id,
              alterId: Number(d.aid || 0),
              security: d.scy || 'auto',
            },
          ],
        },
      ],
    },
    streamSettings: streamSettings({ network: d.net || 'tcp', security: d.tls === 'tls' ? 'tls' : 'none', params }),
  };
  return { outbound, node: { protocol: 'vmess', address, port, label: d.ps || '' } };
}

function parseTrojan(url) {
  const body = url.slice('trojan://'.length);
  const hashAt = body.indexOf('#');
  const remark = hashAt >= 0 ? body.slice(hashAt + 1) : '';
  const noHash = hashAt >= 0 ? body.slice(0, hashAt) : body;
  const qAt = noHash.indexOf('?');
  const head = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
  const params = parseQuery(qAt >= 0 ? noHash.slice(qAt + 1) : '');
  const at = head.lastIndexOf('@');
  if (at < 0) throw new Error('trojan 链接缺少 @（密码或地址）');
  const password = decodeURIComponentSafe(head.slice(0, at));
  const hp = splitHostPort(head.slice(at + 1));
  if (!hp) throw new Error('trojan 链接的地址/端口看不懂');
  const outbound = {
    protocol: 'trojan',
    settings: { servers: [{ address: hp.address, port: hp.port, password }] },
    streamSettings: streamSettings({ network: params.type || 'tcp', security: params.security || 'tls', params }),
  };
  return { outbound, node: { protocol: 'trojan', address: hp.address, port: hp.port, label: labelOf(params, remark) } };
}

function parseShadowsocks(url) {
  // ss://base64(method:password)@host:port#remark  或  ss://base64(method:password@host:port)#remark
  const body = url.slice('ss://'.length);
  const hashAt = body.indexOf('#');
  const remark = hashAt >= 0 ? body.slice(hashAt + 1) : '';
  let core = hashAt >= 0 ? body.slice(0, hashAt) : body;
  const qAt = core.indexOf('?');
  if (qAt >= 0) core = core.slice(0, qAt);
  let method = '';
  let password = '';
  let hp = null;
  const at = core.lastIndexOf('@');
  if (at >= 0) {
    const cred = b64decode(core.slice(0, at));
    const c = cred.split(':');
    method = c[0];
    password = c.slice(1).join(':');
    hp = splitHostPort(core.slice(at + 1));
  } else {
    const dec = b64decode(core);
    const at2 = dec.lastIndexOf('@');
    if (at2 < 0) throw new Error('ss 链接格式看不懂');
    const c = dec.slice(0, at2).split(':');
    method = c[0];
    password = c.slice(1).join(':');
    hp = splitHostPort(dec.slice(at2 + 1));
  }
  if (!hp || !method) throw new Error('ss 链接缺少加密方式或地址');
  const outbound = {
    protocol: 'shadowsocks',
    settings: {
      servers: [{ address: hp.address, port: hp.port, method, password }],
    },
  };
  return { outbound, node: { protocol: 'ss', address: hp.address, port: hp.port, label: decodeURIComponentSafe(remark) } };
}

function parseSocksHttp(url, protocol) {
  const body = url.slice(protocol.length + 3); // scheme://
  const hashAt = body.indexOf('#');
  const remark = hashAt >= 0 ? body.slice(hashAt + 1) : '';
  const noHash = hashAt >= 0 ? body.slice(0, hashAt) : body;
  const qAt = noHash.indexOf('?');
  const head = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
  const at = head.lastIndexOf('@');
  let user = '';
  let pass = '';
  if (at >= 0) {
    const cred = head.slice(0, at);
    const ci = cred.indexOf(':');
    user = decodeURIComponentSafe(ci < 0 ? cred : cred.slice(0, ci));
    pass = ci < 0 ? '' : decodeURIComponentSafe(cred.slice(ci + 1));
  }
  const hp = splitHostPort(at >= 0 ? head.slice(at + 1) : head);
  if (!hp) throw new Error(`${protocol} 链接的地址/端口看不懂`);
  const real = protocol === 'socks' ? 'socks' : protocol;
  const outbound =
    protocol === 'http' || protocol === 'https'
      ? {
          protocol: 'http',
          settings: {
            servers: [
              { address: hp.address, port: hp.port, ...(user ? { users: [{ user, pass }] } : {}) },
            ],
          },
        }
      : {
          protocol: 'socks',
          settings: {
            servers: [
              { address: hp.address, port: hp.port, ...(user ? { users: [{ user, pass }] } : {}) },
            ],
          },
        };
  return {
    outbound,
    node: { protocol: real === 'socks' ? 'socks5' : real, address: hp.address, port: hp.port, label: decodeURIComponentSafe(remark) },
  };
}

/**
 * 解析一条分享链接。
 * @returns {{ok:boolean, node?:object, outbound?:object, error?:string}}
 */
export function parseProxyUri(input) {
  const text = String(input || '').trim();
  if (!text) return { ok: false, error: '节点是空的' };
  const m = text.match(/^([a-z0-9]+):\/\//i);
  if (!m) return { ok: false, error: '这不是一条分享链接（应以 vless:// vmess:// trojan:// ss:// socks5:// 开头）' };
  const scheme = m[1].toLowerCase();
  if (!SUPPORTED.includes(scheme)) return { ok: false, error: `暂不支持 ${scheme}://（支持 ${SUPPORTED.join(' / ')}）` };
  try {
    let r;
    if (scheme === 'vless') r = parseVless(text);
    else if (scheme === 'vmess') r = parseVmess(text);
    else if (scheme === 'trojan') r = parseTrojan(text);
    else if (scheme === 'ss') r = parseShadowsocks(text);
    else r = parseSocksHttp(text, scheme);
    r.outbound.tag = 'proxy';
    // 本机 socks 入口不允许再走 socks（自己转发自己会打转），明确挡掉
    if (
      ['socks5', 'socks', 'http', 'https'].includes(scheme) &&
      /^(127\.0\.0\.1|localhost|0\.0\.0\.0)$/i.test(r.node.address)
    ) {
      return { ok: false, error: '节点指向本机（127.0.0.1），不能自己转发自己' };
    }
    return { ok: true, node: r.node, outbound: r.outbound };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** 一眼能看懂的节点描述（界面用）：`vless · node.example.com:21666 · US-home` */
export function describeNode(node) {
  if (!node) return '未配置';
  const proto = node.protocol || '?';
  const host = `${node.address || '?'}:${node.port || '?'}`;
  return [proto, host, node.label].filter(Boolean).join(' · ');
}

export default { parseProxyUri, describeNode, b64decode, parseQuery };
