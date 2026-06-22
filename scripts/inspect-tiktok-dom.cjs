/**
 * 检查 TikTok Studio 上传页面的 DOM 结构
 * 用法: node scripts/inspect-tiktok-dom.cjs
 */
const { chromium } = require('playwright');
const http = require('http');

const BIT_API = 'http://127.0.0.1:54345';
const ENV_ID = '24056554bc0e479784f054c161670a53';

function callBitAPI(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: '127.0.0.1', port: 54345, path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 10000,
    };
    const req = http.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { const j = JSON.parse(d); resolve(j.success && j.data?.ws ? j.data.ws : null); }
        catch(e) { reject(new Error(d)); }
      });
    });
    req.on('error', e => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

(async () => {
  console.log('🔗 打开比特环境...');
  const wsUrl = await callBitAPI('/browser/open', { id: ENV_ID });
  if (!wsUrl) { console.error('❌ 打开失败'); process.exit(1); }

  const browser = await chromium.connectOverCDP(wsUrl);
  const [page] = await browser.pages();
  if (!page) { console.error('❌ 无页面'); process.exit(1); }

  console.log('🌐 跳转到 TikTok Studio...');
  await page.goto('https://www.tiktok.com/tiktokstudio/upload', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });

  if (page.url().includes('login')) {
    console.log('❌ 需要登录！');
    await browser.close();
    process.exit(1);
  }

  console.log('✅ 已加载，当前URL:', page.url());
  await page.waitForTimeout(5000);

  // 截图
  await page.screenshot({ path: 'output/tiktok_inspect.png', fullPage: false });
  console.log('📸 截图已保存: output/tiktok_inspect.png');

  // 1. 检查所有 buttons
  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map(b => ({
      text: b.textContent.trim().substring(0, 50),
      disabled: b.disabled,
      classes: b.className.substring(0, 100),
      attrs: Array.from(b.attributes).filter(a => a.name.startsWith('data-') || a.name.startsWith('aria-')).map(a => `${a.name}="${a.value.substring(0,80)}"`),
      rect: b.getBoundingClientRect(),
    })).filter(b => b.rect.width > 0 && b.rect.height > 0);
  });
  console.log(`\n🔘 Buttons (${buttons.length}):`);
  buttons.forEach((b, i) => console.log(`  [${i}] "${b.text}" disabled=${b.disabled} ${b.attrs.join(' ')}`));

  // 2. 检查 contenteditable / 标题区域
  const editors = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[contenteditable="true"], [role="textbox"], textarea, div[contenteditable]')).map(el => ({
      tag: el.tagName,
      contenteditable: el.getAttribute('contenteditable'),
      role: el.getAttribute('role'),
      placeholder: el.getAttribute('placeholder') || '',
      'data-e2e': el.getAttribute('data-e2e') || '',
      classes: el.className.substring(0, 100),
      text: el.textContent.trim().substring(0, 60),
      rect: el.getBoundingClientRect(),
      parent: el.parentElement ? el.parentElement.tagName + (el.parentElement.getAttribute('data-e2e') ? `[data-e2e="${el.parentElement.getAttribute('data-e2e')}"]` : '') : '',
    })).filter(el => el.rect.width > 0);
  });
  console.log(`\n✏️ Editors (${editors.length}):`);
  editors.forEach((e, i) => console.log(`  [${i}] <${e.tag}> editable=${e.contenteditable} role="${e.role}" placeholder="${e.placeholder}" data-e2e="${e['data-e2e']}"`));

  // 3. 检查 input[type="file"]
  const fileInputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input[type="file"]')).map(el => ({
      accept: el.getAttribute('accept') || '',
      multiple: el.multiple,
      classes: el.className.substring(0, 100),
      rect: el.getBoundingClientRect(),
    }));
  });
  console.log(`\n📁 File inputs (${fileInputs.length}):`);
  fileInputs.forEach((f, i) => console.log(`  [${i}] accept="${f.accept}" multiple=${f.multiple}`));

  // 4. 打印整个页面的主要结构（取 body 下主要 div 的 data-e2e / class）
  const structure = await page.evaluate(() => {
    function walk(el, depth = 0) {
      if (depth > 6 || !el || el.children.length === 0) return [];
      const items = [];
      const tag = el.tagName.toLowerCase();
      const e2e = el.getAttribute('data-e2e') || '';
      const cls = (el.className || '').substring(0, 60);
      const id = el.id || '';
      if (e2e || id || (depth <= 3)) {
        items.push({ tag, e2e: e2e.substring(0,80), id: id.substring(0,40), cls: cls.substring(0,60), depth, children: el.children.length });
      }
      for (const child of el.children) {
        items.push(...walk(child, depth + 1));
      }
      return items;
    }
    return walk(document.body);
  });
  console.log(`\n🏗️ Page structure (${structure.length} nodes):`);
  structure.slice(0, 60).forEach(n => {
    const indent = '  '.repeat(Math.min(n.depth, 5));
    console.log(`${indent}<${n.tag}>${n.e2e ? ` [data-e2e="${n.e2e}"]` : ''}${n.id ? ` #${n.id}` : ''}${n.cls ? ` .${n.cls}` : ''} (${n.children} children)`);
  });

  // 5. 特定选择器测试
  const postBtnSelectors = [
    'button:has-text("Post")',
    'button:has-text("发布")',
    '[data-e2e="post-video-btn"]',
    '[data-e2e="publish-video-btn"]',
    'button:has-text("Publish")',
  ];
  console.log(`\n🎯 Post button selectors test:`);
  for (const sel of postBtnSelectors) {
    try {
      const count = await page.locator(sel).count();
      const visible = count > 0 ? await page.locator(sel).first().isVisible({ timeout: 500 }).catch(() => false) : false;
      const disabled = count > 0 ? await page.locator(sel).first().isDisabled({ timeout: 500 }).catch(() => true) : true;
      console.log(`  ${sel}: count=${count} visible=${visible} disabled=${disabled}`);
    } catch(e) {
      console.log(`  ${sel}: ERROR ${e.message.substring(0,50)}`);
    }
  }

  const captionSelectors = [
    '[contenteditable="true"]',
    '[data-e2e="caption-editor"]',
    'div[role="textbox"]',
    'textarea',
    '[placeholder*="Add"]',
    '[placeholder*="添加"]',
  ];
  console.log(`\n🎯 Caption selectors test:`);
  for (const sel of captionSelectors) {
    try {
      const count = await page.locator(sel).count();
      const visible = count > 0 ? await page.locator(sel).first().isVisible({ timeout: 500 }).catch(() => false) : false;
      console.log(`  ${sel}: count=${count} visible=${visible}`);
    } catch(e) {
      console.log(`  ${sel}: ERROR ${e.message.substring(0,50)}`);
    }
  }

  await browser.close();
  console.log('\n✅ 完成');
})().catch(err => {
  console.error('❌ 错误:', err.message);
  process.exit(1);
});
