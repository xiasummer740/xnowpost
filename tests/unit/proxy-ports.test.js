import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  localRelayPort,
  usedRelayPorts,
  nextRelayPort,
  proxyUrl,
  readRelayConfig,
  relayPorts,
  addRelayPort,
  FIRST_PORT,
} from '../../src/collector/proxy-ports.js';

const env = (n) => ({ name: `TK${n}`, proxy: `socks5://127.0.0.1:${1079 + n}` });

test('localRelayPort 认本地中继，认不出就返回 null', () => {
  assert.equal(localRelayPort('socks5://127.0.0.1:1080'), 1080);
  assert.equal(localRelayPort('socks5://localhost:1091/'), 1091);
  assert.equal(localRelayPort('socks5://user:pass@127.0.0.1:1092'), 1092);
  assert.equal(localRelayPort('socks5://node.example.com:26219'), null);
  assert.equal(localRelayPort(''), null);
  assert.equal(localRelayPort(null), null);
});

test('usedRelayPorts 只统计本地中继端口并升序去重', () => {
  const ports = usedRelayPorts([
    { proxy: 'socks5://127.0.0.1:1081' },
    { proxy: 'socks5://127.0.0.1:1080' },
    { proxy: 'socks5://127.0.0.1:1081' },
    { proxy: 'socks5://node.example.com:26219' },
    { proxy: '' },
    {},
  ]);
  assert.deepEqual(ports, [1080, 1081]);
});

test('nextRelayPort：10 个老环境 → 1090（第一条新环境）', () => {
  const profiles = Array.from({ length: 10 }, (_, i) => env(i + 1)); // 1080..1089
  assert.equal(nextRelayPort(profiles), FIRST_PORT);
});

test('nextRelayPort：接到 1090 后下一个是 1091（顺序递增，不共用）', () => {
  const profiles = [...Array.from({ length: 10 }, (_, i) => env(i + 1)), { proxy: proxyUrl(1090) }];
  assert.equal(nextRelayPort(profiles), 1091);
});

test('nextRelayPort：中间有空号也不回收，只在最大值上加一', () => {
  const profiles = [{ proxy: proxyUrl(1080) }, { proxy: proxyUrl(1095) }];
  assert.equal(nextRelayPort(profiles), 1096);
});

test('nextRelayPort：一个环境都没有 → 也从 1090 起（1080-1089 是老的保留段）', () => {
  assert.equal(nextRelayPort([]), FIRST_PORT);
  assert.equal(nextRelayPort([{ proxy: '' }]), FIRST_PORT);
});

test('proxyUrl 生成 Camoufox 能吃的无认证 socks5 地址', () => {
  assert.equal(proxyUrl(1090), 'socks5://127.0.0.1:1090');
});

test('addRelayPort / readRelayConfig：补端口用第一条的 upstream，且按端口排序不重复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const file = path.join(dir, 'relay.json');
  fs.writeFileSync(file, JSON.stringify({
    instances: [
      { listen: '127.0.0.1:1081', upstream: 'socks5://u:p@host:1' },
      { listen: '127.0.0.1:1080', upstream: 'socks5://u:p@host:1' },
    ],
  }), 'utf8');

  assert.deepEqual(relayPorts(file), [1080, 1081]);
  assert.equal(readRelayConfig(file).upstream, 'socks5://u:p@host:1');

  assert.equal(addRelayPort(1090, file), true);
  const after = readRelayConfig(file);
  assert.deepEqual(after.ports.sort((a, b) => a - b), [1080, 1081, 1090]);
  assert.equal(after.doc.instances[2].upstream, 'socks5://u:p@host:1');

  // 已经有了就不动文件
  assert.equal(addRelayPort(1090, file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
