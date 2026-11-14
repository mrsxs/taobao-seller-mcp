// 「遇到安全验证就停」相关：识别、冷却（跨进程）、不吞掉验证错误、不换接口重试、请求一个接一个发
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CooldownError, createCooldown, isVerifyError, optional } from '../lib/cooldown.mjs';
import { cleanUrl, parsePriceBands, resolveAttributes } from '../lib/market.mjs';
import { mtopFetch } from '../lib/mtop-fetch.mjs';
import { createQnMtop, listOrders, listProducts, QnError } from '../lib/qn.mjs';
import { monitoredShops, parseCoreTrend, parseLossTargets, shopCompare } from '../lib/rival.mjs';
import { explainHtml, productAnalysis, storeOverview, SycmError } from '../lib/sycm.mjs';

const VERIFY_SYCM = '触发了淘宝安全验证（滑块 / 验证码），请在紫鸟店铺浏览器里打开生意参谋手动完成验证后再试，不要反复重试';
const range = { period: 'recent7', start: '2026-11-07', end: '2026-11-13' };

test('optional：普通失败换成兜底值，安全验证照样抛出', async () => {
  assert.deepEqual(await optional(Promise.reject(new Error('挂了')), (e) => ({ error: e.message })), { error: '挂了' });
  assert.equal(await optional(Promise.reject(new Error('x')), null), null);
  await assert.rejects(optional(Promise.reject(new SycmError(VERIFY_SYCM)), null), (e) => isVerifyError(e));
});

