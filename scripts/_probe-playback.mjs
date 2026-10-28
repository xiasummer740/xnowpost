/**
 * 只读探针 2：TikTok 视频为什么播不了（这决定"刷视频养号"能不能做）。
 *
 * 查三件事：
 *  ① 浏览器支不支持 H.264 / MP4（`canPlayType`）—— Camoufox 是 Firefox 内核，可能缺专有编解码器；
 *  ② 具体视频页里到底有没有 <video> 元素、能不能播；
 *  ③ For You 卡片内部的报错结构（是被拦、缺编解码器、还是只是需要点一下）。
 *
 * 用法：node scripts/_probe-playback.mjs TK01
 */
import { openFoxProfile, closeFoxProfile } from '../src/collector/foxprofile.js';

const BASE = process.env.FOXPROFILE_API || 'http://127.0.0.1:8000/api/v1';
const ENV = (process.argv[2] || 'TK01').toUpperCase();

const CODECS = () => {
  const types = [
    'video/mp4; codecs="avc1.42E01E"',
    'video/mp4; codecs="avc1.4d401f"',
    'video/mp4',
    'video/webm; codecs="vp9"',
    'video/webm',
    'audio/mp4; codecs="mp4a.40.2"',
  ];
  const out = {};
  for (const t of types) out[t] = document.createElement('video').canPlayType(t) || 'no';
  return {
    codecs: out,
    mediaSource: typeof window.MediaSource !== 'undefined',
    mseH264: window.MediaSource && MediaSource.isTypeSupported
      ? MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')
      : null,
    ua: navigator.userAgent,
  };
};

const CARD = () => {
  const card = document.querySelector('[data-e2e="recommend-list-item-container"]');
  const vids = [...document.querySelectorAll('video')].map((v) => ({
    paused: v.paused, muted: v.muted, t: Math.round(v.currentTime * 10) / 10,
    duration: Number.isFinite(v.duration) ? v.duration : null,
    readyState: v.readyState, errorCode: v.error ? v.error.code : null,
    errMsg: v.error ? String(v.error.message || '') : null,
  }));
  return {
    cardText: card ? (card.innerText || '').replace(/\s+/g, ' ').slice(0, 200) : null,
    cardHTML: card ? card.innerHTML.replace(/\s+/g, ' ').slice(0, 700) : null,
    videoCount: vids.length,
    vids,
    playButtons: [...document.querySelectorAll('[data-e2e*="play"], button[aria-label*="lay"]')]
      .map((e) => ({ e2e: e.getAttribute('data-e2e'), aria: e.getAttribute('aria-label') })),
  };
};

const VIDEO_PAGE = () => {
  const v = document.querySelector('video');
  return {
    url: location.href,
    hasVideo: !!v,
    state: v ? {
      paused: v.paused, muted: v.muted, t: Math.round(v.currentTime * 10) / 10,
      duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
      readyState: v.readyState,
      errCode: v.error ? v.error.code : null,
      errMsg: v.error ? String(v.error.message || '') : null,
      src: String(v.currentSrc || '').slice(0, 80),
    } : null,
    bodyHead: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
  };
};

async function main() {
  console.log(`  ═══ 播放能力探针 ${ENV} ═══`);
  const { page } = await openFoxProfile(ENV, BASE);
  try {
    await page.goto('https://www.tiktok.com/foryou?lang=en', { waitUntil: 'commit' });
    await page.waitForTimeout(9000);
    console.log('\n  ── 编解码器支持 ──');
    console.log('  ' + JSON.stringify(await page.evaluate(CODECS), null, 1).replace(/\n/g, '\n  '));
    console.log('\n  ── For You 卡片内部 ──');
    const c = await page.evaluate(CARD);
    console.log('  卡片文字:', c.cardText);
    console.log('  video 数:', c.videoCount, '| 播放按钮:', JSON.stringify(c.playButtons));
    if (c.videoCount) console.log('  video 状态:', JSON.stringify(c.vids));
    console.log('  卡片 HTML:', (c.cardHTML || '').slice(0, 500));

    // 换到具体视频页：官方账号的一条老视频
    console.log('\n  ── 具体视频页 ──');
    await page.goto('https://www.tiktok.com/@tiktok/video/7106594312292453675?lang=en', { waitUntil: 'commit' });
    await page.waitForTimeout(9000);
    const v1 = await page.evaluate(VIDEO_PAGE);
    console.log('  ' + JSON.stringify(v1, null, 1).replace(/\n/g, '\n  '));
    await page.waitForTimeout(4000);
    const v2 = await page.evaluate(VIDEO_PAGE);
    console.log('\n  ── 4 秒后（看 currentTime 有没有前进）──');
    console.log('  ' + JSON.stringify(v2.state, null, 1).replace(/\n/g, '\n  '));
  } finally {
    await closeFoxProfile(ENV, BASE);
  }
}

main().catch((e) => {
  console.log('  ❌ 探针失败:', e.message);
  process.exitCode = 1;
});
