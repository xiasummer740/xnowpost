// 临时验证脚本（不入库）：用内置内核跑用户那条 vless 节点，端口用 21080+，不碰真机 1080–1109
import fs from 'fs-extra';
import path from 'path';
import * as engine from '../src/proxy/engine.js';
import { parseProxyUri, describeNode } from '../src/proxy/node.js';

const URL_VLESS = process.argv[2];
if (!URL_VLESS) {
  console.error('用法：node scripts/_probe-engine.mjs "<vless链接>"');
  process.exit(2);
}
const dataDir = path.resolve('output/_engine-test');
fs.ensureDirSync(dataDir);

const parsed = parseProxyUri(URL_VLESS);
console.log('解析：', parsed.ok ? describeNode(parsed.node) : '❌ ' + parsed.error);
if (!parsed.ok) process.exit(1);

const ports = [21080, 21081, 21082];
const r = await engine.startEngine({
  dataDir,
  bin: engine.resolveXrayBin({ devRoot: path.resolve('.') }),
  ports,
  outbound: parsed.outbound,
});
console.log('启动：', JSON.stringify(r));
if (!r.ok) process.exit(1);

for (const p of ports) {
  const probe = await engine.probeExitIp(p);
  console.log(`  端口 ${p}:`, probe.ok ? `出口 ${probe.ip}` : `❌ ${probe.error}`);
}

// 换一个不可达端口，确认"不通"能被如实报出来（别把不通说成通）
const bad = await engine.probeExitIp(21089);
console.log('  对照（没开的端口 21089）：', bad.ok ? `⚠️ 竟然通了 ${bad.ip}` : `✅ 如实报错：${bad.error}`);

await engine.stopEngine();
console.log('已停止内核');
