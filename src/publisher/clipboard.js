/**
 * 往富文本编辑器里整段写字（TikTok 文案框是 Draft.js）
 *
 * 为什么这么绕：
 *  · locator.fill() / execCommand('insertText') 只改 DOM，Draft.js 状态不认（计数还是 0/4000）
 *  · pressSequentially 逐字符输入在 Camoufox(Firefox) 下会丢字，尤其是 "#" 触发话题联想后
 *  · 一次性事件 insertText 在 Firefox 无效
 * 所以走「系统剪贴板 + Ctrl+V」：一次原生粘贴，编辑器当一次完整编辑，不丢字。
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const norm = (s) => String(s || '').replace(/\s+/g, '');

/** 把文本写进 Windows 剪贴板（Set-Clipboard，不弹窗） */
export function setClipboard(text) {
  const tmp = path.join(os.tmpdir(), `xnowpost-clip-${process.pid}.txt`);
  fs.writeFileSync(tmp, String(text), 'utf8');
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 '${tmp.replace(/'/g, "''")}')`,
    ], { windowsHide: true, stdio: 'ignore' });
    ps.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (_) {} reject(e); });
    ps.on('close', (code) => {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (code === 0) resolve();
      else reject(new Error(`Set-Clipboard 退出码 ${code}`));
    });
  });
}

/** 读回编辑器状态：可见文案框的文字 + 页面上的「已用字符 x/4000」 */
export async function readCaptionState(page) {
  return page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .filter((e) => e.getBoundingClientRect().height > 0);
    const m = (document.body.innerText || '').match(/(\d+)\s*\/\s*4000/);
    return {
      counter: m ? Number(m[1]) : -1,
      text: boxes.map((b) => b.innerText).join(''),
    };
  });
}

/** 把焦点放到可见的文案框里（JS 点击，绕开遮挡层） */
async function focusEditor(page) {
  return page.evaluate(() => {
    const box = Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .filter((e) => e.getBoundingClientRect().height > 0)[0];
    if (!box) return 'no-box';
    box.click();
    box.focus();
    return document.activeElement === box ? 'focused' : 'no-focus';
  });
}

/**
 * 用剪贴板把 text 整段粘贴进编辑器
 * @returns {{ok: boolean, chars: number, want: number, counter: number, text: string, reason?: string}}
 */
export async function pasteCaption(page, text) {
  const want = norm(text).length;
  const focus = await focusEditor(page);
  if (focus !== 'focused') {
    return { ok: false, chars: 0, want, counter: -1, text: '', reason: focus };
  }
  // 清空原有内容（TikTok 有时会预填文件名）
  await page.keyboard.press('Control+A');
  await page.waitForTimeout(150);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(400);

  await setClipboard(text);
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(1500);

  const state = await readCaptionState(page);
  const chars = norm(state.text).length;
  return {
    ok: chars >= want * 0.95,
    chars,
    want,
    counter: state.counter,
    text: state.text,
  };
}

/**
 * 分段慢速输入（剪贴板失败时的兜底）
 * 每段结束后按 Esc 关掉 "#" 触发的话题联想框，否则后续字符会被下拉框吃掉。
 */
export async function typeCaptionSlowly(page, text) {
  const want = norm(text).length;
  await focusEditor(page);
  await page.keyboard.press('Control+A');
  await page.waitForTimeout(150);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(400);

  for (const seg of String(text).split(/(\s+)/).filter(Boolean)) {
    if (/^\s+$/.test(seg)) {
      await page.keyboard.press('Space');
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      continue;
    }
    await page.keyboard.type(seg[0] || '', { delay: 100 });
    await page.waitForTimeout(250);
    if (seg.length > 1) await page.keyboard.type(seg.slice(1), { delay: 90 });
    await page.waitForTimeout(250);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(1000);
  const state = await readCaptionState(page);
  const chars = norm(state.text).length;
  return { ok: chars >= want * 0.95, chars, want, counter: state.counter, text: state.text };
}
