// Codex 审查后的加固：风控识别（外层 / content 包装 / data.url）、验证优先于登录、缺数据不当空结果、错误脱敏、页面状态
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPage, waitReady, SYCM_SITE } from '../lib/browser.mjs';
import { isBlockingError, isVerifyError, optional } from '../lib/cooldown.mjs';
import { marketRank } from '../lib/market.mjs';
import { mtopFetch } from '../lib/mtop-fetch.mjs';
import { explainMtop, listOrders, listProducts, parseProductTable, QnError } from '../lib/qn.mjs';
import { isRiskJson, redact } from '../lib/risk.mjs';
import { createSycmApi, explainSycm, shopInfo, SycmError } from '../lib/sycm.mjs';

const PUNISH = { ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::挤爆了'], data: { url: 'https://x/_____tmd_____/punish?x5secdata=abc' } };

test('风控 JSON：外层、content 包装、只有 data.url 都认', () => {
  assert.equal(isRiskJson(PUNISH), true);
  assert.equal(isRiskJson({ content: { ret: ['RGV587_ERROR'] } }), true);
  assert.equal(isRiskJson({ ret: ['SUCCESS'], data: { url: 'https://a/_____tmd_____/punish' } }), true);
  assert.equal(isRiskJson({ code: 0, data: { url: 'https://shop.taobao.com' } }), false);
});

test('脱敏：链接、邮箱、像 ID 的长串去掉，普通说明保留', () => {
  assert.equal(redact('用户 ZzFake0EncryptedId9Example12 无权限，见 https://x.com/a?b=1 联系 a@b.com'), '用户 [ID] 无权限，见 [链接] 联系 [邮箱]');
  assert.equal(redact('request param dateType must be one of day'), 'request param dateType must be one of day');
});

test('生意参谋：content 里的风控、content.hasError、「请登录验证」当验证', async () => {
  const api = (body) => createSycmApi({}, { token: 't' }, async () => ({ status: 200, text: JSON.stringify(body) }));
  await assert.rejects(api({ content: PUNISH })('/a.json'), (e) => e instanceof SycmError && isVerifyError(e));
  await assert.rejects(api({ content: { code: 0, hasError: true, message: 'x' } })('/a.json'), /生意参谋接口失败/);
  assert.ok(isVerifyError({ message: explainSycm('/a', { message: '请登录验证 FAIL_SYS_USER_VALIDATE' }, 200) }));
  assert.doesNotMatch(explainSycm('/a', { message: '内部 userId=ZzFake0EncryptedId9Example12' }, 200), /ZzFake0Enc/);
});

test('店铺类型：没给 bcSeller 时平台未知（不默认淘宝）', async () => {
  assert.equal((await shopInfo(async () => ({}))).platform, null);
  assert.equal((await shopInfo(async () => ({ bcSeller: 0 }))).platform, 'taobao');
});

test('千牛：验证优先于登录；订单风控 JSON / 报错带验证码 → 验证；商品内层失败、缺数据报错；登录失效不换接口', async () => {
  assert.ok(isVerifyError({ message: explainMtop('m', 'FAIL_SYS_USER_VALIDATE::请登录验证') }));
  assert.match(explainMtop('m', 'FAIL_SYS_SESSION_EXPIRED::Session过期'), /登录已失效/);
  const order = (body) => listOrders({}, {}, async () => ({ status: 200, text: JSON.stringify(body) }));
  await assert.rejects(order(PUNISH), (e) => e instanceof QnError && isVerifyError(e));
  await assert.rejects(order({ error: 'need captcha' }), (e) => isVerifyError(e));
  await assert.rejects(order({ error: '系统繁忙 traceId=0b51f1a817946385' }), (e) => /订单接口报错/.test(e.message) && !/0b51f1a8/.test(e.message));
  assert.throws(() => parseProductTable({ success: false, errorMsg: 'RGV587_ERROR::SM' }), (e) => isVerifyError(e));
  assert.throws(() => parseProductTable({ success: true }), /数据不完整/);
  assert.deepEqual(parseProductTable({ data: { table: { dataSource: [] }, pagination: { total: 0 } } }), { total: 0, products: [] });
  const calls = [];
  await assert.rejects(listProducts(async (api) => { calls.push(api); throw new QnError('千牛登录已失效，请在紫鸟店铺浏览器里重新登录千牛'); }, {}), /登录已失效/);
  assert.equal(calls.length, 1);
});

test('optional：登录失效也不吞（这次调用要整体停下）', async () => {
  await assert.rejects(optional(Promise.reject(new SycmError('生意参谋登录已失效，请…')), null), /登录已失效/);
  assert.ok(isBlockingError(new Error('千牛卖家中心未登录：请…')));
  assert.equal(await optional(Promise.reject(new Error('别的')), 'x'), 'x');
});

test('mtop：只有 data.url 指向验证页也算风控，不做令牌重试', async () => {
  let n = 0;
  const cdp = { evaluate: async () => '_m_h5_tk=a_1', callInPage: async () => { n++; return { status: 200, text: JSON.stringify({ ret: ['FAIL_SYS_TOKEN_EMPTY::x'], data: { url: 'https://h5api.m.taobao.com/_____tmd_____/punish?x5secdata=1' } }) }; } };
  await assert.rejects(mtopFetch(cdp, { api: 'm.x', appKey: 'k' }), /FAIL_SYS_USER_VALIDATE/);
  assert.equal(n, 1);
});

test('市场排行：第二页空数组时总数未知（不是 0）', async () => {
  const cat = { id: 1, cate_flag: 2 };
  const range = { period: 'recent7', start: '2026-11-07', end: '2026-11-13' };
  assert.equal((await marketRank(async () => [], range, cat, { page: 2 })).total, null);
  assert.equal((await marketRank(async () => [], range, cat, { page: 1 })).total, 0);
});

test('页面状态：验证页（地址或标题）立刻停、登录页两次确认、加载超时', async () => {
  assert.equal(classifyPage({ href: 'https://sycm.taobao.com/_____tmd_____/punish?x5secdata=1' }), 'verify');
  assert.equal(classifyPage({ href: 'https://sycm.taobao.com/x', title: '验证码拦截' }), 'verify');
  assert.equal(classifyPage({ href: 'https://login.taobao.com/member/login.jhtml' }), 'login');
  assert.equal(classifyPage({ href: 'https://sycm.taobao.com/portal/home.htm', ready: true, title: '生意参谋' }), 'ready');
  const run = (pages) => {
    let t = 0;
    let i = 0;
    return waitReady({ evaluate: async () => pages[Math.min(i++, pages.length - 1)] }, SYCM_SITE, { now: () => t, pause: async (ms) => { t += ms; } });
  };
  await assert.rejects(run([{ href: 'https://sycm.taobao.com/_____tmd_____/punish' }]), (e) => isVerifyError(e));
  await assert.rejects(run([{ href: 'https://login.taobao.com/x' }]), /未登录/);
  await assert.rejects(run([{ href: 'https://sycm.taobao.com/x', ready: false }]), /加载超时/);
  await run([{ href: 'https://sycm.taobao.com/x', ready: false }, { href: 'https://sycm.taobao.com/x', ready: true, title: 'ok' }]);
});

test('第二轮：风控码和文案分开放、中文「验证码」、403 带验证提示、ret 是字符串、空结构、纯字母长 ID', async () => {
  const calls = [];
  const inner = (body) => async (api) => { calls.push(api); return { result: JSON.stringify(body) }; };
  await assert.rejects(listProducts(inner({ success: false, errorCode: 'FAIL_SYS_USER_VALIDATE', errorMsg: '系统繁忙' }), {}), (e) => isVerifyError(e));
  assert.equal(calls.length, 1);
  assert.throws(() => parseProductTable({ success: true, data: { url: 'https://x/_____tmd_____/punish' } }), (e) => isVerifyError(e));
  assert.throws(() => parseProductTable({ success: true, data: {} }), /数据不完整/);

  const order = (body) => listOrders({}, {}, async () => ({ status: 200, text: JSON.stringify(body) }));
  await assert.rejects(order({ error: '请输入验证码后重试' }), (e) => isVerifyError(e));
  await assert.rejects(order({}), /数据不完整/);
  assert.equal((await order({ mainOrders: [], page: { totalNumber: 0, totalPage: 0 } })).orders.length, 0);

  assert.ok(isVerifyError({ message: explainSycm('/a', { code: 403, message: '请完成安全验证' }, 403) }));
  assert.match(explainSycm('/a', { code: 401 }, 401), /登录已失效/);

  let n = 0;
  const cdp = { evaluate: async () => '_m_h5_tk=a_1', callInPage: async () => { n++; return { status: 200, text: JSON.stringify({ ret: 'FAIL_SYS_USER_VALIDATE::x' }) }; } };
  await assert.rejects(mtopFetch(cdp, { api: 'm.x', appKey: 'k' }), /FAIL_SYS_USER_VALIDATE/);
  assert.equal(n, 1);

  assert.equal(redact('卖家 FakeEncryptedSellerIdentifierAbc 无权限'), '卖家 [ID] 无权限');
});

test('第二轮：概览里推广接口报「验证码」时整次停下，不再请求后面的接口', async () => {
  const { storeOverview } = await import('../lib/sycm.mjs');
  const seen = [];
  const get = async (path) => {
    seen.push(path);
    if (path.includes('grow/factor')) throw new SycmError(explainSycm(path, { message: '请输入验证码' }, 200));
    return {};
  };
  await assert.rejects(storeOverview(get, { period: 'day', start: '2026-11-13', end: '2026-11-13' }), (e) => isVerifyError(e));
  assert.equal(seen.some((p) => p.includes('coreIndex')), false);
});

test('第三轮：商品失败汇总所有文案（登录提示不被盖住）；数组冒充对象、dataSource 为 null 都算不完整', async () => {
  const calls = [];
  await assert.rejects(listProducts(async (api) => { calls.push(api); return { result: JSON.stringify({ success: false, msg: { globalMessage: { text: '系统繁忙' } }, errorMsg: '登录已失效，请重新登录' }) }; }, {}), /登录已失效/);
  assert.equal(calls.length, 1);
  assert.throws(() => parseProductTable({ data: { table: [] } }), /数据不完整/);
  assert.throws(() => parseProductTable({ data: { table: { dataSource: null } } }), /数据不完整/);
  await assert.rejects(listOrders({}, {}, async () => ({ status: 200, text: JSON.stringify({ page: [] }) })), /数据不完整/);
});
