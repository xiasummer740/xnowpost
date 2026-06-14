// 自动查找系统工具路径（换电脑不需要改代码）
import fs from 'fs-extra';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';

export function findFFmpeg() {
  // 1. 先找常见安装位置
  const winPaths = [
    path.join(os.homedir(), 'AppData/Local/Microsoft/WinGet/Packages'),
    'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
    'C:/ffmpeg/bin/ffmpeg.exe',
  ];

  // 扫描 winget 安装目录
  try {
    const wingetDir = winPaths[0];
    if (fs.existsSync(wingetDir)) {
      const dirs = fs.readdirSync(wingetDir);
      for (const d of dirs) {
        if (d.toLowerCase().includes('ffmpeg')) {
          const full = path.join(wingetDir, d);
          const subs = fs.readdirSync(full);
          for (const s of subs) {
            const exe = path.join(full, s, 'bin', 'ffmpeg.exe');
            if (fs.existsSync(exe)) return exe.replace(/\\/g, '/');
          }
        }
      }
    }
  } catch (e) { /* ignore */ }

  // 2. 检查固定路径
  for (const p of winPaths.slice(1)) {
    if (fs.existsSync(p)) return p.replace(/\\/g, '/');
  }

  // 3. 尝试 PATH 查找
  try {
    const result = execSync('where ffmpeg', { encoding: 'utf-8', stdio: ['pipe','pipe','ignore'] });
    const lines = result.trim().split('\n');
    if (lines[0] && fs.existsSync(lines[0].trim())) return lines[0].trim().replace(/\\/g, '/');
  } catch (e) { /* ignore */ }

  return 'ffmpeg'; // fallback
}

export function findEdgeTTS() {
  // 1. 扫描 Python Scripts 目录
  const pythonDirs = [
    path.join(os.homedir(), 'AppData/Local/Programs/Python'),
    path.join(os.homedir(), 'AppData/Roaming/Python'),
    'C:/Python',
  ];

  try {
    for (const base of pythonDirs) {
      if (!fs.existsSync(base)) continue;
      const versions = fs.readdirSync(base);
      for (const v of versions) {
        const exe = path.join(base, v, 'Scripts', 'edge-tts.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch (e) { /* ignore */ }

  // 2. PATH 查找
  try {
    const result = execSync('where edge-tts', { encoding: 'utf-8', stdio: ['pipe','pipe','ignore'] });
    const lines = result.trim().split('\n');
    if (lines[0] && fs.existsSync(lines[0].trim())) return lines[0].trim();
  } catch (e) { /* ignore */ }

  return 'edge-tts'; // fallback
}
