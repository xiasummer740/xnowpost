// XNOWPost TikTok 文本解析器单元测试
// 验证 extractNum + extractPureNum + 双向扫描逻辑
// 运行: node --test tests/unit/tiktok-parser.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert';

// === 从 tiktok.js 的 page.evaluate 中提取的纯函数（无 Puppeteer 依赖） ===

function extractNum(str) {
  const m = str.match(/(-?[\d,]+\.?\d*)\s*([KkMm万]?)/);
  if (!m) return null;
  let num = parseFloat(m[1].replace(/,/g, ''));
  const suffix = m[2];
  if (suffix === 'K' || suffix === 'k') num *= 1000;
  else if (suffix === 'M' || suffix === 'm') num *= 1000000;
  else if (suffix === '万') num *= 10000;
  return Math.round(num);
}

function extractPureNum(str) {
  const m = str.match(/^([\d,]+\.?\d*)\s*([KkMm万]?)$/);
  if (!m) return null;
  let num = parseFloat(m[1].replace(/,/g, ''));
  const suffix = m[2];
  if (suffix === 'K' || suffix === 'k') num *= 1000;
  else if (suffix === 'M' || suffix === 'm') num *= 1000000;
  else if (suffix === '万') num *= 10000;
  return Math.round(num);
}

const METRICS = {
  followers: ['Followers', '粉丝数', '关注者'],
  'video views': ['Video views', '视频播放', '播放量'],
  'profile views': ['Profile views', '主页访问', '主页浏览'],
  likes: ['Likes', '点赞数', '获赞'],
  comments: ['Comments', '评论数'],
  shares: ['Shares', '分享数', '转发'],
};

function getMatchedKeyword(line) {
  const lc = line.toLowerCase();
  for (const [key, keywords] of Object.entries(METRICS)) {
    if (keywords.some(kw => {
      const klc = kw.toLowerCase();
      return lc === klc || lc.startsWith(klc + ' ') || lc.startsWith(klc);
    })) return key;
  }
  return null;
}

function parseTikTokText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const found = {};

  // 检测页面布局
  let numFirstCount = 0, labelFirstCount = 0;
  for (let i = 1; i < lines.length; i++) {
    if (extractNum(lines[i - 1]) !== null && getMatchedKeyword(lines[i]) !== null) numFirstCount++;
    if (getMatchedKeyword(lines[i - 1]) !== null && extractNum(lines[i]) !== null) labelFirstCount++;
  }
  const useNumFirst = numFirstCount >= labelFirstCount;

  // 扫描：从有数值的行出发
  for (let i = 0; i < lines.length; i++) {
    const numVal = extractNum(lines[i]);
    if (numVal === null) continue;

    const sameLineKw = getMatchedKeyword(lines[i]);
    if (sameLineKw) {
      found[sameLineKw] = found[sameLineKw] !== undefined ? Math.max(found[sameLineKw], numVal) : numVal;
      continue;
    }

    const adjIdx = useNumFirst ? i + 1 : i - 1;
    if (adjIdx >= 0 && adjIdx < lines.length) {
      const adjKw = getMatchedKeyword(lines[adjIdx]);
      if (adjKw) {
        found[adjKw] = found[adjKw] !== undefined ? Math.max(found[adjKw], numVal) : numVal;
      }
    }
  }

  return found;
}

// === 测试 ===

describe('extractNum', () => {
  it('纯数字', () => {
    assert.equal(extractNum('1234'), 1234);
  });
  it('K 后缀', () => {
    assert.equal(extractNum('12.5K'), 12500);
    assert.equal(extractNum('1.2k'), 1200);
  });
  it('M 后缀', () => {
    assert.equal(extractNum('1.5M'), 1500000);
  });
  it('万 后缀', () => {
    assert.equal(extractNum('12.5万'), 125000);
  });
  it('混合文本提取', () => {
    assert.equal(extractNum('Followers 12.5K'), 12500);
    assert.equal(extractNum('播放量 1,234'), 1234);
  });
  it('无数字返回 null', () => {
    assert.equal(extractNum('Followers'), null);
    assert.equal(extractNum('Hello World'), null);
  });
});

