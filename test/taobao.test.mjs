import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { categoryOverview, findMarketCategory, marketRank, parseMarketCategories, parseMarketItem, parseMarketShop, parseMarketWord, parseRivalShop, searchMarketCategories } from '../lib/market.mjs';
import { pageRequest } from '../lib/page-request.mjs';
import { buildSoldForm, createQnMtop, listProducts, parseOrder, parseProductTable, parseSold, QnError } from '../lib/qn.mjs';
import { MtopError } from '../lib/mtop-fetch.mjs';
import { parseShops, resolveShop, ShopConfigError } from '../lib/shops.mjs';
import {
  createSycmApi, explainHtml, parseItemTrend, parseRankRow, parseSourceRow, parseTrend, parseWord, periodRange, pickMetrics, pickPeers, resolveRange, SycmError,
} from '../lib/sycm.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('店铺配置：TB_SHOPS 数组、默认店、按名称或 ID 找店', () => {
  const shops = parseShops({ TB_SHOPS: JSON.stringify([{ name: '天猫', store_id: '11111111111111' }, { name: '淘宝', store_id: '22222222222222', default: true }]) });
  assert.equal(resolveShop(shops).name, '淘宝');
  assert.equal(resolveShop(shops, '11111111111111').name, '天猫');
  assert.throws(() => resolveShop(shops, 'x'), /没有找到店铺「x」/);
  assert.deepEqual(parseShops({ TB_STORE_ID: '33333333333333' }).map((s) => s.storeId), ['33333333333333']);
  assert.throws(() => parseShops({ TB_SHOPS: '[{"store_id":"1"}]' }), ShopConfigError);
});

test('时间：区间、最新日期校验（被拒前重取一次）', async () => {
  assert.deepEqual(periodRange('recent7', '2026-11-13'), { period: 'recent7', start: '2026-11-07', end: '2026-11-13', days: 7 });
  assert.equal(periodRange('recent30', '2026-11-13').start, '2026-10-15');
  const calls = [];
  const latest = async (fresh) => { calls.push(Boolean(fresh)); return '2026-11-13'; };
  assert.equal((await resolveRange({}, latest)).end, '2026-11-13');
  calls.length = 0;
  await assert.rejects(resolveRange({ date: '2026-11-14' }, latest), /最新到 2026-11-13/);
  assert.deepEqual(calls, [false, true]);
  await assert.rejects(resolveRange({ date: '2026-02-30' }, latest), SycmError);
});

test('生意参谋客户端：带 token、两种包法、错误和登录失效', async () => {
  const seen = [];
  const replies = [
    { status: 200, text: JSON.stringify({ content: { code: 0, data: { a: 1 } }, hasError: false }) },
    { status: 200, text: JSON.stringify({ code: 0, data: { b: 2 } }) },
    { status: 200, text: JSON.stringify({ content: { code: 1000, message: '系统出错' }, hasError: true }) },
    { status: 200, url: 'https://login.taobao.com/x', text: '<html><title>登录</title></html>' },
    { error: 'Failed to fetch' },
    { status: 302, redirected: true, text: '' },
    { status: 200, url: 'https://sycm.taobao.com/x', text: '<html>punish x5sec</html>' },
    { status: 502, url: 'https://sycm.taobao.com/x', text: '<html>bad gateway</html>' },
  ];
  const request = async (_cdp, req) => { seen.push(req.url); return replies.shift(); };
  const get = createSycmApi({}, { token: 'tk1' }, request);
  assert.deepEqual(await get('/p/a.json', { dateType: 'day', dateRange: '2026-11-13|2026-11-13' }), { a: 1 });
  const u = new URL(seen[0]);
  assert.equal(u.origin + u.pathname, 'https://sycm.taobao.com/p/a.json');
  assert.equal(u.searchParams.get('token'), 'tk1');
  assert.equal(u.searchParams.get('dateRange'), '2026-11-13|2026-11-13');
  assert.deepEqual(await get('/p/b.json'), { b: 2 });
  await assert.rejects(get('/p/c.json'), (e) => e instanceof SycmError && /系统出错/.test(e.message));
  await assert.rejects(get('/p/d.json'), /登录已失效/);
  await assert.rejects(get('/p/e.json'), (e) => !(e instanceof SycmError) && /Failed to fetch/.test(e.message));
  await assert.rejects(get('/p/f.json'), /登录已失效/);
  await assert.rejects(get('/p/g.json'), /安全验证/);
  await assert.rejects(get('/p/h.json'), /不是 JSON（\/p\/h.json，HTTP 502）/);
});

