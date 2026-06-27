import { chromium } from 'playwright';
import http from 'http';

const BIT_API = 'http://127.0.0.1:54345';

let browser = null;
let context = null;

/**
 * 通过比特浏览器 API 打开指定环境并返回 page
 * @param {string} envId - 比特浏览器环境 ID（数字）
 * @param {string} [apiKey] - 比特 API 密钥（可选，默认从环境变量读取）
 */
export async function openBitProfile(envId, apiKey) {
  const key = apiKey || process.env.BIT_API_KEY || '';
  // 环境 ID 和 API Key 相同时不传 key，防止 API 混淆
  const body = { id: String(envId) };
  if (key && key !== String(envId)) body.key = key;
  const wsUrl = await callBitAPI('/browser/open', body, '');
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
 * 关闭当前浏览器窗口并调用比特 API 关闭环境
 * @param {string} [envId] - 比特环境 ID，传此参数会额外调 API 关闭浏览器窗口
 */
export async function closeBitProfile(envId) {
  if (browser) {
    try { await browser.close(); } catch (_) {}
    browser = null;
    context = null;
  }
  // 调用比特 API 关闭浏览器窗口，防止多个闹钟累积窗口
  if (envId) {
    try {
      await callBitAPI('/browser/close', { id: String(envId) }, '', false);
      console.log(`  ✅ 比特环境 ${envId} 窗口已关闭`);
    } catch (e) {
      console.warn(`  ⚠️ 关闭比特环境 ${envId} 失败: ${e.message}`);
    }
  }
}

/**
 * 关闭所有比特浏览器窗口（采集前清理残留窗口，防止堆积）
 * @param {string} [apiKey] - 比特 API 密钥
 */
export async function closeAllBitProfiles(apiKey) {
  // 1. 关闭本地 Playwright 连接
  if (browser) {
    try { await browser.close(); } catch (_) {}
    browser = null;
    context = null;
  }

  // 2. 尝试调用比特 API 关闭所有窗口
  const key = apiKey || process.env.BIT_API_KEY || '';
  try {
    // 先尝试 /browser/closeAll（如果比特支持）
    await callBitAPI('/browser/closeAll', {}, key, false);
    console.log('  ✅ 已请求关闭所有比特窗口');
  } catch (_) {
    // /browser/closeAll 可能不存在，尝试 /browser/list 获取窗口列表
    try {
      const listResult = await new Promise((resolve) => {
        const data = JSON.stringify(key ? { key } : {});
        const req = http.request({
          hostname: '127.0.0.1', port: 54345, path: '/browser/list',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          timeout: 5000,
        }, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(data);
        req.end();
      });

      if (listResult?.success && Array.isArray(listResult.data)) {
        const ids = listResult.data.map(b => b.id).filter(Boolean);
        if (ids.length > 0) {
          console.log(`  🧹 发现 ${ids.length} 个残留窗口，正在关闭...`);
          await Promise.allSettled(ids.map(id =>
            callBitAPI('/browser/close', { id: String(id) }, key, false)
          ));
          console.log(`  ✅ 已关闭 ${ids.length} 个残留窗口`);
        }
      }
    } catch (_) {}
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
 * @param {string} path - API 路径
 * @param {object} body - 请求体
 * @param {string} [apiKey] - API 密钥（可选）
 */
function callBitAPI(path, body, apiKey, requireWs = true) {
  if (apiKey) body.key = apiKey;
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
          if (requireWs) {
            // /browser/open → 需返回 {success:true, data:{ws:"..."}}
            if (json.success && json.data?.ws) {
              resolve(json.data.ws);
            } else {
              console.error(`❌ 比特 API 返回错误: ${JSON.stringify(json)}`);
              resolve(null);
            }
          } else {
            // /browser/close → 只需 success=true，data 可能是字符串"操作成功"
            resolve(json.success ? true : null);
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
