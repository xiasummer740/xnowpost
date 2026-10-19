// 自动查找系统工具路径（换电脑不需要改代码）
//
// 设计要点：
//  1. 查找顺序：winget 包目录 → 常见安装目录 → ffmpeg 同目录 → PATH
//  2. findFFprobe 不再用正则从 ffmpeg 路径推导（那条路径在回退时会静默失效，
//     导致每段配音都被当成 5 秒、字幕与画面错位且不报错）
//  3. 找不到时返回裸命令名，由 verifyMediaTools() 统一报错，
//     避免在 import 阶段直接抛异常导致堆栈难读
import fs from 'fs-extra';
import { spawnSync } from 'child_process';
import path from 'path';
import os from 'os';

function wingetPackagesDir() {
  return path.join(os.homedir(), 'AppData/Local/Microsoft/WinGet/Packages');
}

/** 在 winget 包目录里枚举 <pkg>/<ver>/bin/<exe> 之类的候选路径 */
function wingetExeCandidates(exeName) {
  const out = [];
  try {
    const base = wingetPackagesDir();
    if (!fs.existsSync(base)) return out;
    for (const d of fs.readdirSync(base)) {
      // ffmpeg 与 ffprobe 同属 ffmpeg 包，包名里含 "ffmpeg"
      if (!/ffmpeg/i.test(d) && !/ffprobe/i.test(d)) continue;
      const full = path.join(base, d);
      let subs = [];
      try {
        subs = fs.readdirSync(full);
      } catch (_) {
        continue;
      }
      for (const s of subs) {
        out.push(path.join(full, s, 'bin', exeName));
        out.push(path.join(full, s, exeName));
        out.push(path.join(full, exeName));
      }
      out.push(path.join(full, 'bin', exeName));
    }
  } catch (_) {
    /* ignore */
  }
  return out;
}

function firstExisting(candidates) {
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c.replace(/\\/g, '/');
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

/** PATH 查找；找不到时返回裸命令名（由 verifyMediaTools 负责报错） */
function fromPath(name) {
  try {
    const r = execSync(`where ${name}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const line = r.trim().split(/\r?\n/)[0];
    if (line && fs.existsSync(line.trim())) return line.trim().replace(/\\/g, '/');
  } catch (_) {
    /* ignore */
  }
  return name;
}

export function findFFmpeg() {
  const hit = firstExisting([
    ...wingetExeCandidates('ffmpeg.exe'),
    'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
    'C:/ffmpeg/bin/ffmpeg.exe',
  ]);
  return hit || fromPath('ffmpeg');
}

export function findFFprobe() {
  // 1) 优先取 ffmpeg 同目录（winget / 手动解压都是这个布局）
  const ff = findFFmpeg();
  if (ff && path.isAbsolute(ff)) {
    const sibling = path.join(path.dirname(ff), 'ffprobe.exe');
    if (fs.existsSync(sibling)) return sibling.replace(/\\/g, '/');
  }

  // 2) winget / 常见安装目录
  const hit = firstExisting([
    ...wingetExeCandidates('ffprobe.exe'),
    'C:/Program Files/ffmpeg/bin/ffprobe.exe',
    'C:/ffmpeg/bin/ffprobe.exe',
  ]);
  if (hit) return hit;

  // 3) PATH
  return fromPath('ffprobe');
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
  } catch (_) {
    /* ignore */
  }

  // 2. PATH 查找
  return fromPath('edge-tts');
}

/** 实际执行一次版本命令，确认「找得到」且「跑得起来」 */
export function verifyTool(exePath, versionFlag = '-version') {
  try {
    // 用 spawnSync + argv 数组，不再拼 shell 字符串（P1-7）：
    // 路径里带 & 或空格时，拼字符串会被 cmd 当成命令分隔符
    const r = spawnSync(exePath, [versionFlag], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
      encoding: 'utf-8',
      windowsHide: true,
    });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`退出码 ${r.status}`);
    return { ok: true, version: String(r.stdout || '').split('\n')[0].trim() };
  } catch (e) {
    return { ok: false, error: (e.message || String(e)).split('\n')[0] };
  }
}

/**
 * 真实合成一句话，验证 edge-tts **到底能不能用**。
 *
 * 只查 `--version` 等于没查：微软轮换语音接口令牌后，旧客户端版本号照常打印，
 * 真去合成却直接 403（实测 edge-tts 7.2.7，升到 7.3.1 才恢复）。
 * 这个探测只花几百毫秒、完全免费，但能挡住"烧完 9 张图才发现配音坏了"。
 */
export function probeEdgeTTS(exePath, timeoutMs = 25000) {
  const probeFile = path.join(os.tmpdir(), `xnowpost-tts-probe-${process.pid}.mp3`);
  try {
    const r = spawnSync(exePath, [
      '--voice', 'zh-CN-XiaoxiaoNeural',
      '--text', '测试',
      '--write-media', probeFile,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      encoding: 'utf-8',
      windowsHide: true,
    });
    if (r.error) throw r.error;
    const size = fs.existsSync(probeFile) ? fs.statSync(probeFile).size : 0;
    if (size <= 0) {
      const detail = String(r.stderr || '')
        .split('\n').map(l => l.trim()).filter(Boolean).pop() || `退出码 ${r.status}`;
      throw new Error(`无法合成语音（${detail.substring(0, 160)}）`);
    }
    return { ok: true, bytes: size };
  } catch (e) {
    return { ok: false, error: (e.message || String(e)).split('\n')[0] };
  } finally {
    try { fs.removeSync(probeFile); } catch (_) { /* 清理失败不影响结果 */ }
  }
}

/** 三项外部依赖的整体体检结果（供启动预检 / 环境检查复用） */
export function verifyMediaTools() {
  const ffmpeg = findFFmpeg();
  const ffprobe = findFFprobe();
  const edgeTts = findEdgeTTS();
  const edgeTtsInfo = { path: edgeTts, ...verifyTool(edgeTts, '--version') };
  return {
    ffmpeg: { path: ffmpeg, ...verifyTool(ffmpeg) },
    ffprobe: { path: ffprobe, ...verifyTool(ffprobe) },
    edgeTts: edgeTtsInfo,
    // 版本对 ≠ 能用：再加一次真实合成探测
    edgeTtsSpeech: edgeTtsInfo.ok
      ? { path: edgeTts, ...probeEdgeTTS(edgeTts) }
      : { ok: false, path: edgeTts, error: 'edge-tts 本身不可用，跳过合成探测' },
  };
}
