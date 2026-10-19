/**
 * 打包脚本：先构建前端，再打包。
 *
 * 为什么不用 `"package": "npm run build && electron-builder"`：
 *   在本机（Windows + 实时防病毒）上，vite build 刚写完 dist 就立刻调用
 *   app-builder.exe，偶尔会撞上文件扫描占用，报
 *   ERR_ELECTRON_BUILDER_CANNOT_EXECUTE 直接失败 —— 每次都要手动重试。
 *   这里加一个短暂等待 + 自动重试，把这件事消化掉。
 *
 * 同时强制"先构建前端"：electron-builder 打的是 dist/ 里现成的产物，
 * 忘了 build 就会出现"引擎是新的、界面是旧的"（真实踩过：装的是 1.3.2，界面写 1.3.1）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: isWin,
    windowsHide: true,   // 项目硬规则：不弹 CMD 窗口
  });
  return r.status === 0;
}

const npx = isWin ? 'npx.cmd' : 'npx';

console.log('▶ 1/2 构建前端 (vite build)');
if (!run(npx, ['vite', 'build'])) {
  console.error('❌ 前端构建失败，已中止');
  process.exit(1);
}

// 给文件系统和杀毒软件一点时间收手
await sleep(3000);

const builderArgs = ['electron-builder', '--publish', 'never',
  '--config.electronDist=node_modules/electron/dist'];

for (let attempt = 1; attempt <= 3; attempt++) {
  console.log(`▶ 2/2 打包 (第 ${attempt} 次)`);
  if (run(npx, builderArgs)) {
    console.log('✅ 打包完成');
    process.exit(0);
  }
  if (attempt < 3) {
    console.log(`⏳ 打包失败（多为文件被占用），${attempt * 5} 秒后重试...`);
    await sleep(attempt * 5000);
  }
}

console.error(`❌ 打包连续 3 次失败，请检查 release/${path.sep} 目录是否被占用`);
process.exit(1);
