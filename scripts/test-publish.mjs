/**
 * 测试 TikTok 发布 — 自动跑通为止
 * 直接调用 publishToTikTok，迭代修复
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 配置
const ENV_ID = '31bea5b146af40f58b2a6eae0e2c2a6b';
const API_KEY = '';
const SESSION_PATH = path.join(ROOT, 'output', '2026-06-20', 'pm_1756');

async function main() {
  // 删除 .published 标记（如果有）
  const pubFile = path.join(SESSION_PATH, '.published');
  if (fs.existsSync(pubFile)) {
    fs.unlinkSync(pubFile);
    console.log('🗑️ 已删除 .published 标记');
  }

  const videoFile = path.join(SESSION_PATH, 'video.mp4');
  const titleFile = path.join(SESSION_PATH, '文案.txt');

  console.log(`📤 测试发布: ${SESSION_PATH}`);
  console.log(`   video: ${fs.existsSync(videoFile)}`);
  console.log(`   title: ${fs.existsSync(titleFile)}`);

  if (!fs.existsSync(videoFile)) {
    console.error('❌ 视频文件不存在');
    process.exit(1);
  }

  const { publishToTikTok } = await import('../src/publisher/tiktok.js');

  try {
    const url = await publishToTikTok({
      sessionPath: SESSION_PATH,
      videoFile,
      titleFile,
      envId: ENV_ID,
      apiKey: API_KEY,
    });
    console.log(`\n✅ 发布完成! URL: ${url || '(无返回)'}`);
  } catch (err) {
    console.error(`\n❌ 发布失败: ${err.message}`);
  }

  // 检查 trace
  const traceFile = path.join(SESSION_PATH, 'browser-trace.json');
  if (fs.existsSync(traceFile)) {
    const trace = JSON.parse(fs.readFileSync(traceFile, 'utf-8'));
    console.log('\n📊 Trace 摘要:');
    for (const s of trace.summary) {
      const icon = s.success ? '✅' : '❌';
      console.log(`   ${icon} [${s.idx}] ${s.name} (${s.duration}ms)${s.error ? ` → ${s.error}` : ''}`);
    }
  } else {
    console.log('⚠️ trace 文件不存在');
  }
}

main().catch(err => {
  console.error('测试脚本异常:', err);
  process.exit(1);
});