test('指标挑选：只要白名单、带中文名和变化；同行平均 / 优秀；不输出 userId', () => {
  const m = pickMetrics({ payAmt: { value: 8900.774, cycleCrc: 0.01608 }, userId: { value: 999 }, uv: { value: 0 }, x: { value: 1 } }, ['payAmt', 'uv', 'userId_not_listed']);
  assert.deepEqual(m, { payAmt: { label: '支付金额', value: 8900.774, change: 0.0161 }, uv: { label: '访客数', value: 0 } });
  const s = pickMetrics({ orderAmt: 9248.36, orderAmtVariRate: -0.2062, orderRate: 0.053 }, ['orderAmt', 'orderRate'], { changeSuffix: 'VariRate' });
  assert.deepEqual(s.orderAmt, { label: '下单金额', value: 9248.36, change: -0.2062 });
  assert.equal(s.orderRate.change, undefined);
  assert.deepEqual(pickPeers({ payAmt: { value: 1513.6 } }, { payAmt: { value: 3332.9 } }, ['payAmt', 'uv']), { payAmt: { label: '支付金额', avg: 1513.6, good: 3332.9 } });
});

test('每日走势：statDate 是北京时间 0 点；合计；同行线开关', () => {
  const day = (d) => Date.UTC(2026, 10, d) - 8 * 3600_000;
  const data = { self: { statDate: [day(12), day(13)], payAmt: [10, 20.5], uv: [100, 120], userId: [1, 1] }, rivalAvg: { payAmt: [5, 6] }, rivalGood: { payAmt: [50, 60] } };
  const t = parseTrend(data);
  assert.deepEqual(t.days, [{ date: '2026-11-12', payAmt: 10, uv: 100 }, { date: '2026-11-13', payAmt: 20.5, uv: 120 }]);
  assert.deepEqual(t.totals, { payAmt: 30.5, uv: 220 });
  assert.deepEqual(parseTrend(data, { peers: true }).days[1].peer_good, { payAmt: 60 });
  const it = parseItemTrend({ payAmt: [1, 2, 3], itmUv: [10, 20, 30] }, { end: '2026-11-13', days: 3 });
  assert.deepEqual(it.map((r) => r.date), ['2026-11-11', '2026-11-12', '2026-11-13']);
  // 点数和天数对不上时不标日期
  assert.deepEqual(parseItemTrend({ payAmt: [1, 2] }, { end: '2026-11-13', days: 30 }).map((r) => r.index), [0, 1]);
});

test('来源、商品排行、搜索词：字段映射，去掉卖家 ID 和跟踪参数', () => {
  const src = parseSourceRow({ pageName: { value: '推荐' }, pageId: { value: 'reward.5081' }, uv: { value: 2025, cycleCrc: 0.0305 }, itmPayByrCnt: { value: 31 }, payRate: { value: 0.0153 },
    children: [{ pageName: { value: '手淘搜索' }, uv: { value: 5 }, payByrCnt: { value: 1 } }] });
  assert.deepEqual(src, { source: '推荐', page_id: 'reward.5081', visitors: 2025, visitors_change: 0.0305, pay_buyers: 31, pay_rate: 0.0153,
    children: [{ source: '手淘搜索', page_id: null, visitors: 5, pay_buyers: 1 }] });
  const row = parseRankRow({ item: { itemId: '100000000003', title: 't', mallItem: true, detailUrl: '//detail.tmall.com/item.htm?id=100000000003&mi_id=TRACK', userId: 'SECRET' },
    sellerId: { value: 'SECRET' }, payAmt: { value: 1543.31842, cycleCrc: -0.12 }, itmUv: { value: 1464 }, itmStayTime: { value: 9.72 } });
  assert.equal(row.url, 'https://detail.tmall.com/item.htm?id=100000000003');
  assert.equal(row.pay_amount, 1543.3184);
  assert.equal(row.pay_amount_change, -0.12);
  assert.equal(row.avg_stay_seconds, 9.7);
  assert.equal(JSON.stringify(row).includes('SECRET'), false);
  assert.equal(parseRankRow({ item: { itemId: '1', mallItem: false } }).url, 'https://item.taobao.com/item.htm?id=1');
  const w = parseWord({ seKeyword: { value: '测试搜索词' }, uv: { value: 17 }, payOrderUserCnt: { value: 2 }, sellerId: { value: 1 } });
  assert.deepEqual([w.keyword, w.visitors, w.pay_buyers], ['测试搜索词', 17, 2]);
  assert.equal('seller_id' in w, false);
});

