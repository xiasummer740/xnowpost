// 全网素材搜索（Pexels 免费 API）
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';

const PEXELS_KEY = process.env.PEXELS_API_KEY || '';
const PEXELS_BASE = 'https://api.pexels.com';

// 搜索真实图片
export async function searchPhotos(query, { perPage = 5, orientation = 'portrait' } = {}) {
  if (!PEXELS_KEY) {
    console.log('  📷 Pexels Key 未配置，跳过素材搜索');
    return [];
  }
  try {
    const resp = await axios.get(`${PEXELS_BASE}/v1/search`, {
      headers: { Authorization: PEXELS_KEY },
      params: { query, per_page: perPage, orientation, size: 'large' },
      timeout: 15000,
    });
    return (resp.data?.photos || []).map(p => ({
      id: p.id,
      url: p.src?.large2x || p.src?.original,
      photographer: p.photographer,
      width: p.width,
      height: p.height,
      avgColor: p.avg_color,
    }));
  } catch (e) {
    console.log(`  ⚠️ Pexels 搜索失败: ${e.message}`);
    return [];
  }
}

// 搜索真实视频
export async function searchVideos(query, { perPage = 3, orientation = 'portrait' } = {}) {
  if (!PEXELS_KEY) {
    console.log('  🎥 Pexels Key 未配置，跳过视频搜索');
    return [];
  }
  try {
    const resp = await axios.get(`${PEXELS_BASE}/videos/search`, {
      headers: { Authorization: PEXELS_KEY },
      params: { query, per_page: perPage, orientation, size: 'large' },
      timeout: 15000,
    });
    return (resp.data?.videos || []).map(v => {
      // 取竖屏高清版本
      const files = v.video_files || [];
      const best = files.find(f => f.width >= 1080 && f.height >= 1920)
        || files.find(f => f.quality === 'hd')
        || files[0];
      return {
        id: v.id,
        url: best?.link,
        duration: v.duration,
        width: best?.width,
        height: best?.height,
      };
    }).filter(v => v.url);
  } catch (e) {
    console.log(`  ⚠️ Pexels 视频搜索失败: ${e.message}`);
    return [];
  }
}

// 下载素材到本地
export async function downloadMaterial(url, filepath) {
  try {
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
    await fs.ensureDir(path.dirname(filepath));
    await fs.writeFile(filepath, Buffer.from(resp.data));
    console.log(`  📥 素材下载: ${path.basename(filepath)} (${(resp.data.length/1024).toFixed(0)}KB)`);
    return filepath;
  } catch (e) {
    console.log(`  ⚠️ 下载失败: ${e.message}`);
    return null;
  }
}
