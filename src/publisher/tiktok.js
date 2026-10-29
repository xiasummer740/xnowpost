/**
 * TikTok 自动发布器
 * 通过 FoxProfile 指纹浏览器（Camoufox）打开已登录 TikTok Studio 并上传视频
 */
import path from 'path';
import fs from 'fs-extra';
import { BrowserTracer } from './debug-trace.js';
import { writeJsonAtomicSync } from '../fs-atomic.js';
import { appendLedger, dataDirOfSession } from '../publish-history.js';
import { handleDialogs, findFatalDialog } from './dialogs.js';
import { releaseMessage, releaseNote } from './check-wording.js';
import {
  createDeadline, assertBudget, budgetedWait, envBudgetMs,
  BudgetExceededError, MIN_RETRY_BUDGET_MS,
} from './waits.js';

/**
 * 判断错误是否为可重试类型（网络/环境/超时等临时故障）
 */
function isRetryableError(err) {
  // 预算耗尽 → 绝不能重试：再跑一轮只会又被宿主超时杀掉
  if (err instanceof BudgetExceededError || err?.name === 'BudgetExceededError') return false;
  // 已经点过发布按钮 → 绝不能重试：重试 = 重新上传，可能重复发布
  if (err?.posted === true) return false;
  const msg = (err?.message || '').toLowerCase();
  // 明确不可重试的
  if (msg.includes('没有视频可发布')) return false;
  if (msg.includes('未登录')) return false;
  if (msg.includes('already posted') || msg.includes('.published')) return false;
  // 以下可重试
  if (msg.includes('无法打开指纹浏览器环境')) return true;
  if (msg.includes('file chooser') || msg.includes('FileChooser')) return true;
  if (msg.includes('无法上传')) return true;
  if (msg.includes('上传处理超时')) return true;
  if (msg.includes('检查超时')) return true;
  if (msg.includes('找不到 file input')) return true;
  if (msg.includes('找不到 ai switch')) return true;
  if (msg.includes('发布按钮不可见')) return true;
  if (msg.includes('发布按钮被禁用')) return true;
  if (msg.includes('发布按钮未能点击')) return true;  // 未点上按钮 = 什么都没发出，重试安全
  if (msg.includes('timeout') || msg.includes('超时')) return true;
  if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('etimedout')) return true;
  if (msg.includes('net::')) return true;  // Chrome 网络错误
  if (msg.includes('target closed')) return true;  // 浏览器意外关闭
  if (msg.includes('protocol error')) return true;  // CDP 协议错误
  return false;  // 其他未知错误不重试
}

/**
 * 带重试的发布包装
 * ⚠️ 两条安全红线：
 *   1. 已经点过发布按钮的错误（err.posted=true）绝不重试 —— 重试会重新上传，可能重复发布；
 *   2. 剩余预算不足以再跑一轮（< MIN_RETRY_BUDGET_MS）时不再重试，直接抛出，
 *      避免被宿主超时杀在半路（P2-5）。
 */