test('订单：标签参数、解析订单（不输出买家），分页', () => {
  const ws = new URLSearchParams(buildSoldForm({ tab: 'waitSend', page: 3 }));
  assert.deepEqual([ws.get('tabCode'), ws.get('auctionStatus'), ws.get('pageNum'), ws.get('prePageNo'), ws.get('isHideNick')], ['waitSend', 'PAID', '3', '2', 'true']);
  assert.equal(new URLSearchParams(buildSoldForm({ tab: 'before3Months' })).get('action'), 'itemlist/SoldHisQueryAction');
  assert.equal(new URLSearchParams(buildSoldForm({})).get('auctionStatus'), null);
  const sold = parseSold({
    page: { totalNumber: 39, totalPage: 3, pageSize: 15, currentPage: 1 },
    mainOrders: [{
      id: '1234567890123456789', orderInfo: { createTime: '2026-01-02 10:00:00' }, statusInfo: { text: '买家已付款' }, payInfo: { actualFee: '9.45', postType: '(含快递:￥0.00)' },
      buyer: { nick: 'b***r', id: 123 }, extra: { sellerFlag: 0 },
      subOrders: [{ quantity: '1', priceInfo: { realTotal: '10.50' }, operations: [{ text: '发货未超时' }],
        itemInfo: { title: '测试商品甲', skuText: [{ name: '颜色分类', value: '咖色' }], extra: [{ name: '商家编码', value: 'SKU-A-01' }, { name: '发货时间', value: 'x' }] } }],
    }],
  });
  assert.deepEqual([sold.total, sold.total_pages, sold.page], [39, 3, 1]);
  assert.deepEqual(sold.orders[0], {
    order_id: '1234567890123456789', created_at: '2026-01-02 10:00:00', status: '买家已付款', paid: 9.45, shipping: '(含快递:￥0.00)',
    items: [{ title: '测试商品甲', sku: '颜色分类：咖色', seller_code: 'SKU-A-01', quantity: 1, price: 10.5, notes: ['发货未超时'] }],
  });
  assert.equal(JSON.stringify(sold).includes('b***r'), false);
  assert.equal(parseOrder({ id: 1 }).items.length, 0);
});

test('商品：解析商品表；天猫失败时改用淘宝接口；业务错误 → QnError', async () => {
  const result = JSON.stringify({ success: true, data: { pagination: { total: 194 }, table: { dataSource: [{
    itemId: '100000000001', catId: 50000001, managerPrice: { currentPrice: '¥ 7.70' }, managerQuantityNew: { text: 993 }, soldQuantity_m: 7,
    upShelfDate_m: { value: '2026-01-01 08:00', status: { text: '出售中' } }, diagnoseInfoV3: { basicScore: 100, scoreLabel: '流量加速中' },
    itemDesc: { desc: [{ uiType: 'link', text: '测试商品乙' }, { uiType: 'text', text: 'ID:100000000001' }, { uiType: 'text', text: ' 编码:SKU-B-02' }] },
  }] } } });
  const t = parseProductTable(result);
  assert.equal(t.total, 194);
  assert.deepEqual(t.products[0], {
    product_id: '100000000001', title: '测试商品乙', seller_code: 'SKU-B-02', price: '¥ 7.70', stock: 993, sales_30d: 7, category_id: '50000001',
    listed_at: '2026-01-01 08:00', status: '出售中', quality_score: 100, traffic_label: '流量加速中',
  });
  assert.throws(() => parseProductTable('{bad'), QnError);
  const edge = parseProductTable(JSON.stringify({ data: { table: { dataSource: [{ managerQuantityNew: { text: '' }, soldQuantity_m: '1.2万' }] } } })).products[0];
  assert.deepEqual([edge.product_id, edge.stock, edge.sales_30d], [null, null, 12000]);

  const apis = [];
  const call = async (api, data) => {
    apis.push([api, data.url]);
    if (api.includes('tmall')) throw new QnError('千牛接口失败');
    return { result };
  };
  const out = await listProducts(call, { tab: 'on_sale' });
  assert.equal(out.platform, 'taobao');
  assert.deepEqual(apis, [['mtop.tmall.sell.pc.manage.async', '/tmall/manager/table.htm'], ['mtop.taobao.sell.pc.manage.async', '/taobao/manager/table.htm']]);

  const qn = createQnMtop({}, async () => { throw new MtopError('x 失败：FAIL_SYS_SESSION_EXPIRED::过期'); });
  await assert.rejects(qn('a.b', {}), (e) => e instanceof QnError && /登录已失效/.test(e.message));
  const transport = createQnMtop({}, async () => { throw new Error('Runtime.evaluate 超时'); });
  await assert.rejects(transport('a.b', {}), (e) => !(e instanceof QnError));
});