test('冷却写在数据目录里，另一个进程（另一个实例）也能看到', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsm-cd-'));
  try {
    let t = 1000;
    const a = createCooldown({ dir, now: () => t });
    const b = createCooldown({ dir, now: () => t });
    const shop = { storeId: '1', name: '甲店' };
    b.check(shop);
    a.note(shop, new SycmError(VERIFY_SYCM));
    assert.throws(() => b.check(shop), CooldownError);
    t += 10 * 60_000;
    b.check(shop);
    // 文件坏了不影响：当没有冷却
    createCooldown({ dir: join(dir, 'nope'), now: () => t }).check(shop);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('竞店对比：请求一个接一个发；动态接口触发验证时整个调用失败（不吞掉）', async () => {
  const rivals = [{ name: '甲', userId: 'ENC_A' }, { name: '乙', userId: 'ENC_B' }];
  const seen = [];
  const get = async (path) => {
    seen.push(path);
    if (path.includes('summary')) throw new SycmError(VERIFY_SYCM);
    if (path.includes('getTopItems')) return [];
    return {};
  };
  await assert.rejects(shopCompare(get, range, rivals), (e) => isVerifyError(e));
  // 第一家竞店的动态触发验证后，第二家竞店不再请求
  assert.deepEqual(seen.map((p) => p.split('/').pop()), ['getCoreIndexes.json', 'getCoreTrend.json', 'page.json', 'summary.json']);

  // 普通失败只是 news 为空
  const ok = await shopCompare(async (path) => {
    if (path.includes('summary')) throw new SycmError('生意参谋接口失败（x）：系统出错');
    return path.includes('getTopItems') ? [] : {};
  }, range, rivals);
  assert.deepEqual(ok.rivals.map((r) => r.news), [null, null]);
});

test('店铺概况 / 单品分析：请求一个接一个发；推广数据触发验证时整个调用失败', async () => {
  const seen = [];
  const get = async (path) => {
    seen.push(path);
    if (path.includes('grow/factor')) throw new SycmError(VERIFY_SYCM);
    return {};
  };
  await assert.rejects(storeOverview(get, { period: 'day', start: '2026-11-13', end: '2026-11-13' }), (e) => isVerifyError(e));
  assert.equal(seen.some((p) => p.includes('coreIndex')), false);
  // 推广数据普通失败只是标出来
  const ok = await storeOverview(async (path) => { if (path.includes('grow/factor')) throw new Error('没权限'); return {}; }, range);
  assert.match(ok.promotion.error, /没权限/);

  seen.length = 0;
  const blocked = async (path) => { seen.push(path); throw new SycmError(VERIFY_SYCM); };
  await assert.rejects(productAnalysis(blocked, range, '100000000012', { sections: ['overview', 'skus', 'sources'] }), (e) => isVerifyError(e));
  assert.equal(seen.length, 1);
});

test('千牛：商品接口触发验证时不换淘宝接口再试；订单页分清验证和登录', async () => {
  const calls = [];
  const call = async (api) => { calls.push(api); throw new QnError('触发了淘宝安全验证，请在紫鸟店铺浏览器里打开千牛手动完成验证后重试'); };
  await assert.rejects(listProducts(call, {}), (e) => isVerifyError(e));
  assert.deepEqual(calls, ['mtop.tmall.sell.pc.manage.async']);

  const page = (url, text) => async () => ({ status: 200, url, text });
  await assert.rejects(listOrders({}, {}, page('https://trade.taobao.com/x', '<html>_____tmd_____/punish</html>')), (e) => isVerifyError(e));
  await assert.rejects(listOrders({}, {}, page('https://login.taobao.com/member/login.jhtml', '<html>nocaptcha</html>')), /登录已失效/);
});

test('mtop：风控码绝不重试（哪怕同时带令牌过期）；返回拦截页 → 安全验证', async () => {
  let n = 0;
  const cdp = (text) => ({ evaluate: async () => '_m_h5_tk=a_1', callInPage: async () => { n++; return { status: 200, text }; } });
  const both = JSON.stringify({ ret: ['FAIL_SYS_TOKEN_EXOIRED::过期', 'RGV587_ERROR::SM::挤爆了'] });
  await assert.rejects(mtopFetch(cdp(both), { api: 'm.x', appKey: 'k' }), /RGV587/);
  assert.equal(n, 1);
  const call = createQnMtop(cdp('<html><script>location.href="https://x/_____tmd_____/punish?x5secdata=1"</script></html>'));
  await assert.rejects(call('m.y', {}), (e) => isVerifyError(e));
});

test('生意参谋 HTML：拦截页 → 验证；登录页（带滑块脚本）→ 登录失效', () => {
  assert.match(explainHtml({ url: 'https://sycm.taobao.com/x', text: '<html>_____tmd_____/punish</html>' }, 'f'), /安全验证/);
  assert.match(explainHtml({ url: 'https://login.taobao.com/member/login.jhtml', text: '<script src="nocaptcha.js"></script>' }, 'f'), /登录已失效/);
  assert.match(explainHtml({ url: 'https://sycm.taobao.com/x', text: '<div id="nocaptcha">滑块</div>' }, 'f'), /安全验证/);
});

test('解析容错：监控竞店两种包法、店铺链接去参数、走势日期包在 value 里、itemId 包在 value 里、重复属性', async () => {
  const row = { name: '甲', userId: 'ENC', b2CShop: true, linkUrl: '//a.tmall.com/?spm=TRACK&id=1#x' };
  assert.deepEqual(await monitoredShops(async () => [row]), [{ name: '甲', tmall: true, url: 'https://a.tmall.com', userId: 'ENC' }]);
  assert.equal((await monitoredShops(async () => ({ data: [row] }))).length, 1);
  await assert.rejects(monitoredShops(async () => 'oops'), /格式不对/);
  assert.deepEqual(await monitoredShops(async () => null), []);
  assert.deepEqual([parsePriceBands(null), parsePriceBands([]), parsePriceBands(undefined)], [[], [], []]);
  assert.throws(() => parsePriceBands('x'), /格式不对/);
  assert.equal(cleanUrl('https://shop1.taobao.com/category.htm?userId=SECRET'), 'https://shop1.taobao.com/category.htm');
  assert.equal(cleanUrl(''), null);

  const d0 = Date.UTC(2026, 10, 13) - 8 * 3600_000;
  assert.deepEqual(parseCoreTrend({ selfShop: { statDate: { value: [d0] }, uv: { value: [5] } } }, 'uv', []), [{ date: '2026-11-13', mine: 5 }]);
  assert.deepEqual(parseCoreTrend({}, 'uv', []), []);
  assert.equal(parseLossTargets({ top5ItemResult: [{ itemId: { value: 100000000011 }, item: {} }] }).items[0].product_id, '100000000011');

  const props = [{ id: '1', name: '品牌' }];
  assert.throws(() => resolveAttributes(props, ['品牌', '1']), /同一个/);
});
