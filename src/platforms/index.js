import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', '..', 'config', 'platforms.json');

// 内置最小配置（文件损坏时回退）
const FALLBACK_CONFIG = {
  tiktok: { name:'TikTok', video:{width:1080,height:1920,aspect:'9:16',duration:[40,60]}, post:{width:1080,height:1080,aspect:'1:1'}, subtitleLang:'cn+en', emoji:'🎵' }
};

let platformConfig;
try {
  platformConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (e) {
  console.warn('⚠️ platforms.json 读取失败，使用内置配置:', e.message);
  platformConfig = FALLBACK_CONFIG;
}

export function getPlatformConfig(key) {
  return platformConfig[key] || null;
}

export function getAllPlatforms() {
  return Object.entries(platformConfig).map(([key, config]) => ({
    key,
    ...config,
  }));
}

export function getVideoPlatforms() {
  return Object.entries(platformConfig)
    .filter(([, config]) => config.video)
    .map(([key, config]) => ({ key, ...config }));
}

export function getPostPlatforms() {
  return Object.entries(platformConfig)
    .filter(([, config]) => config.post)
    .map(([key, config]) => ({ key, ...config }));
}
