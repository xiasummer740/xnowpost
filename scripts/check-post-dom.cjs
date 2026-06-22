const { chromium } = require('playwright');

(async () => {
  const WS = 'ws://127.0.0.1:54482/devtools/browser/02e02923-dd3a-4602-9024-e8d2ad764e4b';
  const b = await chromium.connectOverCDP(WS);
  const ctx = b.contexts()[0];
  const p = await ctx.newPage();
  await p.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (p.url().includes('login')) { console.log('NEED LOGIN'); process.exit(1); }
  await p.waitForTimeout(3000);

  // Check file inputs
  const fi = await p.evaluate(() => document.querySelectorAll('input[type=file]').length);
  console.log('FILE_INPUTS:', fi);

  // Try file chooser approach
  console.log('Clicking select_video_button...');
  const [fc] = await Promise.all([
    p.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
    p.locator('[data-e2e="select_video_button"]').click()
  ]);
  if (fc) { await fc.setFiles('output/tiktok_inspect.png'); console.log('File set via chooser'); }
  else {
    await p.locator('input[type=file]').first().setInputFiles('output/tiktok_inspect.png', { force: true }).catch(e => console.log('setInputFiles err:', e.message));
  }

  // Wait for video processing
  console.log('Waiting...');
  for (let i = 0; i < 12; i++) {
    await p.waitForTimeout(5000);
    const ready = await p.evaluate(() => {
      const v = document.querySelectorAll('video');
      return v.length > 0 && Array.from(v).some(x => x.duration > 0);
    });
    if (ready) { console.log('READY after', (i + 1) * 5, 's'); break; }
  }
  await p.waitForTimeout(3000);
  await p.screenshot({ path: 'output/tiktok_post_upload.png' });

  // Get ALL visible buttons + their full HTML
  const data = await p.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetWidth > 0).map(b => ({
      t: b.textContent.trim().slice(0, 80),
      d: b.disabled,
      html: b.outerHTML.slice(0, 500),
      w: b.offsetWidth, h: b.offsetHeight
    }));
    const editors = [];
    document.querySelectorAll('[contenteditable], [role="textbox"], textarea, [data-e2e]').forEach(e => {
      if (e.offsetWidth > 0) {
        editors.push({
          tag: e.tagName,
          html: e.outerHTML.slice(0, 400),
          ph: e.getAttribute('placeholder') || '',
          e2e: e.getAttribute('data-e2e') || '',
          role: e.getAttribute('role') || '',
          text: e.textContent.trim().slice(0, 80)
        });
      }
    });
    // Post/Publish related buttons specifically
    const postBtns = btns.filter(b => {
      const t = b.t.toLowerCase();
      const h = b.html.toLowerCase();
      return t.includes('post') || t.includes('发布') || t.includes('publish') || t.includes('提交') || h.includes('post') || h.includes('publish');
    });
    return { btns, editors, postBtns };
  });

  console.log('\n=== ALL BUTTONS ===');
  data.btns.forEach((b, i) => console.log(`[${i}] "${b.t}" disabled=${b.d} w=${b.w} h=${b.h}`));

  console.log('\n=== POST/PUBLISH BUTTONS ===');
  data.postBtns.forEach((b, i) => console.log(`[${i}] "${b.t}" disabled=${b.d}`));
  if (data.postBtns.length === 0) console.log('NONE FOUND');

  console.log('\n=== EDITORS/CAPTION ===');
  data.editors.forEach((e, i) => console.log(`[${i}] <${e.tag}> e2e="${e.e2e}" ph="${e.ph}" role="${e.role}"`));
  if (data.editors.length === 0) console.log('NONE FOUND');

  // Don't close - just disconnect
  await b.disconnect();
  console.log('\nDone - browser kept alive');
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