test('市场：类目路径、商品 / 店铺 / 搜索词 / 竞店解析（区间原样输出，去掉卖家 ID 和跳转链接）', async () => {
  const cats = parseMarketCategories([[0, 1000, '一级', 1, 'free', 'N', 1000, '一级'], [1000, 2000, '二级叶子', 2, 'free', 'Y', 1000, '一级'], [1000, 2001, '二级', 2, 'free', 'N', 1000, '一级'], [2001, 3000, '三级', 0, 'free', 'Y', 1000, '一级'], 'bad']);
  assert.equal(cats.length, 4);
  assert.equal(findMarketCategory(cats, '3000').path, '一级 / 二级 / 三级');
  assert.throws(() => findMarketCategory(cats, 9), /不在这家店能看的市场类目里.*2000 二级叶子/);
  assert.deepEqual(searchMarketCategories(cats, { query: '三级' }).categories.map((c) => c.id), [3000]);
  await assert.rejects(categoryOverview(async () => ({}), { period: 'recent7', start: 'a', end: 'b' }, cats[0]), /一级类目不支持/);

  const item = parseMarketItem({ itemId: { value: '100000000004' }, uv: { value: '7500 ~ 1万' }, payByrCnt: { value: '250 ~ 500' }, coreKeyWord: { value: '模型,工具' },
    item: { itemId: '100000000004', title: '竞品', detailUrl: '//sycm.taobao.com/mc/common/tb_item_redirect.htm?mi_id=TRACK', userId: 'SECRET' },
    shop: { title: '某店', b2CShop: true, userId: 'SECRET' }, cateRankId: { value: 1, cycleCqc: -64 }, isSelfItem: { value: false } });
  assert.deepEqual(item, { rank: 1, rank_change: -64, product_id: '100000000004', title: '竞品', url: 'https://detail.tmall.com/item.htm?id=100000000004',
    shop: '某店', tmall: true, pay_buyers: '250 ~ 500', visitors: '7500 ~ 1万', core_keywords: ['模型', '工具'], is_mine: false });
  const shop = parseMarketShop({ shop: { title: '某店', shopUrl: '//shop1.taobao.com', b2CShop: false, userId: 1 }, sellerId: { value: 1 }, payByrCnt: { value: '5000 ~ 7500' }, cateRankId: { value: 1, cycleCqc: 0 }, saleItemCnt: { value: 50 } });
  assert.deepEqual([shop.shop_url, shop.items_on_sale, shop.rank_change], ['https://shop1.taobao.com', 50, 0]);
  assert.equal(JSON.stringify([item, shop]).includes('SECRET'), false);
  assert.deepEqual(parseMarketWord({ rn: { value: 12 }, searchWord: { value: '硅胶' }, seIpvUvHits: { value: '1万 ~ 2万' }, clickThroughRate: { value: 0.46 }, payRate: { value: '20% ~ 25%' }, seUvEx: { value: 1.02983 } }),
    { rank: 12, keyword: '硅胶', search_popularity: '1万 ~ 2万', click_rate: 0.46, pay_rate: '20% ~ 25%', rise: 1.0298 });
  const rival = parseRivalShop({ shop: { title: '竞店', province: '福建', city: '泉州', b2CShop: true, userId: 'SECRET' }, payByrCntIndexFree: { value: '2500 ~ 5000', cycleCrc: '10% ~ 20%' },
    uvIndexFree: { value: '7.5万 ~ 10万', cycleCrc: '20% ~ 25%' }, tagList: [{ tagName: '交易大增' }], info: '新上架1个商品', userId: { value: 'SECRET' } });
  assert.deepEqual([rival.location, rival.pay_buyers_change, rival.tags, rival.news], ['福建 泉州', '10% ~ 20%', ['交易大增'], '新上架1个商品']);
  assert.equal(JSON.stringify(rival).includes('SECRET'), false);

  const seen = [];
  const get = async (path, params) => { seen.push([path, params]); return { recordCount: 1, data: [] }; };
  await marketRank(get, { period: 'recent7', start: '2026-11-07', end: '2026-11-13' }, cats[3], { type: 'shops' });
  assert.equal(seen[0][0], '/mc/mq/mkt/shop/offline/rank.json');
  assert.deepEqual([seen[0][1].cateId, seen[0][1].cateFlag, seen[0][1].marketVersion, seen[0][1].dateRange], [3000, 0, 'free', '2026-11-07|2026-11-13']);
});

