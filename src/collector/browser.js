import { chromium } from 'playwright';
import http from 'http';

const BIT_API = 'http://127.0.0.1:54345';

let browser = null;
let context = null;

/**
 * 通过比特浏览器 API 打开指定环境并返回 page
 * @param {string} envId - 比特浏览器环境 ID（数字）
 */
export async function openBitProfile(envId) {
  const wsUrl = await callBitAPI('/browser/open', { id: String(envId) });
  if (!wsUrl) {
    console.error(`❌ 比特环境 ${envId} 打开失败`);
    return null;
  }

  console.log(`  ✅ 比特环境 ${envId} 已启动`);
  browser = await chromium.connectOverCDP(wsUrl);
  const contexts = browser.contexts();
  context = contexts[0] || await browser.newContext();
  return { browser, context };
}

/**
 * 关闭当前浏览器窗口
 */
export async function closeBitProfile() {
  if (browser) {
    try { await browser.close(); } catch (_) {}
    browser = null;
    context = null;
  }
}

/**
 * 旧的 CDP 直连方式（兼容单窗口）
 */
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
    return null;
  }
}

export async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch (_) {}
    browser = null;
    context = null;
  }
}

/**
 * 调用比特浏览器本地 REST API
 */
function callBitAPI(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: '127.0.0.1',
      port: 54345,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 10000,
    };
    const req = http.request(options, (res) => {
      let respData = '';
      res.on('data', chunk => respData += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(respData);
          if (json.success && json.data?.ws) {
            resolve(json.data.ws);
          } else {
            console.error(`❌ 比特 API 返回错误: ${JSON.stringify(json)}`);
            resolve(null);
          }
        } catch (e) {
          reject(new Error(`比特 API 响应解析失败: ${respData}`));
        }
      });
    });
    req.on('error', (e) => {
      console.error(`❌ 比特 API 请求失败: ${e.message}`);
      resolve(null);
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}
