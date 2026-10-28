import test from 'node:test';
import assert from 'node:assert/strict';
import { buildXrayConfig, DEFAULT_PORTS, PRIVATE_CIDRS } from '../../src/proxy/xray-config.js';

const outbound = {
  protocol: 'vless',
  tag: 'proxy',
  settings: { vnext: [{ address: 'a.com', port: 443, users: [{ id: 'u', encryption: 'none' }] }] },
  streamSettings: { network: 'tcp', security: 'none' },
};

test('默认开 30 条 socks 入口（1080–1109），每个环境一条', () => {
  const c = buildXrayConfig({ outbound });
  assert.equal(c.inbounds.length, 30);
  assert.equal(c.inbounds[0].port, 1080);
  assert.equal(c.inbounds[29].port, 1109);
  assert.deepEqual(
    c.inbounds.map((i) => i.port),
    DEFAULT_PORTS,
  );
  for (const i of c.inbounds) {
    assert.equal(i.protocol, 'socks');
    assert.equal(i.listen, '127.0.0.1');
    assert.equal(i.settings.auth, 'noauth');
    // UDP 关掉：Camoufox 走 TCP，开 UDP 只会让问题更难查
    assert.equal(i.settings.udp, false);
    assert.match(i.tag, /^socks-\d+$/);
  }
});

test('节点在 outbounds[0] 且 tag 固定 proxy，另有 direct/block 兜底', () => {
  const c = buildXrayConfig({ outbound });
  assert.equal(c.outbounds[0].protocol, 'vless');
  assert.equal(c.outbounds[0].tag, 'proxy');
  const tags = c.outbounds.map((o) => o.tag);
  assert.deepEqual(tags, ['proxy', 'direct', 'block']);
});

test('内网直连，其余走节点（不依赖 geoip.dat）', () => {
  const c = buildXrayConfig({ outbound });
  const [privateRule, fallback] = c.routing.rules;
  assert.deepEqual(privateRule.ip, PRIVATE_CIDRS);
  assert.equal(privateRule.outboundTag, 'direct');
  assert.equal(fallback.outboundTag, 'proxy');
  // 明确不许出现 geoip: 依赖，否则没带 geoip.dat 的安装包会起不来
  assert.ok(!JSON.stringify(c).includes('geoip:'));
});

test('端口清单可以由调用方指定，非法端口被丢掉', () => {
  const c = buildXrayConfig({ outbound, ports: [21080, 0, 70000, '21081'] });
  assert.deepEqual(
    c.inbounds.map((i) => i.port),
    [21080, 21081],
  );
});

test('没有节点 / 没有端口都明确报错', () => {
  assert.throws(() => buildXrayConfig({}), /outbound/);
  assert.throws(() => buildXrayConfig({ outbound, ports: [] }), /端口/);
});

test('原始 outbound 不被就地改写（tag 由 config 决定）', () => {
  const src = { ...outbound, tag: 'whatever' };
  const c = buildXrayConfig({ outbound: src });
  assert.equal(c.outbounds[0].tag, 'proxy');
  assert.equal(src.tag, 'whatever');
});
