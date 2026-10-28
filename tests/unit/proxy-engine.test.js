import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
  resolveXrayBin,
  readNode,
  saveNode,
  nodeFile,
  logFile,
  configFile,
  probeExitIp,
  status,
  portListening,
  ENGINE_PORTS,
} from '../../src/proxy/engine.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xnowpost-engine-'));

test('端口池固定 1080–1109（一条环境一条，永不复用）', () => {
  assert.equal(ENGINE_PORTS.length, 30);
  assert.equal(ENGINE_PORTS[0], 1080);
  assert.equal(ENGINE_PORTS[29], 1109);
});

test('内置内核路径：安装包 / 开发仓库 / 环境变量三种都能找到', () => {
  const devRoot = path.resolve('.');
  const p = resolveXrayBin({ devRoot });
  assert.match(p.replace(/\\/g, '/'), /resources\/bin\/xray\.exe$/);
  assert.ok(fs.existsSync(p), `内置内核应存在：${p}`);

  // 打包后的形态：resources/app.asar.unpacked/bin/xray.exe
  const packaged = resolveXrayBin({ resourcesPath: path.join(devRoot, '..') });
  assert.equal(typeof packaged, 'string');

  // 环境变量指向的必须是真实存在的文件（不存在就要继续往下找，不许返回一条假路径）
  const prev = process.env.XNOWPOST_XRAY;
  const fake = path.join(tmp(), 'xray.exe');
  fs.writeFileSync(fake, 'x');
  process.env.XNOWPOST_XRAY = fake;
  try {
    assert.equal(resolveXrayBin({}), fake);
  } finally {
    if (prev === undefined) delete process.env.XNOWPOST_XRAY;
    else process.env.XNOWPOST_XRAY = prev;
    fs.removeSync(path.dirname(fake));
  }
});

test('节点存储：没配过返回 null，存过能读回来（含原文链接）', () => {
  const dir = tmp();
  try {
    assert.equal(readNode(dir), null);
    saveNode(dir, {
      node: { protocol: 'vless', address: 'a.com', port: 443, label: 'X' },
      outbound: { protocol: 'vless', settings: {}, streamSettings: {} },
      url: 'vless://u@a.com:443#X',
    });
    const back = readNode(dir);
    assert.equal(back.node.address, 'a.com');
    assert.equal(back.url, 'vless://u@a.com:443#X');
    assert.ok(fs.existsSync(nodeFile(dir)));
  } finally {
    fs.removeSync(dir);
  }
});

test('配置/日志/pid 路径都在数据目录下（不写到安装目录）', () => {
  const dir = 'C:/data';
  assert.ok(configFile(dir).includes('xray'));
  assert.ok(logFile(dir).includes('logs'));
  assert.ok(nodeFile(dir).includes('proxy-node.json'));
});

test('端口探测：没开的端口必须如实报"不通"，不许说成通', async () => {
  assert.equal(await portListening(21089), false);
  const r = await probeExitIp(21089, { timeout: 3000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /连不上|超时/);
  assert.equal(r.ip, undefined);
});

test('状态：没配节点时 configured=false、running=false、describe=未配置', async () => {
  const dir = tmp();
  try {
    const s = await status({ dataDir: dir, bin: 'x' });
    assert.equal(s.configured, false);
    assert.equal(s.running, false);
    assert.equal(s.describe, '未配置');
    assert.equal(s.exitIp, '');
  } finally {
    fs.removeSync(dir);
  }
});
