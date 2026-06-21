/**
 * TikTok 自动发布器
 * 通过 Playwright + 比特浏览器打开已登录 TikTok Studio 并上传视频
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

/**
 * 发布视频到 TikTok
 */
export async function publishToTikTok(options) {
  const { sessionPath, videoFile, titleFile, envId, apiKey } = options;

  if (!videoFile) {
    throw new Error('没有视频可发布');
  }

  // 读文案
  let title = '';
  let tags = [];
  try {
    const txt = fs.readFileSync(titleFile, 'utf-8');
    const lines = txt.split('\n').filter(Boolean);
    title = lines[0] || '';
    for (const line of lines) {
      const found = line.match(/#[^\s#]+/g);
      if (found) tags.push(...found);
    }
    tags = [...new Set(tags)].slice(0, 5);
  } catch (e) {
    console.warn(`  ⚠️ 读文案失败: ${e.message}`);
    title = path.basename(sessionPath) || '';
  }

  console.log(`  📝 标题: ${title.substring(0, 50)}`);
  if (tags.length) console.log(`  🏷️ 标签: ${tags.join(' ')}`);

  const { openBitProfile, closeBitProfile } = await import('../collector/browser.js');

  console.log(`  🌐 打开比特环境 ${envId}...`);
  const result = await openBitProfile(envId, apiKey);
  if (!result) {
    throw new Error(`无法打开比特浏览器环境 ${envId}`);
  }

  const { context } = result;
  let publishedUrl = '';
  let screenshotDir = sessionPath;

  try {
    const page = await context.newPage();

    // 处理页面的对话框（自动接受，不让弹窗卡住）
    page.on('dialog', async dialog => {
      console.log(`  💬 对话框: "${dialog.message().substring(0, 50)}" → 接受`);
      await dialog.accept();
    });

    // 记录关键步骤截图
    async function screenshot(name) {
      try {
        await page.screenshot({ path: path.join(screenshotDir, `publish_${name}.png`), fullPage: false });
      } catch (_) {}
    }

    // ===== 发布视频 =====
    console.log('  📹 打开 TikTok Studio...');
    await page.goto('https://www.tiktok.com/tiktokstudio/upload', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });

    // 检查登录
    if (page.url().includes('login')) {
      await page.close();
      await closeBitProfile();
      throw new Error('TikTok 未登录，请在比特浏览器中先登录 TikTok');
    }

    await page.waitForTimeout(3000);
    await screenshot('01_upload_page');

    // 上传文件 — 隐藏 input 用 force:true
    console.log('  ⬆️ 上传视频...');
    await page.locator('input[type="file"]').first().setInputFiles(videoFile, { force: true });
    console.log('  ✅ 文件已提交');

    // 等待上传处理完成：检测视频预览出现
    console.log('  ⏳ 等待处理...');
    let videoReady = false;
    for (let i = 0; i < 36; i++) { // 最多等 3 分钟
      await page.waitForTimeout(5000);

      // 检测页面上是否有视频元素（上传完成后会出现预览）
      try {
        const hasVideo = await page.evaluate(() => {
          const vids = document.querySelectorAll('video');
          return vids.length > 0 && Array.from(vids).some(v => v.duration > 0 && !isNaN(v.duration));
        });
        if (hasVideo) {
          videoReady = true;
          console.log(`  ✅ 处理完成 (约${(i+1)*5}秒)`);
          await screenshot('02_video_ready');
          break;
        }
      } catch (_) {}
    }

    if (!videoReady) {
      await screenshot('03_timeout');
      // 视频没处理完也继续尝试发布
      console.log('  ⚠️ 处理超时，继续尝试...');
    }

    // 再加 3 秒确保 UI 稳定
    await page.waitForTimeout(3000);

    // 填写标题 — 用键盘输入方式兼容 Draft.js
    if (title) {
      console.log('  📝 填写标题...');
      try {
        // 点一下标题区域
        const captionArea = page.locator('[contenteditable="true"]').first();
        if (await captionArea.isVisible({ timeout: 3000 }).catch(() => false)) {
          await captionArea.click();
          await page.waitForTimeout(500);
          // 逐字输入（比 fill 更稳）
          await captionArea.pressSequentially(title, { delay: 20 });
          console.log('  ✅ 标题已填');
        } else {
          // fallback: 用 evaluate
          await page.evaluate((text) => {
            const el = document.querySelector('[contenteditable="true"]');
            if (el) {
              el.focus();
              document.execCommand('insertText', false, text);
            }
          }, title);
          console.log('  ✅ 标题已填 (evaluate)');
        }
        await screenshot('03_caption');
      } catch (e) {
        console.log(`  ⚠️ 填标题失败: ${e.message}`);
      }
    }

    // 查找并点击发布按钮
    console.log('  🔍 找发布按钮...');
    let posted = false;

    for (let i = 0; i < 10; i++) {
      // 尝试各种可能的发布按钮选择器
      const btnSelectors = [
        'button:has-text("Post")',
        'button:has-text("发布")',
        '[data-e2e="post-video-btn"]',
        'button:has-text("Publish")',
      ];

      for (const sel of btnSelectors) {
        try {
          const btn = page.locator(sel).first();
          const visible = await btn.isVisible({ timeout: 200 }).catch(() => false);
          const disabled = await btn.isDisabled({ timeout: 100 }).catch(() => true);

          if (visible && !disabled) {
            console.log(`  🚀 找到按钮: ${sel}, 点击发布...`);
            await screenshot('04_before_post');
            await btn.click();
            console.log('  ✅ 已点击');
            posted = true;
            break;
          }
        } catch (_) {}
      }
      if (posted) break;
      await page.waitForTimeout(3000);
    }

    if (!posted) {
      console.log('  ⚠️ 找不到可点击的发布按钮');
      await screenshot('04_no_post_button');
    }

    // 等待发布完成
    if (posted) {
      console.log('  ⏳ 等待发布确认...');
      await page.waitForTimeout(30000); // 等 30 秒让 TikTok 处理发布
      await screenshot('05_after_post');

      // 检查是否跳转到发布成功页面
      await page.waitForTimeout(5000);
    }

    publishedUrl = page.url();
    console.log(`  📎 当前页面: ${publishedUrl}`);

    await page.close();
  } catch (err) {
    try {
      await page?.screenshot({ path: path.join(screenshotDir, 'publish_error.png') });
    } catch (_) {}
    await closeBitProfile();
    throw err;
  }

  await closeBitProfile();
  return publishedUrl;
}
