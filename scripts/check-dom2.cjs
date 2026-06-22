const { chromium } = require('playwright');

(async () => {
  const b = await chromium.connectOverCDP('ws://127.0.0.1:61855/devtools/browser/4a5dabc6-7903-4f59-8f2f-5ef54620be1e');
  const ctx = b.contexts()[0];
  const p = await ctx.newPage();
  console.log('Navigating...');
  await p.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (p.url().includes('login')) { console.log('NEED LOGIN'); process.exit(1); }
  await p.waitForTimeout(5000);
  console.log('1. PRE-UPLOAD STATE');
  console.log('URL:', p.url());

  // Check for hidden file input
  const fi = await p.evaluate(() => {
    const els = document.querySelectorAll('input[type=file]');
    return Array.from(els).map(e => ({ accept: e.accept, multiple: e.multiple, hidden: e.offsetWidth === 0 }));
  });
  console.log('FILE_INPUTS:', JSON.stringify(fi));

  // If no file input, use the select_video_button
  if (fi.length === 0) {
    // Try clicking select_video_button, it might open a file dialog
    // Use Playwright's file chooser
    console.log('No hidden file input, trying file chooser...');
    const [fileChooser] = await Promise.all([
      p.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
      p.locator('[data-e2e="select_video_button"]').click()
    ]);
    if (fileChooser) {
      console.log('File chooser opened, setting file...');
      await fileChooser.setFiles('output/tiktok_inspect.png');
    } else {
      console.log('File chooser not triggered, trying generic input...');
      // Some sites dynamically create the input when the button is clicked
      await p.waitForTimeout(2000);
      const fi2 = await p.evaluate(() => {
        const els = document.querySelectorAll('input[type=file]');
        return Array.from(els).map(e => ({ accept: e.accept, multiple: e.multiple, hidden: e.offsetWidth === 0 }));
      });
      console.log('FILE_INPUTS after click:', JSON.stringify(fi2));
      if (fi2.length > 0) {
        await p.locator('input[type=file]').first().setInputFiles('output/tiktok_inspect.png', { force: true });
      }
    }
  } else {
    await p.locator('input[type=file]').first().setInputFiles('output/tiktok_inspect.png', { force: true });
  }

  console.log('Waiting for upload...');
  await p.waitForTimeout(10000);

  console.log('\n2. AFTER UPLOAD STATE');

  // Screenshot
  await p.screenshot({ path: 'output/tiktok_after_upload.png' });

  // Check video elements
  const vids = await p.evaluate(() => {
    return Array.from(document.querySelectorAll('video')).filter(v => v.offsetWidth > 0).map(v => ({
      duration: v.duration, w: v.videoWidth, h: v.videoHeight
    }));
  });
  console.log('VIDEOS:', JSON.stringify(vids));

  // Check all buttons
  const btns = await p.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).filter(b => b.offsetWidth > 0).map(b => ({
      t: b.textContent.trim().slice(0, 50),
      d: b.disabled,
      attrs: Array.from(b.attributes)
        .filter(a => a.name.startsWith('data-') || a.name.startsWith('aria-'))
        .map(a => a.name + '=' + a.value.slice(0, 60))
        .join(' ')
    }));
  });
  console.log('BUTTONS:', JSON.stringify(btns, null, 2));

  // Check editors / title area
  const eds = await p.evaluate(() => {
    // Check various possible title/description selectors
    const selectors = [
      '[contenteditable="true"]', '[contenteditable]',
      '[role="textbox"]', 'textarea',
      '[data-e2e*="caption"]', '[data-e2e*="description"]',
      '[data-e2e*="title"]', '[data-e2e*="editor"]',
      '[placeholder]'
    ];
    const results = [];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (el.offsetWidth > 0 || el.offsetParent !== null) {
          results.push({
            sel,
            tag: el.tagName,
            attrs: Array.from(el.attributes).map(a => a.name + '=' + a.value.slice(0, 100)).join(' '),
            text: el.textContent.trim().slice(0, 80),
            w: el.offsetWidth,
            h: el.offsetHeight
          });
        }
      }
    }
    return results;
  });
  console.log('\nEDITORS:', JSON.stringify(eds, null, 2));

  // Check div with role=dialog (if there's a dialog overlay)
  const dialogs = await p.evaluate(() => {
    return Array.from(document.querySelectorAll('[role=dialog]')).map(d => ({
      html: d.innerHTML.slice(0, 500),
      attrs: Array.from(d.attributes).map(a => a.name + '=' + a.value).join(' ')
    }));
  });
  if (dialogs.length > 0) {
    console.log('\nDIALOGS:', JSON.stringify(dialogs, null, 2));
  }

  await p.close();
  await b.close();
  console.log('\nDone');
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
