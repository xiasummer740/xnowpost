const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const ENV = '24056554bc0e479784f054c161670a53';

function callAPI(path, body) {
  return new Promise((resolve) => {
    const d = JSON.stringify(body);
    const r = http.request({ hostname: '127.0.0.1', port: 54345, path, method: 'POST',
      headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
      res => { let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(JSON.parse(data))); });
    r.on('error', () => resolve(null));
    r.write(d); r.end();
  });
}

(async () => {
  // Open browser env
  const res = await callAPI('/browser/open', { id: ENV });
  if (!res?.success) { console.log('OPEN FAIL'); process.exit(1); }
  const ws = res.data.ws;
  const b = await chromium.connectOverCDP(ws);
  const ctx = b.contexts()[0];
  const p = await ctx.newPage();

  // Go to upload page
  await p.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (p.url().includes('login')) { console.log('LOGIN NEEDED'); await b.close(); process.exit(1); }
  await p.waitForTimeout(5000);

  // Upload a test file
  const [fc] = await Promise.all([
    p.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
    p.locator('[data-e2e="select_video_button"]').click()
  ]);
  if (fc) { await fc.setFiles('output/tiktok_inspect.png'); console.log('File set'); }
  else { console.log('CHOOSER FAIL'); }

  // Wait for video processing
  for (let i = 0; i < 20; i++) {
    await p.waitForTimeout(5000);
    const ready = await p.evaluate(() =>
      document.querySelectorAll('video').length > 0 || document.querySelector('[contenteditable]')
    );
    if (ready) { console.log('VIDEO READY'); break; }
  }

  // Click 显示更多
  await p.waitForTimeout(2000);
  try {
    const el = p.getByText('显示更多', { exact: false }).first();
    if (await el.isVisible({ timeout: 2000 })) { await el.click(); console.log('EXPANDED'); }
  } catch(e) { console.log('EXPAND FAIL:', e.message); }
  await p.waitForTimeout(1500);

  // Scroll AI section into view and dump ALL elements with classes
  const html = await p.evaluate(() => {
    // Get the expanded section HTML (containing 评论/复用/AI)
    const all = document.querySelectorAll('*');
    const results = [];
    for (const el of all) {
      if (el.offsetWidth === 0) continue;
      const txt = el.textContent.trim();
      if (txt.includes('AI') || txt.includes('评论') || txt.includes('复用') || txt.includes('披露') || txt.includes('推广')) {
        const parent = el.closest('div[class]') || el.parentElement;
        if (parent) {
          results.push({
            containerClass: (parent.className || '').slice(0, 100),
            containerHTML: parent.innerHTML.slice(0, 800)
          });
          break;
        }
      }
    }
    return results;
  });

  // Also dump ALL role=switch and buttons with switch/toggle classes
  const switches = await p.evaluate(() => {
    const s = document.querySelectorAll('[role="switch"], button[class*="switch"], div[class*="switch"], label');
    return Array.from(s).filter(x => x.offsetWidth > 0).map(x => ({
      tag: x.tagName,
      role: x.getAttribute('role'),
      class: (x.className || '').slice(0, 100),
      checked: x.getAttribute('aria-checked'),
      text: x.textContent.trim().slice(0, 50),
      html: x.outerHTML.slice(0, 300)
    }));
  });

  console.log('\n=== EXPANDED SECTION ===');
  console.log(JSON.stringify(html, null, 2));
  console.log('\n=== ALL SWITCHES ===');
  console.log(JSON.stringify(switches, null, 2));

  // Save full page HTML for reference
  const fullHTML = await p.evaluate(() => document.body.innerHTML);
  fs.writeFileSync('output/tiktok_page_dump.html', fullHTML);

  await b.close();
  console.log('\nDONE - HTML dumped to output/tiktok_page_dump.html');
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