async function publishWithRetry(options, attempt = 1, maxRetries = 3) {
  try {
    return await publishToTikTokCore(options);
  } catch (err) {
    const isRetryable = isRetryableError(err);
    if (attempt <= maxRetries && isRetryable) {
      const deadline = options.deadline;
      if (deadline && deadline.remaining() < MIN_RETRY_BUDGET_MS) {
        console.log(`  ⛔ 剩余预算 ${(deadline.remaining()/1000).toFixed(0)}s 不足以再重试一轮，直接结束`);
        throw err;
      }
      const delay = Math.min(10 * Math.pow(2, attempt - 1), 60) * 1000; // 10s, 20s, 40s
      if (deadline && deadline.remaining() < delay + MIN_RETRY_BUDGET_MS) {
        console.log(`  ⛔ 剩余预算不足以等待重试间隔 ${delay/1000}s，直接结束`);
        throw err;
      }
      console.log(`  🔄 第 ${attempt}/${maxRetries} 次重试 (${delay/1000}s 后)...`);
      console.log(`    原因: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
      return publishWithRetry(options, attempt + 1, maxRetries);
    }
    if (attempt > 1 && isRetryable) {
      console.log(`  ❌ 重试 ${maxRetries} 次后仍失败`);
    }
    throw err;
  }
}

/**
 * 发布视频到 TikTok（对导出函数使用重试包装）
 * @param {object} options
 * @param {number} [options.budgetMs] 总耗时预算（毫秒）。默认取环境变量
 *        XNOWPOST_PUBLISH_BUDGET_MS，再退回 30 分钟。
 *        调用方应传入**小于宿主超时**的值，否则仍会被杀在半路。
 */
export async function publishToTikTok(options) {
  const budgetMs = Number.isFinite(options?.budgetMs) && options.budgetMs > 0
    ? options.budgetMs
    : envBudgetMs();
  const deadline = createDeadline(budgetMs);
  // ⚠️ 图标不能用 ⏱️：日志分类器把行内 ⏱️ 当"超时失败"
  //    （electron/main.js 的 isFailure 与系统通知条件都是 /❌|⏱️|⚠️.*未确认/），
  //    于是每发一条视频就记一条 [ERROR]、弹一次「XNOWPost 定时任务异常」
  //    —— 2026-10-29 一天 9 条假错误 + 12 次误弹窗。
  console.log(`  🧮 发布预算: ${(budgetMs / 60000).toFixed(1)} 分钟（超过就提前收尾，未确认的下一轮自动重试）`);
  return withActionLog(options?.sessionPath, () => publishWithRetry({ ...options, budgetMs, deadline }));
}

/**
 * 逐动作实时日志（publish.log）
 *
 * 为什么需要它：调度器用 spawnSync 跑发布器，子进程 stdout 要等**退出时一次性回放**，
 * 所有行的时间戳都一样 —— 出了事故只能靠猜"到底卡在哪一步"。
 * `browser-trace.json` 又只记了 3 个 trace.step（展开/AI 开关/点发布），远不够。
 *
 * 这里把发布期间的**每一条日志**都按真实时间追加到 `<会话目录>/publish.log`：
 *     +1234ms  Δ  456ms  🖱️ Post 已在视口内 → 按坐标点击
 * 于是"全部动作 + 各自耗时"是可复盘的事实，而不是推断。
 */
function withActionLog(sessionPath, fn) {
  if (!sessionPath) return fn();
  const file = path.join(sessionPath, 'publish.log');
  const orig = console.log;
  const t0 = Date.now();
  let last = t0;
  try { fs.writeFileSync(file, `# 发布动作日志（每行：累计秒 + 与上一动作的间隔）\n`, 'utf-8'); } catch { /* 目录只读就算了 */ }
  console.log = (...args) => {
    const now = Date.now();
    const text = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    const line = `+${String(((now - t0) / 1000).toFixed(1)).padStart(6)}s  Δ${String(now - last).padStart(6)}ms  ${text.replace(/\s*\n\s*/g, ' ⏎ ')}`;
    last = now;
    try { fs.appendFileSync(file, line + '\n'); } catch { /* 忽略写盘失败 */ }
    orig(...args);
  };
  const restore = () => { console.log = orig; };
  let out;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

/**
 * 发布核心逻辑（不包含重试）
 */
async function publishToTikTokCore(options) {
  const { sessionPath, videoFile, titleFile, envId, apiKey } = options;
  // 预算 deadline 由 publishToTikTok 创建（直接调用本函数时兜底为默认预算）
  const deadline = options.deadline || createDeadline(options.budgetMs);

  if (!videoFile) {
    throw new Error('没有视频可发布');
  }

  // 读文案
  // 文案.txt 的结构（src/index.js 生成）：
  //   第 1 行 = 中文标题（钩子）
  //   第 2 行 = 英文标题
  //   中间   = 分镜文字（中文）
  //   末行   = #标签
  // 以前只取第 1 行 + 标签，英文标题被丢掉 → 海外用户完全看不懂。
  // 现在发「中英双语」：中文标题 + 英文标题 + 标签，国内外都能读懂。
  let title = '';
  let titleEn = '';
  let tags = [];
  try {
    const txt = fs.readFileSync(titleFile, 'utf-8');
    const lines = txt.split('\n').map((s) => s.trim()).filter(Boolean);
    title = lines[0] || '';
    // 英文标题：后续几行里第一行"不含中文、字母够多、不是标签行"的
    const isEnglishLine = (l) =>
      !/[\u4e00-\u9fff]/.test(l) && (l.match(/[A-Za-z]/g) || []).length >= 10 && !l.includes('#');
    titleEn = lines.slice(1, 4).find(isEnglishLine) || '';
    for (const line of lines) {
      const found = line.match(/#[^\s#]+/g);
      if (found) tags.push(...found);
    }
    // 标签中英各占一半更划算：纯中文标签海外用户刷不到，纯英文又丢了中文流量
    // 带空格的标签（"#secure browsing"）不是合法标签，先去掉空格再判中英
    const uniq = [];
    const seenLower = new Set();
    for (const raw of tags) {
      const t = raw.replace(/^#/, '').replace(/\s+/g, '');
      if (!t) continue;
      const k = t.toLowerCase();
      if (seenLower.has(k)) continue;
      seenLower.add(k);
      uniq.push('#' + t);
    }
    const isAsciiTag = (t) => /^#[A-Za-z0-9_]+$/.test(t);
    const en = uniq.filter(isAsciiTag);
    const zh = uniq.filter((t) => !isAsciiTag(t));
    const mixed = [];
    while (mixed.length < 6 && (en.length || zh.length)) {
      if (mixed.length % 2 === 0 && en.length) mixed.push(en.shift());
      else if (zh.length) mixed.push(zh.shift());
      else if (en.length) mixed.push(en.shift());
      else break;
    }
    tags = mixed;
  } catch (e) {
    console.warn(`  ⚠️ 读文案失败: ${e.message}`);
    title = path.basename(sessionPath) || '';
  }

  console.log(`  📝 标题: ${title.substring(0, 50)}`);
  if (titleEn) console.log(`  🌍 英文标题: ${titleEn.substring(0, 60)}`);
  if (tags.length) console.log(`  🏷️ 标签: ${tags.join(' ')}`);

  // 发布文案优先用生成阶段写好的「描述.txt」（中英双语定稿），没有才现场拼
  let captionOverride = '';
  try {
    const descPath = path.join(path.dirname(titleFile), '描述.txt');
    if (fs.existsSync(descPath)) {
      captionOverride = fs.readFileSync(descPath, 'utf-8').trim();
      if (captionOverride) console.log(`  🌐 使用双语描述.txt (${captionOverride.length} 字)`);
    }
  } catch (_) {}

  // 指纹浏览器（FoxProfile）：浏览器由 FoxProfile 启动（指纹/代理才对），
  // 这里拿到的是 Playwright 形状的 page，下面所有定位/点击逻辑原样可用。
  const { openFoxPage, closeFoxPage } = await import('../collector/foxpw.js');

  console.log(`  🌐 打开指纹环境 ${envId}...`);
  let result;
  try {
    result = await openFoxPage(envId, process.env.FOXPROFILE_API || '');
  } catch (e) {
    throw new Error(`无法打开指纹浏览器环境 ${envId}: ${e.message}`);
  }
  if (!result) {
    throw new Error(`无法打开指纹浏览器环境 ${envId}`);
  }

  const { context } = result;
  let publishedUrl = '';
  let screenshotDir = sessionPath;  // 仅 error 截图保留
  let postedYet = false;  // 是否已点发布按钮 — 移到 try 外面，catch 也能访问
  let publishSuccess = false;  // 发布后页面是否跳离 /upload，决定是否关窗口
  let page = null;   // 提到 try 外面：否则 catch 里引用会 ReferenceError 被静默吞掉
  let trace = null;
  let sense = null;  // 页面观察器（page-sense）
  let reactor = null; // 浮层反应器（眼睛 + 手）
  let windowClosed = false;

  // P2-13：无论成功、失败还是超预算，本环境窗口都要关掉，否则窗口无限累积。
  // （旧实现只在 publishSuccess 时关闭，卡在"已点击但未确认"时窗口永远留着）
  // 需要人工排查页面时，调用方可传 keepWindowOnFailure: true。
  const keepWindow = options.keepWindow === true || options.keepWindowOnFailure === true;
  const closeWindow = async () => {
    if (windowClosed) return;
    windowClosed = true;
    try { await closeFoxPage(envId, process.env.FOXPROFILE_API || ''); }
    catch (e) { console.warn(`  ⚠️ 关闭指纹环境 ${envId} 失败: ${e.message}`); }
  };

  // 记录"已点击发布、但结果未确认"：
  // 保留"确实点过按钮"的证据（避免重复上传），同时明确标注 confirmed=false，
  // 不让上层把它当成"确认发布成功"。
  const markUnconfirmed = (reason) => {
    try {
      const p = path.join(sessionPath, '.published');
      let prev = {};
      try { if (fs.existsSync(p)) prev = fs.readJsonSync(p); } catch (_) { /* ignore */ }
      writeJsonAtomicSync(p, {
        ...prev,
        platform: 'tiktok',
        publishedAt: prev.publishedAt || new Date().toISOString(),
        url: (page && page.url()) || prev.url || '',
        note: 'post-clicked-unconfirmed',
        confirmed: false,
        unconfirmedReason: reason,
        env: envId,
        session: path.basename(sessionPath),
        title: (title || '').slice(0, 120),
      }, 2);
    } catch (_) { /* ignore */ }
  };

  try {
    // FoxProfile 已经把环境的页面开好了，直接用（没有 context.newPage 这一步）
    page = result.page;

    // 操作追踪器
    trace = new BrowserTracer(page, sessionPath);

    // 「眼睛」：后台持续观察页面变化，写到 <会话目录>/page-events.log。
    // 有了它，弹窗什么时候出现/消失、按钮什么时候可点、上传进度、点击坐标、
    // 谁把页面滚了 —— 全部是事实，不用再靠推断。
    try {
      const { startSensing, startOverlayReactor } = await import('./page-sense.js');
      sense = await startSensing(page, {
        logFile: path.join(sessionPath, 'page-events.log'),
        shotDir: sessionPath,
        intervalMs: 300,
        log: (m) => console.log(m),
      });
      // 「手」：常驻反应器 —— 浮层一出现就在 0.3~0.8 秒内按策略点掉并复验，
      // 不再依赖"恰好走到某个 handleDialogs 调用点"才能处理弹窗。
      reactor = await startOverlayReactor(page, {
        intervalMs: 500,
        log: (m) => console.log(m),
        shot: sense ? sense.shot : null,   // 看见浮层的那一刻拍照留证
      });
    } catch (err) {
      console.log(`  ⚠️ 页面观察未启动（不影响发布）: ${(err.message || '').split('\n')[0]}`);
    }

    // 只有「真的点了 Post 按钮」才写 .published 标记。
    // 标记一旦写入，findUnpublished() 就永久跳过该内容，
    // 所以绝不能在没有点击的情况下写（否则会静默丢内容）。
    const markPublishedNow = (note = '') => {
      try {
        // 原子写：半截 JSON 会让后续读取标记失败 → 误判为未发布 → 重复上传
        // env/session/title 是给「账号页最后发布时间」用的：以前标记里只有时间，
        // 复盘时根本不知道这个作品是哪个环境发的（要从 publish.log 里反解析）。
        writeJsonAtomicSync(path.join(sessionPath, '.published'), {
          publishedAt: new Date().toISOString(),
          platform: 'tiktok',
          url: page.url() || '',
          note,
          env: envId,
          session: path.basename(sessionPath),
          title: (title || '').slice(0, 120),
          confirmed: true,
        }, 2);
        console.log('  ✅ .published 已标记');
        // 同时写一行「发布账本」：账号页靠它做到「刚发完就更新最后发布时间」。
        // 失败不影响发布（账本只是展示用）。
        appendLedger(dataDirOfSession(sessionPath), {
          env: envId,
          at: new Date().toISOString(),
          date: path.basename(path.dirname(sessionPath)),
          session: path.basename(sessionPath),
          title,
          url: page.url() || '',
          source: 'publisher',
        });
      } catch (e) {
        console.warn(`  ⚠️ .published 写入失败: ${e.message}`);
      }
    };

    // 对话框处理策略（由 FoxProfile 服务端按策略自动应答）
    //
    // Camoufox 没有 CDP，弹窗回调无法跨进程传回来，所以规则搬到服务端：
    //   pre  = 发布前保守处理：空消息 / "检查尚未完成" / "未保存将丢失" 一律取消，
    //          其余接受（实测接受空白 dialog 会直接把页面关掉）
    //   post = 点过发布按钮后：全部接受（确认发布）
    // 原来在 page.on('dialog') 里的逐条判断，逻辑一一对应到服务端 policy。
    await page.setDialogPolicy('pre');

    // ===== 发布视频 =====
    console.log('  📹 打开 TikTok Studio...');
    await page.goto('https://www.tiktok.com/tiktokstudio/upload', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });

    // 检查登录
    if (page.url().includes('login')) {
      throw new Error('TikTok 未登录，请在指纹浏览器里先登录 TikTok');
    }

    await page.waitForTimeout(3000);

    // 处理未保存草稿弹窗："过往编辑的视频未保存。继续编辑？" → 点"放弃"重新开始
    //
    // ⚠️ 这里**必须先挂起反应器**：反应器认识「Discard this post?」这个框，每 500ms 一轮，
    //    会抢在我们前面点 Not now（= 取消丢弃）→ 旧草稿永远留着、下一轮又弹一遍。
    //    今天 10 轮里 6 轮都有这个框，就是这么来的。
    if (reactor && typeof reactor.pause === 'function') reactor.pause();
    try {
      const discardBtn = page.locator('button:has-text("放弃"), button:has-text("Discard")').first();
      if (await discardBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await discardBtn.click();
        console.log('  🗑️ 丢弃未保存的草稿');
        await page.waitForTimeout(1500);
        // 点完横幅的「放弃」TikTok 还会弹一层「Discard this post?」（Not now / Discard）。
        // 用户口径（2026-10-19）：「里面是草稿就该点 Discard，点 Not now 等于没丢弃，下次还会弹」。
        // ⚠️ 此刻**还没有**上传我们的视频/文案，Discard 丢的是上一轮留下的旧草稿，所以是安全的；
        //    上传之后任何地方都不许点 Discard（那些调用不带 allowDiscardDraft）。
        const dropped = await handleDialogs(page, {
          sessionPath,
          tag: 'draft-discard',
          allowDiscardDraft: true,
        }).catch(() => null);
        const droppedDiscard = ((dropped && dropped.actions) || []).some(
          (a) => a.kind === 'clicked' && /放弃作品确认/.test(a.rule) && /discard|放弃/i.test(a.clicked || ''),
        );
        if (droppedDiscard) console.log('  ✅ 旧草稿已彻底丢弃（确认框点的是 Discard）');
        // 兜底：Discard 没点成（框还在）→ 用保守口径（Not now）收掉，绝不把框留在页面上
        const stillOpen = await page
          .evaluate(() => /discard this post/i.test(document.body.innerText || ''))
          .catch(() => false);
        if (stillOpen) {
          const again = await handleDialogs(page, { sessionPath, tag: 'draft-discard-fallback' }).catch(() => null);
          if (again && again.total) console.log('  ⚠️ Discard 没点成，改用 Not now 收掉（旧草稿会留着，下次还会弹）');
        }
        await page.waitForTimeout(1200);
      }
    } catch (_) {
      /* 草稿弹窗处理失败不影响主流程（下面上传步骤还会再清一遍） */
    } finally {
      if (reactor && typeof reactor.resume === 'function') reactor.resume();
    }


    // 上传视频 — 优先点 "Select videos" → file chooser
    console.log('  ⬆️ 上传视频...');
    let fileUploaded = false;

    // 检查页面是否有 file input（旧版）
    const hasFileInput = await page.evaluate(() => !!document.querySelector('input[type="file"]'));
    if (hasFileInput) {
      await page.uploadFile('input[type="file"]', videoFile);
      fileUploaded = true;
      console.log('  ✅ 文件已提交 (input[type=file])');
    } else {
      // 2026 UI: 点 "Select videos" 按钮触发 OS 文件选择
      console.log('  📋 未找到 file input，使用按钮触发...');
      // 先检查 select_video_button 是否存在
      const hasBtn = await page.locator('[data-e2e="select_video_button"]').isVisible({ timeout: 3000 }).catch(() => false);
      if (hasBtn) {
        // FoxProfile 服务端用 expect_file_chooser 包住点击，不需要客户端等事件
        await page.uploadViaButton('[data-e2e="select_video_button"]', videoFile);
        fileUploaded = true;
        console.log('  ✅ 文件已提交 (file chooser)');
      } else {
        // 最后尝试直接塞 file input（兼容 case）
        try {
          await page.uploadFile('input[type="file"]', videoFile);
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
      await budgetedWait(page, 5000, deadline, '等待上传处理完成');

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
      await budgetedWait(page, 3000, deadline, '上传就绪延迟复检');
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
    await budgetedWait(page, 3000, deadline, '等待 UI 稳定');

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
      // fallback: 走统一的弹窗规则（AI 标注 → Turn on；危险按钮绝不点；未知弹窗只点安全按钮）
      // ⚠️ 老实现点「弹窗里第一个可见按钮」，会把 AI 标注引导点成 Not now（= 拒绝合规标注），
      //    还可能点到 Discard / Delete；再不行就 JS remove() 弹窗（只是藏起来，React 状态还在）。
      if (!clicked) {
        try {
          const r = await handleDialogs(page, { sessionPath, tag: 'cleanup' });
          // 只有"真的点掉了"才算有进展；blocked / no-match（签名误报）不算，
          // 否则这个循环会空转 10 轮、日志刷屏
          const acted = (r.actions || []).some((a) => a.kind === 'clicked' || a.kind === 'unknown-dismissed');
          if (acted) { clicked = true; await page.waitForTimeout(300); }
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
    //
    // ⚠️ 先清扫一遍弹窗再动开关：上传完成后 TikTok 会弹「Turn on automatic content checks?」，
    //    那个遮罩会盖住开关区域。2026-10-18 21:37 实测：不先清，开关的三种点击策略全部失败
    //    （Element is not visible），白耗 25 秒才在 after-aigc 那一遍被清掉。
    try {
      const pre = await handleDialogs(page, { sessionPath, tag: 'pre-aigc' });
      if (pre.total > 0) console.log(`  🧹 开关前清掉 ${pre.total} 个浮层`);
    } catch (_) {}

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

      // === 策略 1: evaluate dispatchEvent（实测最稳，也最快） ===
      // 实测 DOM 里内容完整但 getBoundingClientRect = 0 → isVisible=false，
      // Playwright 的 click/force click 都要先等 3s 超时再失败；
      // 直接发 MouseEvent 走 React 合成事件，600ms 就能读回结果。
      // 注意: dispatchEvent 触发后 React 是异步渲染，不能立刻检查结果
      console.log('  🖱️ dispatchEvent 点击开关...');
      await page.evaluate(() => {
        const c = document.querySelector('[data-e2e="aigc_container"] .Switch__content');
        if (!c) return;
        if (c.getAttribute('aria-checked') === 'true') return;
        c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      // ⚠️ 多读几次再判失败：原来只等 600ms 读一次，React 稍慢就误判"没触发"，
      //    接着白跑 force click(3s) + input.click(2s) 两个必失败的策略（每轮实测多花 6~8 秒）
      let r1 = '';
      for (let k = 0; k < 6; k++) {
        await page.waitForTimeout(500);
        r1 = await page.evaluate(() => {
          const c = document.querySelector('[data-e2e="aigc_container"] .Switch__content');
          return c ? c.getAttribute('aria-checked') : 'no-element';
        });
        if (r1 === 'true') break;
      }
      if (r1 === 'true') { console.log('  ✅ AI 开关已打开 (dispatchEvent)'); return; }

      // === 策略 2: JS 直接置位（最可靠，实测每次都能成） ===
      // 之所以排在 Playwright 点击之前：这个开关的中心点常被弹窗/浮层挡住，
      // force click 与 input.click 在 FoxProfile 代理下必然抛
      // `Locator.click: Element is not visible`，白等 5 秒什么也得不到。
      console.log('  ⚠️ dispatchEvent 未触发，改用 JS 强制置位...');
      const r2 = await page.evaluate(() => {
        const c = document.querySelector('[data-e2e="aigc_container"] .Switch__content');
        if (!c) return 'no-element';
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
      await page.waitForTimeout(400);
      {
        const after = await page.evaluate(() => {
          const c = document.querySelector('[data-e2e="aigc_container"] .Switch__content');
          return c ? c.getAttribute('aria-checked') : 'no-element';
        });
        if (after === 'true') { console.log(`  ✅ AI 开关已打开 (JS 置位: ${r2})`); return; }
      }

      // === 策略 3: Playwright force click（兜底，能成就成） ===
      console.log('  ⚠️ JS 置位未生效，尝试 force click...');
      try {
        await content.click({ force: true, timeout: 3000 });
        await page.waitForTimeout(500);
        let after = await content.getAttribute('aria-checked').catch(() => '');
        if (after === 'true') { console.log('  ✅ AI 开关已打开 (force click)'); return; }
      } catch (_) {}

      // === 策略 4: 点 toggle 内部的隐藏 input（force） ===
      console.log('  ⚠️ force click 未成，尝试 input.click...');
      try {
        const input = switchRoot.locator('input.Switch__input').first();
        const inputCount = await input.count().catch(() => 0);
        if (inputCount > 0) {
          // ⚠️ 这一步必须包 try/catch：FoxProfile 代理的 click 对不可见元素会直接抛
          //    `Locator.click: Element is not visible`（2026-10-18 20:38 实测把整步 trace 打成失败）
          await input.click({ force: true, timeout: 2000 });
          await page.waitForTimeout(500);
          let after = await content.getAttribute('aria-checked').catch(() => '');
          if (after === 'true') { console.log('  ✅ AI 开关已打开 (input click)'); return; }
        }
      } catch (err) {
        console.log(`  ⚠️ input.click 失败（继续下一个策略）: ${(err.message || '').split('\n')[0]}`);
      }

      // 所有策略都无效：只提示，不抛错 —— 后面的 AI 标注弹窗 Turn on 与复核还会再兜一次
      console.log('  ⚠️ AI 开关未能确认打开（等标注弹窗/复核步骤兜底）');
    }, { domQuery: '[data-e2e="aigc_container"]',
        checkSelectors: ['[data-e2e="aigc_container"] .Switch__content[aria-checked="true"]'],
        waitAfterMs: 300 });

    // 4. 处理「开关点下去之后」才冒出来的弹窗
    //    实测：第一次打开 AI 标注开关时，TikTok 会弹「Labeling AI-generated content」
    //    引导框（Not now / Turn on）。这里必须点 Turn on，不能点 Not now。
    await handleDialogs(page, { sessionPath, tag: 'after-aigc' });

    // 5. 弹窗关掉之后再复核一次开关状态：
    //    引导框弹出来的时候点开关，点击会被这层遮罩吃掉 —— 弹窗处理完必须补一次，
    //    否则「以为开了、其实没开」= 发出去的 AI 内容没有标注（可能被下架）。
    try {
      const aiState = await page.evaluate(() => {
        const c = document.querySelector('[data-e2e="aigc_container"] .Switch__content');
        if (!c) return 'no-element';
        if (c.getAttribute('aria-checked') === 'true') return 'on';
        c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return 'retried';
      });
      if (aiState === 'retried') {
        await page.waitForTimeout(600);
        const after = await page.evaluate(() => {
          const c = document.querySelector('[data-e2e="aigc_container"] .Switch__content');
          return c ? c.getAttribute('aria-checked') : 'no-element';
        });
        console.log(after === 'true'
          ? '  ✅ AI 标注开关补点成功'
          : `  ⚠️ AI 标注开关仍是 ${after}（请人工确认页面）`);
      }
    } catch (_) {}

    // 填写标题 + 标签 — 兼容 Draft.js / TikTok 2026 UI
    if (title) {
      // 中英双语正文：优先用生成阶段定稿的 描述.txt；
      // 没有的话现场拼：中文标题 + 英文标题 + 标签（保证海外用户也看得懂）。
      let fullText = captionOverride || title;
      if (!captionOverride) {
        if (titleEn && !title.includes(titleEn)) fullText += '\n' + titleEn;
        if (tags.length > 0) {
          const missingTags = tags.filter(t => !fullText.includes(t));
          if (missingTags.length > 0) {
            fullText += '\n\n' + missingTags.join(' ');
          }
        }
      }
      console.log(`  📝 填写内容: ${fullText.substring(0, 60)}...`);
      try {
        // TikTok 文案框是 Draft.js（受控富文本）。实测结论：
        //  · locator.fill() / execCommand 只改 DOM，编辑器状态不认（计数停在 0/4000）
        //  · 逐字符输入在 Camoufox(Firefox) 下会丢字，"#" 触发话题联想后丢得更狠
        //  · 系统剪贴板 + Ctrl+V 是原生粘贴，一次完整编辑，实测 43/43 字全对
        // 所以先用剪贴板粘贴，再用页面上的「已用字符数 x/4000」校验，失败才退回慢速输入。
        const { pasteCaption, typeCaptionSlowly } = await import('./clipboard.js');
        let result = await pasteCaption(page, fullText);
        if (!result.ok) {
          console.log(`  ⚠️ 剪贴板粘贴不完整 (${result.chars}/${result.want})，改慢速分段输入`);
          result = await typeCaptionSlowly(page, fullText);
        }
        if (result.ok) {
          console.log(`  ✅ 标题已填 (${result.chars}/${result.want} 字, 计数 ${result.counter})`);
        } else {
          console.log(`  ⚠️ 文案可能不完整 (${result.chars}/${result.want}, 计数 ${result.counter})，继续后续步骤`);
        }
      } catch (e) {
        console.log(`  ⚠️ 填标题失败: ${e.message}`);
      }
      // 关闭 TikTok 标签联想下拉框：填完 # 标签后 TikTok 会弹出建议列表，
      // 遮挡页面导致 Content check 和 Post 按钮点不到。
      // ⚠️ 不要无脑按 Escape：Escape 会触发 beforeunload 的
      //    「Are you sure you want to exit?」（Exit / Cancel）弹窗 ——
      //    2026-10-18 21:05 就是这么卡了 90 秒（老代码只 waitForTimeout 等它自己消失，没人点）。
      //    正确顺序：先 blur 编辑器（安全地关掉联想），必要时才 Escape，且 Escape 之后
      //    立刻用弹窗规则把可能出现的「确认退出」点成 Cancel。
      try {
        const hadSuggestion = await page.evaluate(() => {
          const el = document.activeElement;
          if (el && typeof el.blur === 'function') el.blur();
          const txt = document.body.innerText || '';
          return /Suggested|You may like|Trending/i.test(txt);
        }).catch(() => false);
        if (hadSuggestion) {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
        }
        await handleDialogs(page, { sessionPath, tag: 'after-title' });
      } catch (_) {}
    }

    // ⏳ 等待检查完成
    //
    // 旧逻辑（会卡死）：必须同时出现「音乐版权检查」「内容快速检查」且各自后面跟
    // 「未发现问题」。但 2026-10 的 Studio 页面改版后，Checks 区只剩一个
    // 「Content check lite」**可选开关**（默认关，没有结果文字），
    // 「音乐版权检查」整项消失 —— 条件永远不成立，白等 15 分钟再报错。
    //
    // 新判定（三态，宁可放过）：
    //   a) 页面上有某个检查项 → 要求它后面出现「未发现问题 / No issues found」；
    //   b) 页面上根本没有这项 → 视为该检查不存在，不需要通过；
    //   c) 兜底：Post 按钮已可用（TikTok 自己的「可发布」信号）+ 没有任何
    //      「正在检查」字样，连续两轮（约 10s）成立 → 就绪，直接发。
    console.log('  ⏳ 等待检查完成（有检查项就要"未发现问题"，没有该项则以 Post 可点为准）...');
    // 检查项在跑、但 Post 已可点时最多等多久（毫秒）。0 = 立刻发。
    const CHECKS_MAX_WAIT_MS = Number.isFinite(Number(process.env.XNOWPOST_CHECKS_WAIT))
      ? Math.max(0, Number(process.env.XNOWPOST_CHECKS_WAIT) * 1000)
      : 90000;
    let checksPassed = false;
    // 「放行」有两种：真通过 vs 等够 CHECKS_MAX_WAIT 就发。日志必须分开说，
    // 否则复盘时会以为检查正常通过（2026-10-19 22:17 实测：检查根本没跑完，
    // 日志先写「⏭️ 检查还在跑…放行」，下一行又写「✅ 检查已通过」）。
    let checksTimedOut = false;
    // 实际等了多久（毫秒）—— 超时放行时要把秒数写进日志，别让"等了多久"靠猜
    let checksWaitedMs = 0;
    let readyStreak = 0;
    let loggedShape = false;
    for (let i = 0; i < 180; i++) {  // 最长等 15 分钟（受发布总预算约束，会更早结束）
      await budgetedWait(page, 5000, deadline, '等待内容检查通过');

      let snap = null;
      try {
        snap = await page.evaluate(() => {
          const txt = document.body.innerText || '';
          const btn = document.querySelector('[data-e2e="post_video_button"]');
          return {
            txt,
            postReady:
              !!btn &&
              btn.getAttribute('data-disabled') !== 'true' &&
              btn.getAttribute('aria-disabled') !== 'true',
          };
        });
      } catch (_) {}

      if (snap) {
        const text = snap.txt || '';
        const okIdx = Math.max(text.lastIndexOf('未发现问题'), text.lastIndexOf('No issues found'));
        const musicIdx = Math.max(text.indexOf('音乐版权检查'), text.indexOf('Music copyright check'));
        const contentIdx = Math.max(text.indexOf('内容快速检查'), text.indexOf('Content check lite'));
        const checking = /正在检查|Checking your content|Checking/i.test(text);

        // 逐项判定：该项不存在 → 不需要；存在 → 必须自己后面出现"未发现问题"
        const musicOk = musicIdx < 0 || okIdx > musicIdx;
        const contentOk = contentIdx < 0 || okIdx > contentIdx;

        if (musicOk && contentOk && !checking) {
          console.log(`  ✅ 检查已通过 (约${(i + 1) * 5}秒)${musicIdx < 0 ? '（本页面无音乐检查项）' : ''}${contentIdx < 0 ? '（本页面无内容检查项）' : ''}`);
          checksWaitedMs = (i + 1) * 5000;
          checksPassed = true;
          break;
        }

        // 兜底：页面已经没有自动检查（只剩可选开关），但 TikTok 认为可以发
        if (!checking && musicIdx < 0 && okIdx < 0 && snap.postReady) {
          readyStreak++;
          if (!loggedShape) {
            loggedShape = true;
            const at = text.indexOf('Checks');
            console.log(`  ℹ️ 页面没有自动检查结果（新版 Studio），以 Post 可点为准：${text.slice(at, at + 120).replace(/\s+/g, ' ')}`);
          }
          if (readyStreak >= 2) {
            console.log(`  ✅ Post 按钮已可用且无检查进行中 (约${(i + 1) * 5}秒)，放行发布`);
            checksWaitedMs = (i + 1) * 5000;
            checksPassed = true;
            break;
          }
        } else {
          readyStreak = 0;
        }

        // 兜底 2：**检查在跑但 Post 早就可点** → 等够 CHECKS_MAX_WAIT 秒就发。
        // 实测（2026-10-18 21:03）：TikTok 的 "Content check lite" 会显示
        // "Checking in progress. This will take about 10 minutes."，而 Post 一直是可点的。
        // 死等满 15 分钟只会白烧预算/开着浏览器窗口，检查结果本身不阻塞发布
        // （真有版权问题 TikTok 服务端照样拦）。默认等 90 秒；设 XNOWPOST_CHECKS_WAIT=0 可立即发。
        if (checking && snap.postReady) {
          const waitedMs = (i + 1) * 5000;
          if (waitedMs >= CHECKS_MAX_WAIT_MS) {
            console.log(`  ⏭️ 检查还在跑但 Post 已可点（等了 ${Math.round(waitedMs / 1000)}s），放行发布（可用 XNOWPOST_CHECKS_WAIT 调）`);
            console.log('     ⚠️ 注意：这次不是"检查通过"，是超时放行 —— 点 Post 后 TikTok 可能再弹一次「Continue to post?」');
            checksPassed = true;
            checksTimedOut = true;
            checksWaitedMs = waitedMs;
            break;
          }
        }
      }

      // 每 30 秒打个进度，方便看是不是卡住了
      if ((i + 1) % 6 === 0) {
        console.log(`  ⏳ 检查中...已等 ${(i + 1) * 5} 秒`);
      }
    }
    if (!checksPassed) {
      // 等了 15 分钟还没过 → 可能卡检查或违规了
      throw new Error('检查超时（15分钟），两项"未发现问题"未全部出现，请手动检查 TikTok 页面');
    }
    // 检查后等 3s 再发，给 TikTok 留一点缓冲时间（原来 10s，配合上面的判定没必要这么久）
    console.log('  ' + releaseMessage(checksTimedOut, (checksWaitedMs || 0) / 1000));
    if (checksTimedOut) console.log('     ⚠️ ' + releaseNote(true));
    await budgetedWait(page, 3000, deadline, '发布前缓冲等待');
    console.log('  📤 开始发布...');

    // 查找并点击发布按钮 — 用 trace 记录全过程
    // ⚠️ trace.step 会吞掉异常，因此必须检查 postStep.success，
    //    否则主选择器失败会被静默忽略并误判为已发布
    // 点按钮前先做预算保护：剩余预算已不足 → 宁可不点（无副作用），
    // 也不要"点了之后被宿主超时杀掉"留下未确认状态
    assertBudget(deadline, '点击发布按钮前', { posted: false });

    // 发布前最后一遍弹窗清扫：任何遮挡发布的框（AI 标注引导/新功能引导/限流提示）都在这里解决。
    // 限流这类致命弹窗 → 直接失败并写清原因，别硬点 Post（点了也不会成功，还加重风控）。
    {
      const { actions } = await handleDialogs(page, { sessionPath, tag: 'pre-post' });
      const fatal = findFatalDialog(actions);
      if (fatal) {
        throw new Error(`发布被 TikTok 拦住：${fatal.rule}（弹窗文字: ${(fatal.text || '').slice(0, 80)}）`);
      }
    }

    // 演练模式：填完文案、开完开关后到此为止，不点发布。
    // 用于验证整条上传/填表链路而不产生真实作品（XNOWPOST_PUBLISH_DRY_RUN=1）。
    // 用专门的错误抛出，让上层计为「跳过」而不是「失败」，更不能写 .published 标记。
    if (process.env.XNOWPOST_PUBLISH_DRY_RUN === '1') {
      console.log('  🧪 演练模式：已到达发布按钮前，不点击（未产生作品）');
      try {
        const dryShot = await page.screenshot();
        if (dryShot) {
          fs.writeFileSync(path.join(sessionPath, 'dry-run.png'), dryShot);
          console.log(`  📸 演练截图: ${path.join(sessionPath, 'dry-run.png')}`);
        }
      } catch (e) {
        console.warn(`  ⚠️ 演练截图失败: ${e.message}`);
      }
      throw new Error('演练模式：未点击发布（演练结束）');
    }

    let posted = false;
    const postStep = await trace.step('点击发布按钮', async () => {
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

      console.log('  ✅ 发布按钮已找到，准备点击...');
      // 点之前先拍一张：万一发布失败，这张就是"最后一帧"画面
      if (sense) await sense.shot('before-post');
      // ⚠️ 2026-10-18 20:14 事故：弹出「Turn on automatic content checks?」框后，
      //    Playwright 认为渲染出的 Post 按钮"接收不到指针事件"（被遮罩盖住），
      //    默认 30s 超时 → `Locator.click: Timeout 30000ms exceeded` → 整轮发布失败（还重试了一次）。
      //    所以：短超时点一次 → 失败就先清弹窗 → 再点一次 → 仍失败则绕过遮挡（JS 事件 + 坐标点击）。
      //
      // 2026-10-18 22:5x 用户反馈「屏幕一直在晃/跳动」：locator.click 会先把元素
      // scrollIntoView（页面整体跳一下）。按钮本来就在视口内时没必要滚 —— 直接按坐标点。
      try {
        // ⚠️ FoxProfile 的 FoxPage 代理**没有 boundingBox()** 方法（只有 Playwright 有），
        //    直接调会抛 `btn.boundingBox is not a function` → 白走一遍"点击被拦"的兜底
        //    （2026-10-18 23:17 TK02 实测）。坐标一律用 evaluate 现算。
        const box = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }, '[data-e2e="post_video_button"]').catch(() => null);
        const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight })).catch(() => null);
        const inView = box && vp && box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.w && box.y + box.height <= vp.h;
        if (inView) {
          console.log('  🖱️ Post 已在视口内 → 按坐标点击（不滚动页面）');
          if (sense) await sense.shot('post-click');
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await btn.click({ timeout: 8000 });
        }
      } catch (clickErr) {
        console.log(`  ⚠️ 点击被拦（${(clickErr.message || '').split('\n')[0]}），先清弹窗再重点...`);
        await handleDialogs(page, { sessionPath, tag: 'pre-post-retry' });
        try {
          await btn.click({ timeout: 8000 });
        } catch (clickErr2) {
          console.log(`  ⚠️ 重点仍失败，改用 JS 事件 + 坐标点击: ${(clickErr2.message || '').split('\n')[0]}`);
          const box = await btn.boundingBox().catch(() => null);
          await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }, BTN_SELECTOR).catch(() => {});
          if (box && Number.isFinite(box.x)) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
          }
        }
      }

      // 再加 JS dispatchEvent 兜底：Playwright click 可能被透明浮层拦截
      // dispatchEvent 直接发到目标元素，绕过层叠遮挡
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }, BTN_SELECTOR);
      await page.waitForTimeout(500);

      postedYet = true;
      posted = true;
      // 点过发布后弹窗一律接受（确认发布），交给 FoxProfile 服务端策略
      await page.setDialogPolicy('post').catch(() => {});

      // 🔴 Post 按钮点击后立即写入 .published 标记
      // 不等后续 35s 等待期，防止清理失败导致重复发布
      markPublishedNow('primary');
      if (sense) await sense.shot('post-clicked');   // 点完的一帧（能看到 Post 变灰/转圈）
    }, { domQuery: '[data-e2e="post_video_button"]',
        checkSelectors: ['[data-e2e="post_video_button"]'],
        waitAfterMs: 1000 });

    if (!postStep.success) {
      console.log(`  ⚠️ 主选择器点击失败，转入兜底: ${postStep.error}`);
    }

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
          // 点过发布后弹窗一律接受（确认发布），交给 FoxProfile 服务端策略
          await page.setDialogPolicy('post').catch(() => {});
          return;
        }
        // 终极 fallback: evaluate JS 找按钮
        // ⚠️ 必须返回「是否真的点到」，否则会误判为发布成功
        const clickedByJs = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'))
            .filter(b => b.offsetWidth > 0 && !b.disabled && b.textContent.toLowerCase().includes('post'));
          if (btns.length > 0) {
            btns[btns.length - 1].click();
            return true;
          }
          return false;
        });
        if (clickedByJs) {
          posted = true;
          postedYet = true;
          await page.setDialogPolicy('post').catch(() => {});
        } else {
          console.log('  ⚠️ 兜底也没找到可点击的发布按钮');
        }
      }, { waitAfterMs: 1000 });
    }

    // 点击成功（主选择器 / 候选选择器 / JS 兜底任一路径）→ 确保标记已写入
    if (posted && !fs.existsSync(path.join(sessionPath, '.published'))) {
      markPublishedNow('post-click');
    }

    // 明确失败：一个按钮都没点到。绝不能继续往下走并写 .published，
    // 否则内容会被永久标记为已发布而实际上从未发出（静默丢内容）
    if (!posted) {
      throw new Error('发布按钮未能点击（主选择器与兜底均失败），内容未发布');
    }

    // 等待发布完成
    if (posted) {
      console.log('  ✅ 发布按钮已点击，等待 TikTok 处理...');
      console.log('  ⏳ 等待页面跳转到内容管理页...');

      // 等待页面跳转到 /content（内容管理页）
      // 如果一直没跳转（发布没触发），15s 后视为失败，保留窗口
      let navigatedToContent = false;
      // ⚠️⚠️ 点完 Post 之后**绝不能再点任何按钮**（2026-10-18 21:22 血的教训）：
      //   TikTok 点完 Post 会显示 "Posting… Cancel post" 提示条，
      //   老代码在这里做「清理未知弹窗」，把安全词 'cancel' 匹配到了
      //   「Cancel post」这个按钮上 → 一点 = 把刚发出去的视频撤回，
      //   结果页面上写 .published 但内容页 "No posts yet"，白跑一轮。
      //   这里改成**只读**：记录页面状态，不产生任何点击。
      try {
        const afterPost = await page.evaluate(() => {
          const t = (document.body.innerText || '').replace(/\s+/g, ' ');
          const d = document.querySelector('[role="dialog"]');
          return { dlg: d ? (d.innerText || '').replace(/\s+/g, ' ').slice(0, 120) : null, toast: (t.match(/Cancel post[^.]{0,40}/) || [''])[0] };
        });
        if (afterPost.dlg) console.log(`  👀 点完 Post 后页面有浮层（不点，只记录）: ${afterPost.dlg}`);
        if (afterPost.toast) console.log(`  👀 检测到发布提示: ${afterPost.toast}`);
      } catch (_) {}
      for (let i = 0; i < 30; i++) {  // 最多等 2.5 分钟（5s × 30）
        await budgetedWait(page, 5000, deadline, '等待跳转到内容管理页', { posted: true });
        const url = page.url();
        if (url.includes('/content')) {
          navigatedToContent = true;
          console.log(`  ✅ 已跳转到内容管理页 (约${(i+1)*5}秒)`);
          break;
        }
        // 如果弹出二次确认（Post 后弹出 Confirm dialog），自动接受
        // ⚠️ 必须排除「Cancel post / Discard」这类按钮：`button:has-text("Post")`
        //    会把 "Cancel post" 也算进去（2026-10-18 21:22 就是这么把发布撤掉的）。
        try {
          const confirmBtn = page.locator(
            'div[role="dialog"] button:not(:has-text("Cancel")):not(:has-text("cancel")):not(:has-text("Discard")):not(:has-text("Back")):has-text("Post"), ' +
            'div[role="dialog"] button:not(:has-text("Cancel")):not(:has-text("Discard")):has-text("Publish"), ' +
            'div[role="dialog"] button:not(:has-text("Cancel")):not(:has-text("Discard")):has-text("Confirm"), ' +
            'div[role="dialog"] button:not(:has-text("Cancel")):not(:has-text("Discard")):has-text("确认")'
          ).first();
          if (await confirmBtn.isVisible({ timeout: 500 }).catch(() => false)) {
            await confirmBtn.click();
            console.log('  📋 二次确认已点击');
          }
        } catch (_) {}
      }

      if (navigatedToContent) {
        // 已跳转到内容管理页 → 等待视频状态变为公开
        // 刚发布的视频显示 "内容审查中" + 仅自己
        // 等 "内容审查中" 消失 + "仅自己" → "所有人" → 才算真正发布成功
        // 注意：必须先确认视频已渲染（"仅自己"或"内容审查中"出现过），
        // 防止页面刚加载时 text 为空就误判为已公开
        console.log('  ⏳ 等待视频出现在内容页...');
        let videoSeen = false;
        for (let i = 0; i < 30; i++) {  // 最多等 2.5 分钟视频渲染
          await budgetedWait(page, 5000, deadline, '等待视频出现在内容页', { posted: true });
          const text = await page.evaluate(() => document.body.innerText).catch(() => '');
          if (/仅自己|所有人|内容审查中|Only me|Everyone|Under review/i.test(text)) {
            videoSeen = true;
            console.log(`  ✅ 视频已出现在内容页 (约${(i+1)*5}秒)`);
            break;
          }
        }

        if (videoSeen) {
          // 视频已确认在页面上 → 等待审查完成 + 公开
          // 先读一次再看等待（原来先等 5s 才第一次读，白等一个周期），轮询间隔 5s→3s
          console.log('  ⏳ 等待审查完成（内容审查中消失，仅自己 → 所有人）...');
          for (let i = 0; i < 200; i++) {  // 最长等 10 分钟
            const text = await page.evaluate(() => document.body.innerText).catch(() => '');
            const reviewing = /内容审查中|Under review|Checking/i.test(text);
            const onlyMe = /仅自己|Only me/i.test(text);
            const everyone = /所有人|Everyone/i.test(text);
            if (!reviewing && everyone) {
              publishSuccess = true;
              console.log(`  ✅ 审查完成，视频已公开 (约${i * 3}秒)`);
              break;
            }
            if (!reviewing && !onlyMe) {
              publishSuccess = true;
              console.log(`  ✅ 审查完成，仅自己已消失 (约${i * 3}秒)`);
              break;
            }
            // 这一轮没结果 → 等 3 秒再读（原来的写法是先等再读，白等一整个周期）
            try {
              await budgetedWait(page, 3000, deadline, '等待内容审查完成', { posted: true });
            } catch (_) { break; }
          }
          if (!publishSuccess) {
            console.log('  ⚠️ 等待审查超时（10分钟），结果未确认（窗口由 finally 统一关闭）');
          }
        } else {
          console.log('  ⚠️ 内容页未检测到视频，结果未确认');
        }
      } else {
        console.log('  ⚠️ 未跳转到内容管理页，发布可能未成功（结果未确认）');
      }
    }

    publishedUrl = page.url();
    console.log(`  📎 当前页面: ${publishedUrl}`);

    // 保存 trace
    await trace.save();

    // 已点击发布但没能确认"公开发布"：给出明确的"未确认"结论，
    // 不假装成功（.published 已在点击时写入，所以不会重复上传）
    if (!publishSuccess) {
      const reason = '已点击发布按钮，但在预算内无法确认发布结果（未确认）';
      console.log(`  ⚠️ ${reason}`);
      // 把"未确认"写进标记，便于主进程/GUI 区分"点了按钮"和"确认公开"
      markUnconfirmed(reason);
      if (typeof options.onUnconfirmed === 'function') {
        try { options.onUnconfirmed({ url: publishedUrl, reason }); } catch (_) { /* ignore */ }
      }
    }
  } catch (err) {
    // 🔴 关键修复：如果已经点击 Post（postedYet=true），
    //    后续清理失败（trace.save / page.close 等）不致命，但要如实往外抛，
    //    让调用方知道"结果未确认"（旧实现只打日志然后正常返回 = 假成功）
    if (postedYet) {
      console.log(`  ⚠️ 已点击发布，但后续步骤出错: ${err.message}`);
      markUnconfirmed(`已点击发布按钮，后续步骤出错: ${err.message}`);
      if (!(err instanceof BudgetExceededError)) {
        const wrapped = new Error(`发布已点击但结果未确认: ${err.message}`);
        wrapped.posted = true;
        wrapped.confirmed = false;
        wrapped.cause = err;
        throw wrapped;
      }
      throw err;
    }
    // 发布未完成 → 保存 trace/截图后正常抛出
    try { await trace.save(); } catch (_) {}
    try {
      await page?.screenshot({ path: path.join(screenshotDir, 'publish_error.png') });
    } catch (_) {}
    throw err;
  } finally {
    // 先停反应器 + 观察器，保证日志收尾（窗口关掉之后就读不到页面了）
    if (reactor) {
      try {
        const rs = reactor.stop();
        if (rs && rs.history && rs.history.length) {
          const okCount = rs.history.filter((h) => h.verified).length;
          console.log(`  👁️ 浮层反应器：处理 ${rs.history.length} 次（生效 ${okCount} 次，轮询 ${rs.ticks} 次）`);
        }
      } catch (_) { /* 忽略 */ }
    }
    if (sense) {
      try {
        const n = await sense.stop();
        console.log(`  👁️ 页面观察结束：${n} 条变化 → page-events.log`);
      } catch (_) { /* 忽略 */ }
    }
    // P2-13：任何出口都关闭本环境的浏览器窗口，避免窗口无限累积。
    // keepWindow/keepWindowOnFailure 时才留给人工排查。
    if (!keepWindow) {
      await closeWindow();
    } else {
      console.log('  ℹ️ keepWindowOnFailure=true → 保留浏览器窗口供人工排查');
    }
  }

  return publishedUrl;
}


