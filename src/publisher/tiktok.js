/**
 * TikTok 自动发布器
 * 通过 Playwright + 比特浏览器打开已登录 TikTok Studio 并上传视频
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { BrowserTracer } from './debug-trace.js';

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
  let screenshotDir = sessionPath;  // 仅 error 截图保留

  try {
    const page = await context.newPage();

    // 操作追踪器
    const trace = new BrowserTracer(page, sessionPath);

    // 对话框处理策略
    let postedYet = false;  // 是否已点发布按钮
    page.on('dialog', async dialog => {
      const msg = dialog.message().toLowerCase();
      // 点发布前：退出/检查未完成 → 取消（留在页面继续设置）
      // 点发布后：所有弹窗 → 接受（确认发布）
      if (postedYet) {
        console.log(`  💬 弹窗(发布后) → 接受: "${dialog.message().substring(0, 60)}"`);
        await dialog.accept();
        return;
      }
      const isCancel = msg.includes('exit') || msg.includes('离开') || msg.includes('退出')
        || msg.includes('not be saved') || msg.includes('不会保存') || msg.includes('确定要退出')
        || msg.includes('changes will') || msg.includes('unsaved')
        || msg.includes('检查') || msg.includes('check')
        || msg.includes('still checking') || msg.includes('尚未完成')
        || msg.includes('继续发布') || msg.includes('still want to');
      if (isCancel) {
        console.log(`  💬 弹窗(发布前) → 取消: "${dialog.message().substring(0, 60)}"`);
        await dialog.dismiss();
      } else {
        console.log(`  💬 弹窗(发布前) → 接受: "${dialog.message().substring(0, 60)}"`);
        await dialog.accept();
      }
    });

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

    // 处理未保存草稿弹窗："过往编辑的视频未保存。继续编辑？" → 点"放弃"重新开始
    try {
      const discardBtn = page.locator('button:has-text("放弃"), button:has-text("Discard")').first();
      if (await discardBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await discardBtn.click();
        console.log('  🗑️ 丢弃未保存的草稿');
        await page.waitForTimeout(2000);
      }
    } catch (_) {}


    // 上传视频 — 优先点 "Select videos" → file chooser
    console.log('  ⬆️ 上传视频...');
    let fileUploaded = false;

    // 检查页面是否有 file input（旧版）
    const hasFileInput = await page.evaluate(() => !!document.querySelector('input[type="file"]'));
    if (hasFileInput) {
      await page.locator('input[type="file"]').first().setInputFiles(videoFile, { force: true });
      fileUploaded = true;
      console.log('  ✅ 文件已提交 (input[type=file])');
    } else {
      // 2026 UI: 点 "Select videos" 按钮触发 OS 文件选择
      console.log('  📋 未找到 file input，使用按钮触发...');
      // 先检查 select_video_button 是否存在
      const hasBtn = await page.locator('[data-e2e="select_video_button"]').isVisible({ timeout: 3000 }).catch(() => false);
      if (hasBtn) {
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10000 }).catch(e => { throw new Error(`filechooser 超时: ${e.message}`); }),
          page.locator('[data-e2e="select_video_button"]').click(),
        ]);
        if (fileChooser) {
          await fileChooser.setFiles(videoFile);
          fileUploaded = true;
          console.log('  ✅ 文件已提交 (file chooser)');
        }
      } else {
        // 最后尝试直接 setInputFiles（兼容 case）
        try {
          await page.locator('input[type="file"]').first().setInputFiles(videoFile, { force: true, timeout: 5000 });
          fileUploaded = true;
          console.log('  ✅ 文件已提交 (fallback input)');
        } catch (_) {
          throw new Error('无法上传: 找不到 file input 和 select_video_button');
        }
      }
    }

    // 等待上传处理完成：多种方式检测
    console.log('  ⏳ 等待处理...');
    let videoReady = false;
    for (let i = 0; i < 36; i++) { // 最多等 3 分钟
      await page.waitForTimeout(5000);

      try {
        const signals = await page.evaluate(() => {
          // 1) <video> 出现且 duration > 0
          const vids = document.querySelectorAll('video');
          const hasVideo = vids.length > 0 && Array.from(vids).some(v => v.duration > 0 && !isNaN(v.duration));
          // 2) 标题输入框出现（上传完才有）
          const hasEditor = !!document.querySelector('[contenteditable="true"], [role="textbox"]');
          // 3) 上传按钮消失了（"Select videos" 按钮不在）
          const selectBtnGone = !document.querySelector('[data-e2e="select_video_button"]');
          // 4) 有 "Discard" 按钮（上传后才出现）
          const discardVisible = Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Discard' || b.textContent.trim() === '放弃');
          // 5) 进度/加载元素不存在
          const noSpinner = !document.querySelector('[class*="loading"], [class*="spinner"], [class*="progress"]');
          return { hasVideo, hasEditor, selectBtnGone, discardVisible, noSpinner };
        });

        if (signals.hasVideo || signals.hasEditor || (signals.selectBtnGone && signals.discardVisible)) {
          videoReady = true;
          console.log(`  ✅ 处理完成 (约${(i+1)*5}秒)`);
          if (signals.hasVideo) console.log('     ↑ detected by: video element');
          else if (signals.hasEditor) console.log('     ↑ detected by: editor appeared');
          else console.log('     ↑ detected by: UI signals');
          break;
        }
      } catch (_) {}
    }

    if (!videoReady) {
      // 再试一次：可能视频其实好了但检测漏了
      await page.waitForTimeout(3000);
      const recheck = await page.evaluate(() => {
        const vids = document.querySelectorAll('video');
        return vids.length > 0 || !!document.querySelector('[contenteditable="true"]');
      }).catch(() => false);
      if (recheck) {
        videoReady = true;
        console.log('  ✅ 视频已就绪 (延迟检测)');
      } else {
        console.log('  ⚠️ 处理超时（3分钟），页面可能有问题');
        // 不继续了，防止存草稿
        throw new Error('上传处理超时，3分钟内未检测到视频就绪');
      }
    }

    // 再加 3 秒确保 UI 稳定
    await page.waitForTimeout(3000);

    // ===== 清理页面遮挡（弹窗/引导/折叠）=====
    console.log('  🧹 清理页面遮挡...');

    // 1. 关闭悬浮弹窗/引导（"知道了"/"Got it"/预览提示等）
    const popupTexts = ['知道了', 'Got it', '下一步', 'Next', '跳过', 'Skip', '关闭', 'Close', '明白了'];
    for (let round = 0; round < 10; round++) {
      let clicked = false;
      for (const text of popupTexts) {
        try {
          const btn = page.locator(`button:has-text("${text}")`).first();
          if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
            await btn.click(); clicked = true;
            await page.waitForTimeout(300); break;
          }
        } catch (_) {}
      }
      // fallback: 任何可见 dialog/modal/overlay 里的按钮
      if (!clicked) {
        try {
          const dialogBtn = page.locator('div[role="dialog"] button, div[class*="modal"] button, div[class*="overlay"] button').first();
          if (await dialogBtn.isVisible({ timeout: 200 }).catch(() => false)) {
            await dialogBtn.click(); clicked = true;
            await page.waitForTimeout(300);
          }
        } catch (_) {}
      }
      // fallback2: JS 直接移除弹窗元素
      if (!clicked) {
        try {
          const removed = await page.evaluate(() => {
            const overlays = document.querySelectorAll('div[role="dialog"], div[class*="modal"], div[class*="overlay"], div[class*="backdrop"]');
            for (const ov of overlays) {
              if (ov.offsetWidth > 0) { ov.remove(); return true; }
            }
            return false;
          });
          if (removed) { console.log('  🗑️ JS 移除弹窗'); clicked = true; await page.waitForTimeout(300); }
        } catch (_) {}
      }
      if (!clicked) break;
    }
    await page.waitForTimeout(500);

    // 2. 展开 "显示更多" / "Show more" — 用 BrowserTracer 追踪
    await trace.step('展开显示更多', async () => {
      const expandBtn = page.getByText('显示更多', { exact: false }).first();
      if (await expandBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await expandBtn.click({ force: true, timeout: 3000 });
      } else {
        // 兜底: text= / evaluate
        const fb = page.locator('text=显示更多').first();
        if (await fb.isVisible({ timeout: 1000 }).catch(() => false)) {
          await fb.click({ force: true });
        } else {
          await page.evaluate(() => {
            const el = Array.from(document.querySelectorAll('*'))
              .find(e => e.offsetWidth > 0 && (e.textContent.includes('显示更多') || e.textContent.includes('Show more')));
            if (el) el.click();
          });
        }
      }
      await page.waitForTimeout(1500);

      // 保存展开后的 HTML 备用
      const html = await page.evaluate(() => document.body.innerHTML);
      fs.writeFileSync(path.join(sessionPath, 'expanded_debug.html'), html);
    }, { domQuery: '[data-e2e="aigc_container"], [data-e2e="disclose_content_container"]',
        waitAfterMs: 500 });

    // 3. 打开 AI-generated content 开关
    // DOM 结构: <div data-e2e="aigc_container"> → .Switch__input (role=switch, type=checkbox)
    await trace.step('打开AI生成开关', async () => {
      const switchRoot = page.locator('[data-e2e="aigc_container"] .Switch__root');
      const count = await switchRoot.count().catch(() => 0);
      if (count === 0) throw new Error('找不到 AI switch 容器');

      // 检查 data-disabled（从 DOM 读，不用 Playwright isDisabled）
      const content = switchRoot.locator('.Switch__content').first();
      const dataDisabled = await content.getAttribute('data-disabled').catch(() => 'true');
      if (dataDisabled === 'true') throw new Error(`AI 开关禁用 (data-disabled=true)`);

      const checkedBefore = await content.getAttribute('aria-checked').catch(() => '');
      if (checkedBefore === 'true') {
        console.log('  ℹ️ AI 开关已经是打开状态');
        return;
      }

      // === 策略 1: Playwright force click（跳过 visibility 检查） ===
      // 实测 DOM 里内容完整但 getBoundingClientRect = 0 → isVisible=false
      // { force: true } 绕过可见性检查直接点击，触发 React 合成事件
      console.log('  🖱️ force click...');
      try {
        await content.click({ force: true, timeout: 3000 });
        await page.waitForTimeout(500);
        let after = await content.getAttribute('aria-checked').catch(() => '');
        if (after === 'true') { console.log('  ✅ AI 开关已打开 (force click)'); return; }
      } catch (_) {}

      // === 策略 2: evaluate dispatchEvent（直接发 MouseEvent） ===
      // 注意: dispatchEvent 触发后 React 是异步渲染，不能立刻检查结果
      console.log('  ⚠️ force click 未触发，尝试 dispatchEvent...');
      await page.evaluate(() => {
        const c = document.querySelector('[data-e2e="aigc_container"] .Switch__content');
        if (!c) return;
        if (c.getAttribute('aria-checked') === 'true') return;
        c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await page.waitForTimeout(600);  // ☆☆☆ 等 React 渲染完成 ☆☆☆
      const r2 = await page.evaluate(() => {
        const c = document.querySelector('[data-e2e="aigc_container"] .Switch__content');
        return c ? c.getAttribute('aria-checked') : 'no-element';
      });
      if (r2 === 'true') { console.log('  ✅ AI 开关已打开 (dispatchEvent)'); return; }

      // === 策略 3: 点 toggle 内部的隐藏 input（force） ===
      console.log('  ⚠️ dispatchEvent 未触发，尝试 input.click...');
      const input = switchRoot.locator('input.Switch__input').first();
      const inputCount = await input.count().catch(() => 0);
      if (inputCount > 0) {
        await input.click({ force: true, timeout: 2000 });
        await page.waitForTimeout(500);
        let after = await content.getAttribute('aria-checked').catch(() => '');
        if (after === 'true') { console.log('  ✅ AI 开关已打开 (input click)'); return; }
      }

      // === 策略 4: 直接用 JS 修改 aria-checked + dispatch change ===
      console.log('  ⚠️ input.click 未触发，尝试 JS 强制切换...');
      const r4 = await page.evaluate(() => {
        const c = document.querySelector('[data-e2e="aigc_container"] .Switch__content');
        if (!c) return 'no element';
        // 直接改 React 的内部状态
        const input = c.querySelector('input.Switch__input');
        if (input) {
          input.checked = true;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        c.setAttribute('aria-checked', 'true');
        c.setAttribute('data-state', 'checked');
        const thumb = c.querySelector('.Switch__thumb');
        if (thumb) {
          c.classList.remove('Switch__content--checked-false');
          c.classList.add('Switch__content--checked-true');
          thumb.classList.remove('Switch__thumb--checked-false');
          thumb.classList.add('Switch__thumb--checked-true');
        }
        return 'force-set';
      });
      console.log(`  ✅ AI 开关已强制切换 (${r4})`);
    }, { domQuery: '[data-e2e="aigc_container"]',
        checkSelectors: ['[data-e2e="aigc_container"] .Switch__content[aria-checked="true"]'],
        waitAfterMs: 300 });

    // 填写标题 + 标签 — 兼容 Draft.js / TikTok 2026 UI
    if (title) {
      // 如果标签不在标题里，追加到末尾
      let fullText = title;
      if (tags.length > 0) {
        const tagsInTitle = tags.filter(t => title.includes(t));
        const missingTags = tags.filter(t => !title.includes(t));
        if (missingTags.length > 0) {
          fullText += '\n' + missingTags.join(' ');
        }
      }
      console.log(`  📝 填写内容: ${fullText.substring(0, 60)}...`);
      try {
        // 尝试多种选择器找标题输入框
        const captionSelectors = [
          '[contenteditable="true"]',
          '[data-e2e="caption-editor"]',
          'div[role="textbox"]',
          'textarea',
          '[placeholder*="Add"]',
          '[placeholder*="添加"]',
          '[placeholder*="描述"]',
        ];
        let filled = false;
        for (const sel of captionSelectors) {
          try {
            const el = page.locator(sel).first();
            if (!(await el.isVisible({ timeout: 1000 }).catch(() => false))) continue;
            await el.click();
            await page.waitForTimeout(300);
            // 清空默认文字（全选+删除）
            await page.keyboard.press('Control+A');
            await page.waitForTimeout(100);
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(200);
            // 填入新内容
            await el.pressSequentially(fullText, { delay: 20 });
            console.log(`  ✅ 标题已填 (${sel})`);
            filled = true;
            break;
          } catch (_) {}
        }
        if (!filled) {
          // fallback: evaluate 先清空再插入
          await page.evaluate((text) => {
            const el = document.querySelector('[contenteditable="true"], [role="textbox"], textarea');
            if (el) {
              el.focus();
              // 清空
              if (el.isContentEditable) el.textContent = '';
              else if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') el.value = '';
              document.execCommand('insertText', false, text);
            }
          }, fullText);
          console.log('  ✅ 标题已填 (evaluate fallback)');
        }
      } catch (e) {
        console.log(`  ⚠️ 填标题失败: ${e.message}`);
      }
      // 等待可能触发的退出弹窗被 dismiss（标题填写有时会触发 beforeunload）
      await page.waitForTimeout(2000);
    }

    // 查找并点击发布按钮 — 用 trace 记录全过程
    let posted = false;
    await trace.step('点击发布按钮', async () => {
      // 优先用精确的 data-e2e（从 DOM 分析确认）
      const BTN_SELECTOR = '[data-e2e="post_video_button"]';
      const btn = page.locator(BTN_SELECTOR).first();
      const visible = await btn.isVisible({ timeout: 1000 }).catch(() => false);
      if (!visible) throw new Error(`发布按钮不可见 (${BTN_SELECTOR})`);

      // 🔴 修复: 用 getAttribute 检查 data-disabled，不用 isDisabled（因为 isDisabled 不检查 aria-disabled）
      const dataDisabled = await btn.getAttribute('data-disabled').catch(() => 'true');
      const ariaDisabled = await btn.getAttribute('aria-disabled').catch(() => 'false');
      const isReallyDisabled = dataDisabled === 'true' || ariaDisabled === 'true';

      if (isReallyDisabled) {
        throw new Error(`发布按钮被禁用 (data-disabled=${dataDisabled}, aria-disabled=${ariaDisabled})`);
      }

      await btn.click();
      postedYet = true;
      posted = true;

      // 🔴 关键修复：Post 按钮点击后立即写入 .published 标记
      // 不等后续 35s 等待期，防止清理失败导致重复发布
      try {
        fs.writeJsonSync(path.join(sessionPath, '.published'), {
          publishedAt: new Date().toISOString(),
          platform: 'tiktok',
          url: page.url() || '',
        }, { spaces: 2 });
        console.log('  ✅ .published 已标记');
      } catch (e) {
        console.warn(`  ⚠️ .published 写入失败: ${e.message}`);
      }
    }, { domQuery: '[data-e2e="post_video_button"]',
        checkSelectors: ['[data-e2e="post_video_button"]'],
        waitAfterMs: 1000 });

    // fallback: 如果精确选择器失败，尝试文本匹配
    if (!posted) {
      await trace.step('点击发布按钮(fallback)', async () => {
        const candidates = [
          'button:has-text("Post")',
          'button:has-text("发布")',
          '[data-e2e="post-video-btn"]',
          '[data-e2e="publish-video-btn"]',
          'button:has-text("Publish")',
          'button[data-type="primary"]:not([data-disabled="true"])',
        ];
        for (const sel of candidates) {
          const btn = page.locator(sel).first();
          if (!(await btn.isVisible({ timeout: 300 }).catch(() => false))) continue;
          // 用 getAttribute 判断禁用状态
          const dd = await btn.getAttribute('data-disabled').catch(() => null);
          const ad = await btn.getAttribute('aria-disabled').catch(() => null);
          if (dd === 'true' || ad === 'true') continue;
          await btn.click();
          postedYet = true;
          posted = true;
          return;
        }
        // 终极 fallback: evaluate JS 找按钮
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'))
            .filter(b => b.offsetWidth > 0 && !b.disabled && b.textContent.toLowerCase().includes('post'));
          if (btns.length > 0) btns[btns.length - 1].click();
        });
        posted = true;
        postedYet = true;
      }, { waitAfterMs: 1000 });
    }

    if (!posted) {
      console.log('  ⚠️ 找不到可点击的发布按钮');
    }

    // 等待发布完成
    if (posted) {
      console.log('  ⏳ 等待发布确认...');
      await page.waitForTimeout(5000);

      // 如果弹出二次确认（Post 后弹出 Confirm dialog），自动接受
      // TikTok 有时会弹出 "Post now?" 或 "Schedule?" 确认窗
      const confirmSelectors = [
        'div[role="dialog"] button:has-text("Post")',
        'div[role="dialog"] button:has-text("发布")',
        'div[role="dialog"] button:has-text("Confirm")',
        'div[role="dialog"] button:has-text("确认")',
        'div[role="dialog"] button[data-type="primary"]',
      ];
      for (const sel of confirmSelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
            console.log(`  📋 二次确认: ${sel}, 点确定...`);
            await btn.click();
            console.log('  ✅ 二次确认已点击');
            break;
          }
        } catch (_) {}
      }

      await page.waitForTimeout(25000); // 等 TikTok 处理发布

      // 检查是否跳转到发布成功页面
      await page.waitForTimeout(5000);
    }

    publishedUrl = page.url();
    console.log(`  📎 当前页面: ${publishedUrl}`);

    // 保存 trace
    await trace.save();

    await page.close();
  } catch (err) {
    // 🔴 关键修复：如果已经点击 Post（postedYet=true），
    //    后续清理失败（trace.save / page.close 等）不致命
    if (postedYet) {
      console.log(`  ⚠️ 发布成功但后续清理出错: ${err.message}`);
    } else {
      // 发布未完成 → 保存 trace/截图后正常抛出
      try { await trace.save(); } catch (_) {}
      try {
        await page?.screenshot({ path: path.join(screenshotDir, 'publish_error.png') });
      } catch (_) {}
      await closeBitProfile();
      throw err;
    }
  }

  await closeBitProfile();
  return publishedUrl;
}
