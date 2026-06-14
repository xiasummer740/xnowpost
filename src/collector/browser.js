import { chromium } from 'playwright';

let browser = null;
let context = null;

export async function connectBrowser() {
  const cdpEndpoint = process.env.CDP_ENDPOINT || 'http://localhost:9222';

  try {
    browser = await chromium.connectOverCDP(cdpEndpoint);
    console.log('✅ 已连接指纹浏览器');

    const contexts = browser.contexts();
    context = contexts[0] || await browser.newContext();

    return { browser, context };
  } catch (err) {
    console.error('❌ 无法连接指纹浏览器:', err.message);
    console.error('   请确保指纹浏览器已启动且 CDP 端口为', cdpEndpoint);
    return null;
  }
}

export async function getPage() {
  if (!context) {
    const result = await connectBrowser();
    if (!result) return null;
  }
  return await context.newPage();
}

export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    context = null;
  }
}