test('HTML 返回的分辨：验证码 / 登录页 / 其他', () => {
  assert.match(explainHtml({ text: '<html>punish</html>' }, 'x'), /安全验证/);
  assert.match(explainHtml({ url: 'https://login.taobao.com/a', text: '' }, 'x'), /登录已失效/);
  assert.equal(explainHtml({ text: '<html>502</html>' }, 'other'), 'other');
});

test('页面请求函数自包含（会被序列化到页面里执行）', () => {
  const src = pageRequest.toString();
  assert.match(src, /referrer: location\.href/);
  assert.match(src, /redirect: 'manual'/);
  assert.doesNotMatch(src, /setTimeout|import\(/);
});

test('MCP：握手、工具列表、参数错误在连浏览器之前返回', async () => {
  const env = { ...process.env, TB_DATA_DIR: join(ROOT, 'test'), TB_SHOPS: JSON.stringify([{ name: '测试店', store_id: '12345678901234' }]) };
  const child = spawn(process.execPath, [join(ROOT, 'bin', 'taobao-seller-mcp.mjs')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    let buf = '';
    const waiting = new Map();
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        waiting.get(msg.id)?.(msg);
      }
    });
    let n = 0;
    const rpc = (method, params) => new Promise((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const text = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result.content[0].text;
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'taobao-seller-mcp');
    const tools = (await rpc('tools/list', {})).result.tools;
    assert.deepEqual(tools.map((t) => t.name), ['tb_shops', 'tb_store_overview', 'tb_store_trend', 'tb_store_today', 'tb_traffic_sources', 'tb_product_rank',
      'tb_product_analysis', 'tb_search_words', 'tb_market_categories', 'tb_market_overview', 'tb_market_rank', 'tb_market_search_words', 'tb_competitors',
      'tb_orders', 'tb_products']);
    assert.ok(tools.every((t) => t.annotations.readOnlyHint === true));
    assert.deepEqual(JSON.parse(await text('tb_shops', {})).shops, [{ name: '测试店', store_id: '12345678901234', default: true }]);
    assert.match(await text('tb_store_overview', { shop: '别的店' }), /没有找到店铺「别的店」/);
    assert.match(await text('tb_store_overview', { period: 'week' }), /period 只能是/);
    assert.match(await text('tb_store_overview', { date: '2026-02-30' }), /YYYY-MM-DD/);
    assert.match(await text('tb_product_analysis', { product_id: '1&x=2' }), /product_id 应是/);
    assert.match(await text('tb_product_analysis', { product_id: '100000000002', sections: ['x'] }), /sections 里的值只能是/);
    assert.match(await text('tb_orders', { tab: 'nope' }), /tab 只能是/);
    assert.match(await text('tb_market_rank', {}), /缺少参数：category_id/);
    assert.match(await text('tb_market_rank', { category_id: 'abc' }), /category_id 应是/);
    assert.match(await text('tb_market_rank', { category_id: '1', price_segment: 'x' }), /price_segment 应是/);
    assert.match(await text('tb_product_analysis', { product_id: '100000000002', sections: ['overview', 'trend', 'skus', 'sources', 'overview'] }), /最多 4 项/);
    assert.match(await text('tb_shops', { constructor: 1 }), /未知参数：constructor/);
    const unknown = await rpc('nope/method', {});
    assert.equal(unknown.error.code, -32601);
  } finally {
    child.kill();
  }
});
