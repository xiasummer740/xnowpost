import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProxyUri, describeNode, b64decode, parseQuery } from '../../src/proxy/node.js';

const VLESS_REALITY =
  'vless://11111111-2222-3333-4444-555555555555@node.example.com:21666' +
  '?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.icloud.com&fp=chrome' +
  '&pbk=kQ3Zr8pQ1n2sT5vW7yB4cD6eF8gH0jL2mN4oP6qR8sU&sid=0a1b2c3d4e5f6071&spx=%2F&type=tcp&headerType=none' +
  '#US-demo-21666';

test('真实 vless(REALITY) 链接：settings 与 streamSettings 全部对得上', () => {
  const r = parseProxyUri(VLESS_REALITY);
  assert.equal(r.ok, true, r.error);
  const o = r.outbound;
  assert.equal(o.protocol, 'vless');
  assert.equal(o.tag, 'proxy');
  const v = o.settings.vnext[0];
  assert.equal(v.address, 'node.example.com');
  assert.equal(v.port, 21666);
  assert.equal(v.users[0].id, '11111111-2222-3333-4444-555555555555');
  assert.equal(v.users[0].flow, 'xtls-rprx-vision');
  assert.equal(v.users[0].encryption, 'none');
  assert.equal(o.streamSettings.network, 'tcp');
  assert.equal(o.streamSettings.security, 'reality');
  const rs = o.streamSettings.realitySettings;
  assert.equal(rs.serverName, 'www.icloud.com');
  assert.equal(rs.fingerprint, 'chrome');
  assert.equal(rs.publicKey, 'kQ3Zr8pQ1n2sT5vW7yB4cD6eF8gH0jL2mN4oP6qR8sU');
  assert.equal(rs.shortId, '0a1b2c3d4e5f6071');
  assert.equal(rs.spiderX, '/');
  // 备注（#后面的）要解出来给界面看
  assert.match(r.node.label, /US-demo/);
  assert.equal(r.node.address, 'node.example.com');
  assert.equal(r.node.port, 21666);
});

test('REALITY 缺公钥要明确失败，不能生成一份"看着能用其实是死的"配置', () => {
  const bad = VLESS_REALITY.replace('&pbk=kQ3Zr8pQ1n2sT5vW7yB4cD6eF8gH0jL2mN4oP6qR8sU', '');
  const r = parseProxyUri(bad);
  assert.equal(r.ok, false);
  assert.match(r.error, /pbk/);
});

test('空输入 / 不认识的协议 / 没有 @ 都要有中文提示', () => {
  assert.equal(parseProxyUri('').ok, false);
  assert.match(parseProxyUri('').error, /空/);
  assert.equal(parseProxyUri('hello world').ok, false);
  assert.match(parseProxyUri('hello world').error, /分享链接/);
  assert.match(parseProxyUri('hysteria2://a@b:1').error, /暂不支持/);
  assert.match(parseProxyUri('vless://11111111-2222-3333-4444-555555555555').error, /@/);
});

test('指向本机的 socks 节点要挡掉（否则自己转发自己）', () => {
  const r = parseProxyUri('socks5://127.0.0.1:1080');
  assert.equal(r.ok, false);
  assert.match(r.error, /自己转发自己/);
});

test('ws + tls 的 vless 能正确生成 wsSettings/tlsSettings', () => {
  const url =
    'vless://11111111-2222-3333-4444-555555555555@example.com:443' +
    '?encryption=none&security=tls&sni=cdn.example.com&type=ws&host=cdn.example.com&path=%2Fws&fp=chrome';
  const r = parseProxyUri(url);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.outbound.streamSettings.network, 'ws');
  assert.equal(r.outbound.streamSettings.wsSettings.path, '/ws');
  assert.equal(r.outbound.streamSettings.wsSettings.headers.Host, 'cdn.example.com');
  assert.equal(r.outbound.streamSettings.tlsSettings.serverName, 'cdn.example.com');
});

test('trojan 链接：密码解出来、默认 tls', () => {
  const r = parseProxyUri('trojan://p%40ss@t.example.com:8443?sni=t.example.com&type=tcp#tokyo');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.outbound.settings.servers[0].password, 'p@ss');
  assert.equal(r.outbound.streamSettings.security, 'tls');
  assert.equal(r.node.label, 'tokyo');
});

test('ss 链接（base64 凭据）能解析出 method/password', () => {
  const cred = Buffer.from('aes-256-gcm:secret123').toString('base64');
  const r = parseProxyUri(`ss://${cred}@1.2.3.4:8388#node1`);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.outbound.protocol, 'shadowsocks');
  assert.equal(r.outbound.settings.servers[0].method, 'aes-256-gcm');
  assert.equal(r.outbound.settings.servers[0].password, 'secret123');
});

test('vmess 链接（base64 JSON）能解析', () => {
  const doc = { v: '2', ps: 'vm', add: 'v.example.com', port: '8080', id: 'abc-uuid', aid: '0', scy: 'auto', net: 'ws', host: 'v.example.com', path: '/ray', tls: 'tls' };
  const b64 = Buffer.from(JSON.stringify(doc)).toString('base64');
  const r = parseProxyUri(`vmess://${b64}`);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.outbound.settings.vnext[0].address, 'v.example.com');
  assert.equal(r.outbound.settings.vnext[0].port, 8080);
  assert.equal(r.outbound.streamSettings.network, 'ws');
  assert.equal(r.outbound.streamSettings.tlsSettings.serverName, 'v.example.com');
});

test('b64decode / parseQuery 容错（URL-safe、缺 padding、编码）', () => {
  assert.equal(b64decode('YQ'), 'a');
  const q = parseQuery('spx=%2F&sni=a.b&x');
  assert.equal(q.spx, '/');
  assert.equal(q.sni, 'a.b');
  assert.equal(q.x, '');
});

test('describeNode 给人看的一句话', () => {
  assert.equal(describeNode(null), '未配置');
  assert.match(describeNode({ protocol: 'vless', address: 'a.com', port: 443, label: 'X' }), /vless · a\.com:443 · X/);
});
