import { test, describe } from 'node:test';
import assert from 'node:assert';
import { checkSensitive, scrubSensitive } from '../../src/engine/text.js';
import { getContentPolicy } from '../../src/engine/config.js';

describe('合规策略：不发布价格等敏感信息', () => {
  test('默认开启价格/联系方式/承诺过滤', () => {
    const p = getContentPolicy();
    assert.equal(p.noPrice, true);
    assert.equal(p.noContact, true);
    assert.equal(p.noPromise, true);
  });

  test('识别货币金额', () => {
    assert.ok(checkSensitive('TikTok千粉只要¥13').includes('价格/优惠'));
    assert.ok(checkSensitive('播放千次0.12元').includes('价格/优惠'));
  });

  test('识别价格类措辞', () => {
    assert.ok(checkSensitive('全网最低价不是说说而已').includes('价格/优惠'));
    assert.ok(checkSensitive('限时优惠，无脑入').includes('价格/优惠'));
  });

  test('识别联系方式', () => {
    assert.ok(checkSensitive('加微信 abc12345').includes('联系方式'));
    assert.ok(checkSensitive('https://xnow.taikon.top').includes('联系方式'));
  });

  test('识别硬承诺', () => {
    assert.ok(checkSensitive('3天从87粉冲到1万').includes('涨粉承诺'));
  });

  test('正常文案不误伤', () => {
    assert.deepEqual(checkSensitive('30秒注册，不用账号密码，掉了自动补'), []);
    assert.deepEqual(checkSensitive('精选服务100%可用，稳定不掉'), []);
    assert.deepEqual(checkSensitive('支持TikTok、Instagram、YouTube多平台'), []);
  });

  test('清洗：含价格的分句被摘掉，其余保留', () => {
    const out = scrubSensitive('精选服务100%可用，无脑入。千粉只要¥13，全网最低价。');
    assert.ok(!out.includes('¥'), `仍含价格: ${out}`);
    assert.ok(out.includes('100%可用'), `误删了正常内容: ${out}`);
  });

  test('清洗：整句都是价格时返回空串', () => {
    assert.equal(scrubSensitive('千粉¥13'), '');
  });

  test('清洗：联系方式被摘掉', () => {
    const out = scrubSensitive('有需要加微信 abc88888。服务稳定不掉线。');
    assert.ok(!/微信|abc88888/.test(out), `仍含联系方式: ${out}`);
    assert.ok(out.includes('服务稳定'), `误删了正常内容: ${out}`);
  });
});