describe('extractPureNum', () => {
  it('纯数字行匹配', () => {
    assert.equal(extractPureNum('1234'), 1234);
    assert.equal(extractPureNum('12.5K'), 12500);
    assert.equal(extractPureNum('1,234'), 1234);
  });
  it('混合文本不匹配', () => {
    assert.equal(extractPureNum('Followers 1'), null);
    assert.equal(extractPureNum('播放量 1000'), null);
  });
  it('纯文本不匹配', () => {
    assert.equal(extractPureNum('Followers'), null);
    assert.equal(extractPureNum('Hello'), null);
  });
});

describe('parseTikTokText — 数字在标签前（TikTok Studio 常见布局）', () => {
  const text = `12.5K
Followers
89.3K
Video Views
1,234
Likes
567
Comments
89
Shares`;

  it('正确解析全部指标', () => {
    const r = parseTikTokText(text);
    assert.equal(r.followers, 12500);
    assert.equal(r['video views'], 89300);
    assert.equal(r.likes, 1234);
    assert.equal(r.comments, 567);
    assert.equal(r.shares, 89);
  });
});

describe('parseTikTokText — 数字在标签后（传统布局）', () => {
  const text = `Followers
12.5K
Video Views
89.3K
Likes
1,234
Comments
567
Shares
89`;

  it('正确解析全部指标', () => {
    const r = parseTikTokText(text);
    assert.equal(r.followers, 12500);
    assert.equal(r['video views'], 89300);
    assert.equal(r.likes, 1234);
    assert.equal(r.comments, 567);
    assert.equal(r.shares, 89);
  });
});

describe('parseTikTokText — 同行数字', () => {
  const text = `Followers 12.5K
Video Views 89.3K
Likes 1,234
Comments 567
Shares 89`;

  it('正确解析全部指标', () => {
    const r = parseTikTokText(text);
    assert.equal(r.followers, 12500);
    assert.equal(r['video views'], 89300);
    assert.equal(r.likes, 1234);
    assert.equal(r.comments, 567);
    assert.equal(r.shares, 89);
  });
});

describe('parseTikTokText — 防止"1"误匹配（核心bug修复）', () => {
  const text = `Dashboard
Content
Followers
1
Followers
12.5K
Following
56`;

  it('忽略首次误匹配，取较大值 12.5K', () => {
    const r = parseTikTokText(text);
    assert.equal(r.followers, 12500);
  });

  it('页面有数量1但不吞掉', () => {
    // "1" 不应被当作 followers 的最终值
    const r = parseTikTokText(text);
    assert.notEqual(r.followers, 1);
    assert.equal(r.followers, 12500);
  });
});

describe('parseTikTokText — 混合中英文', () => {
  const text = `12.5K
粉丝数
89.3K
播放量
1,234
点赞数`;

  it('中文关键词同样工作', () => {
    const r = parseTikTokText(text);
    assert.equal(r.followers, 12500);
    assert.equal(r['video views'], 89300);
    assert.equal(r.likes, 1234);
  });
});

describe('parseTikTokText — 复杂页面含干扰项', () => {
  const text = `TikTok Studio
Creator Center
Overview
Content
Dashboard
12.5K
Followers
89.3K
Video Views
1,234
Likes
567
Comments
89
Shares
Last 7 days
vs previous 7 days`;

  it('过滤页面噪音正确解析', () => {
    const r = parseTikTokText(text);
    assert.equal(r.followers, 12500);
    assert.equal(r['video views'], 89300);
    assert.equal(r.likes, 1234);
    assert.equal(r.comments, 567);
    assert.equal(r.shares, 89);
  });
});

describe('parseTikTokText — 空/无匹配', () => {
  it('空文本', () => {
    assert.deepEqual(parseTikTokText(''), {});
  });

  it('无关文本', () => {
    assert.deepEqual(parseTikTokText('Hello\nWorld\nTest'), {});
  });
});
