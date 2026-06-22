const { chromium } = require('playwright');

(async () => {
  const b = await chromium.connectOverCDP('ws://127.0.0.1:61855/devtools/browser/4a5dabc6-7903-4f59-8f2f-5ef54620be1e');
  const ctx = b.contexts()[0];
  const p = await ctx.newPage();
  console.log('Navigating...');
  await p.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (p.url().includes('login')) { console.log('NEED LOGIN'); process.exit(1); }
  await p.waitForTimeout(5000);
  console.log('URL:', p.url());

  const btns = await p.evaluate(() =>
    Array.from(document.querySelectorAll('button')).filter(b => b.offsetWidth > 0).map(b => ({
      t: b.textContent.trim().slice(0, 60),
      d: b.disabled,
      attrs: Array.from(b.attributes).filter(a => a.name.startsWith('data-') || a.name.startsWith('aria-')).map(a => a.name + '=' + a.value.slice(0, 80)).join(' ')
    }))
  );
  console.log('BUTTONS:', JSON.stringify(btns, null, 2));

  const eds = await p.evaluate(() =>
    Array.from(document.querySelectorAll('[contenteditable],[role=textbox],textarea')).filter(e => e.offsetWidth > 0).map(e => ({
      t: e.tagName, ce: e.contentEditable, role: e.getAttribute('role'),
      ph: e.getAttribute('placeholder') || '', e2e: e.getAttribute('data-e2e') || '',
      cls: e.className.slice(0, 80)
    }))
  );
  console.log('EDITORS:', JSON.stringify(eds, null, 2));

  await p.screenshot({ path: 'output/tiktok_inspect.png' });
  console.log('Screenshot saved');
  await p.close();
  await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
