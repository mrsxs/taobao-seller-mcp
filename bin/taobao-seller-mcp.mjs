#!/usr/bin/env node
// 淘宝 / 天猫卖家 MCP（stdio）：生意参谋经营数据、流量来源、商品排行、单品分析、引流搜索词、推广花费，以及千牛的订单和商品。
// 全部通过本机紫鸟店铺浏览器里已登录的页面取数（不走开放平台、不需要 AppKey），只读。
// 每家店用两个工作标签页：生意参谋（sycm.taobao.com）和千牛（myseller.taobao.com，订单接口只允许它跨域）。
// 协议：每行一条 JSON-RPC 2.0 消息；stdout 只写协议消息，诊断写 stderr。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { withBrowserLock } from '../lib/browser-lock.mjs';
import { QN_SITE, SYCM_SITE, createBrowserSession } from '../lib/browser.mjs';
import {
  categoryOverview, findMarketCategory, marketCategories, marketRank, marketSearchWords, priceSegments, rivalShops, searchMarketCategories,
} from '../lib/market.mjs';
import { createQnMtop, listOrders, listProducts, ORDER_TABS, orderCounts, PRODUCT_TABS, QnError } from '../lib/qn.mjs';
import { ShopConfigError, parseShops, resolveShop } from '../lib/shops.mjs';
import {
  assertDate, createSycmApi, latestDate, PERIODS, productAnalysis, productRank, RANK_BY, resolveRange, searchWords, shopInfo, storeOverview,
  storeToday, storeTrend, SycmError, sycmContext, trafficSources, WORD_ORDER,
} from '../lib/sycm.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const DATA_DIR = process.env.TB_DATA_DIR || join(homedir(), '.taobao-seller-mcp');

class QueryError extends Error {}

// 配置错误不让进程退出（客户端只会显示 exited with code 1），而是在每次调用时说明
let SHOPS = [];
let configError = null;
try {
  SHOPS = parseShops();
} catch (err) {
  configError = err;
  process.stderr.write(`[taobao-seller-mcp] ${err.message}\n`);
}
const shopFor = (ref) => {
  if (configError) throw configError;
  return resolveShop(SHOPS, ref);
};

// ---- 浏览器：每个（站点, 紫鸟店铺）一个会话；本进程内排队，跨进程用数据目录里的锁文件 ----
const sessions = new Map();
const sessionFor = (site, storeId) => {
  const key = `${site.urlPrefix}|${storeId}`;
  if (!sessions.has(key)) sessions.set(key, createBrowserSession(site));
  return sessions.get(key);
};
let queue = Promise.resolve();
const exclusive = (fn) => {
  const run = queue.then(() => withBrowserLock(DATA_DIR, fn, { owner: `taobao-seller-mcp ${process.pid}` }));
  queue = run.catch(() => {});
  return run;
};

const TTL_MS = 10 * 60_000;
// token 跟着标签页走（WeakMap 以 CDP 连接为键，重开标签页自动失效）；其余按店铺缓存
const caches = { sycm: new WeakMap(), latest: new Map(), info: new Map(), categories: new Map() };
// 天猫 / 淘宝：生意参谋或商品接口任何一个识别出来后记住，不过期
const platformOf = new Map();
const cached = async (map, key, load) => {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await load();
  map.set(key, { at: Date.now(), value });
  return value;
};

const isUserError = (err) => err instanceof QueryError || err instanceof SycmError || err instanceof QnError || err instanceof ShopConfigError;
const PLATFORM = { tmall: '天猫', taobao: '淘宝' };

/** 在某家店的生意参谋标签页里执行：fn({ get, latest }) */
function withSycm(shopRef, fn) {
  const shop = shopFor(shopRef);
  return exclusive(async () => {
    const session = sessionFor(SYCM_SITE, shop.storeId);
    let cdp = null;
    try {
      cdp = await session.connect(shop.storeId);
      const ctx = await cached(caches.sycm, cdp, () => sycmContext(cdp));
      const get = createSycmApi(cdp, ctx);
      const latest = (fresh = false) => {
        if (fresh) caches.latest.delete(shop.storeId);
        return cached(caches.latest, shop.storeId, () => latestDate(get));
      };
      // 只用来标天猫 / 淘宝；子账号可能没这个权限，取不到不影响其他数据
      const info = await cached(caches.info, shop.storeId, () => shopInfo(get)).catch(() => null);
      if (info?.platform) platformOf.set(shop.storeId, info.platform);
      const out = await fn({ get, latest, storeId: shop.storeId });
      return { shop: shop.name, ...(info ? { platform: PLATFORM[info.platform] } : {}), ...out };
    } catch (err) {
      if (cdp && !(err instanceof QueryError)) caches.sycm.delete(cdp);
      if (!isUserError(err)) session.reset();
      throw err;
    }
  });
}

/** 在某家店的千牛标签页里执行：fn({ cdp, call, platform }) */
function withQn(shopRef, fn) {
  const shop = shopFor(shopRef);
  return exclusive(async () => {
    const session = sessionFor(QN_SITE, shop.storeId);
    try {
      const cdp = await session.connect(shop.storeId);
      const out = await fn({ cdp, call: createQnMtop(cdp), platform: platformOf.get(shop.storeId), remember: (p) => platformOf.set(shop.storeId, p) });
      return { shop: shop.name, ...out };
    } catch (err) {
      if (!isUserError(err)) session.reset();
      throw err;
    }
  });
}

const PRODUCT_ID = /^\d{6,20}$/;
/** 进浏览器排队之前先查参数，错了立刻返回 */
function precheck(a) {
  if (a.date !== undefined) {
    try {
      assertDate(a.date);
    } catch (err) {
      throw new QueryError(err.message);
    }
  }
  if (a.product_id !== undefined && !PRODUCT_ID.test(a.product_id)) throw new QueryError('product_id 应是淘宝 / 天猫商品 ID（数字）');
  if (a.category_id !== undefined && !/^\d{1,12}$/.test(a.category_id)) throw new QueryError('category_id 应是数字类目 ID（用 tb_market_categories 查）');
  if (a.price_segment !== undefined && !/^\d{1,3}$/.test(a.price_segment)) throw new QueryError('price_segment 应是价格段 ID（tb_market_overview 的 price_segments）');
}

const RANGE_NOTE = '日期是北京时间自然日（生意参谋口径），最新通常到昨天；金额人民币。change 是较上一个同长度周期的变化比例。';
const rangeOut = (r) => ({ period: r.period, start: r.start, end: r.end });

const overview = (a) => withSycm(a.shop, async ({ get, latest }) => {
  const range = await resolveRange(a, latest);
  return { ...rangeOut(range), ...(await storeOverview(get, range)),
    note: `${RANGE_NOTE}period=day 时多给退款、复购、服务等指标和同行平均 / 优秀（peers）。promotion 是生意参谋汇总的推广数据。` };
});

const trend = (a) => withSycm(a.shop, async ({ get, latest }) => {
  const range = await resolveRange({ period: 'recent30', date: a.date }, latest);
  const out = await storeTrend(get, range.end, { peers: a.include_peers === true });
  return { start: out.days[0]?.date ?? range.start, end: range.end, ...out,
    note: `${RANGE_NOTE}每天一行，totals 是按天加总（访客按天去重后直接相加）。${a.include_peers ? 'peer_avg / peer_good 是同行同层平均 / 优秀。' : ''}` };
});

const today = (a) => withSycm(a.shop, async ({ get }) => ({ ...(await storeToday(get)), note: '今天（北京时间）到目前为止；change 是较昨天同一时段。' }));

const sources = (a) => withSycm(a.shop, async ({ get, latest }) => {
  const range = await resolveRange(a, latest);
  const out = await trafficSources(get, range, { productId: a.product_id, limit: a.limit ?? 20 });
  return { ...rangeOut(range), product_id: a.product_id ?? null, ...out,
    note: `${RANGE_NOTE}${a.product_id ? '单品来源树（children 是二级来源）。' : '全店无线端来源，按访客数排序。'}同一访客可能来自多个来源，不要相加。` };
});

const rank = (a) => withSycm(a.shop, async ({ get, latest }) => {
  const range = await resolveRange(a, latest);
  const out = await productRank(get, range, { rankBy: a.rank_by ?? 'pay_amount', page: a.page ?? 1, pageSize: a.page_size ?? 20 });
  return { ...rangeOut(range), rank_by: a.rank_by ?? 'pay_amount', page: a.page ?? 1, ...out, note: RANGE_NOTE };
});

const analysis = (a) => withSycm(a.shop, async ({ get, latest }) => {
  const range = await resolveRange({ period: a.period ?? 'recent30', date: a.date }, latest);
  const out = await productAnalysis(get, range, a.product_id, { sections: a.sections ?? ['overview', 'skus', 'sources'], limit: a.limit ?? 20 });
  return { ...rangeOut(range), product_id: a.product_id, ...out,
    note: `${RANGE_NOTE}overview 单品核心指标；trend 每日；skus 各 SKU 成交；sources 单品流量来源树。` };
});

const words = (a) => withSycm(a.shop, async ({ get, latest }) => {
  const range = await resolveRange(a, latest);
  const out = await searchWords(get, range, { orderBy: a.order_by ?? 'visitors', page: a.page ?? 1, pageSize: a.page_size ?? 20 });
  return { ...rangeOut(range), order_by: a.order_by ?? 'visitors', ...out, note: `${RANGE_NOTE}买家用这些词搜索后进入本店（无线端）。` };
});

const orders = (a) => withQn(a.shop, async ({ cdp, call }) => {
  const [list, counts] = await Promise.all([
    listOrders(cdp, { tab: a.tab ?? 'latest3Months', page: a.page ?? 1 }),
    orderCounts(call).catch((err) => ({ error: `计数没取到：${err.message}` })),
  ]);
  return { tab: ORDER_TABS[a.tab ?? 'latest3Months'], ...list, counts,
    note: '千牛「已卖出的宝贝」，每页 15 单，下单时间是北京时间；paid 是实付金额（元）。不输出买家昵称和收货信息。counts 是待发货 / 即将超时 / 已超时计数。' };
});

const products = (a) => withQn(a.shop, async ({ call, platform, remember }) => {
  const tab = a.tab ?? 'on_sale';
  const out = await listProducts(call, { platform, tab, page: a.page ?? 1, pageSize: a.page_size ?? 20 });
  remember(out.platform);
  return { tab: PRODUCT_TABS[tab], page: a.page ?? 1, ...out, platform: PLATFORM[out.platform],
    note: '千牛「我的宝贝」；sales_30d 是列表里的销量（近 30 天）；quality_score 是基础质量分。' };
});

// ---- 市场（生意参谋「市场」免费版） ----
const MARKET_NOTE = '生意参谋「市场」免费版：只能看这家店经营的类目，指标是区间（如「7500 ~ 1万」），不是精确值；整个类目的数据，不是本店。';
const categoryFor = async (get, storeId, id) => findMarketCategory(await cached(caches.categories, storeId, () => marketCategories(get)), id);

const mktCategories = (a) => withSycm(a.shop, async ({ get, storeId }) => ({
  ...searchMarketCategories(await cached(caches.categories, storeId, () => marketCategories(get)), { query: a.query, limit: a.limit ?? 50 }),
  note: '这家店在生意参谋「市场」里能看的类目；id 用于 tb_market_* 工具。leaf=true 是叶子类目。',
}));

const mktOverview = (a) => withSycm(a.shop, async ({ get, latest, storeId }) => {
  const range = await resolveRange(a, latest);
  const cat = await categoryFor(get, storeId, a.category_id);
  const [overview, segments] = await Promise.all([categoryOverview(get, range, cat), priceSegments(get, range, cat)]);
  return { ...rangeOut(range), category: { id: cat.id, path: cat.path }, overview, price_segments: segments,
    note: `${MARKET_NOTE}overview：支付买家数、支付金额占父类目比例、支付金额增幅、供需比；price_segments 的 id 可用于 tb_market_rank。` };
});

const mktRank = (a) => withSycm(a.shop, async ({ get, latest, storeId }) => {
  const range = await resolveRange(a, latest);
  const cat = await categoryFor(get, storeId, a.category_id);
  const out = await marketRank(get, range, cat, { type: a.type ?? 'items', priceSegment: a.price_segment ?? '', page: a.page ?? 1, pageSize: a.page_size ?? 20 });
  return { ...rangeOut(range), category: { id: cat.id, path: cat.path }, type: a.type ?? 'items', ...out,
    note: `${MARKET_NOTE}按交易排名；rank_change 是排名较上期变化；is_mine 标出本店。` };
});

const mktWords = (a) => withSycm(a.shop, async ({ get, latest, storeId }) => {
  const range = await resolveRange(a, latest);
  const cat = await categoryFor(get, storeId, a.category_id);
  const out = await marketSearchWords(get, range, cat, { rankType: a.rank_type ?? 'hot', wordType: a.word_type ?? 'search', keyword: a.keyword ?? '', page: a.page ?? 1, pageSize: a.page_size ?? 20 });
  return { ...rangeOut(range), category: { id: cat.id, path: cat.path }, rank_type: a.rank_type ?? 'hot', ...out,
    note: `${MARKET_NOTE}search_popularity 搜索人气（区间）、click_rate 点击率、pay_rate 支付转化率（区间）、rise 飙升幅度。` };
});

const competitors = (a) => withSycm(a.shop, async ({ get, latest }) => {
  const range = await resolveRange(a, latest);
  return { ...rangeOut(range), ...(await rivalShops(get, range, { page: a.page ?? 1, pageSize: a.page_size ?? 20 })),
    note: '生意参谋「竞争 → 竞店监控」里设置的竞店（要先在生意参谋里添加监控）；指标是区间。news 是竞店动态。' };
});

const shops = () => {
  if (configError) throw configError;
  return {
    shops: SHOPS.map((s) => ({ name: s.name, store_id: s.storeId, default: s.isDefault })),
    data_dir: DATA_DIR.startsWith(homedir()) ? `~${DATA_DIR.slice(homedir().length)}` : DATA_DIR,
    note: SHOPS.length ? '工具里的 shop 参数填店铺名或紫鸟店铺 ID；不填 = 默认店。' : '没有配置店铺：设置 TB_SHOPS（JSON 数组）或 TB_STORE_ID。',
  };
};

const INSTRUCTIONS = '淘宝 / 天猫卖家数据（通过本机紫鸟店铺浏览器里已登录的千牛 / 生意参谋取数，不走开放平台，只读）。'
  + '经营：tb_store_overview（支付金额、访客、转化、客单价、下单、推广花费，单日 / 近 7 / 30 天，带环比；单日附退款、复购和同行对比）、tb_store_trend（近 30 天每日）、tb_store_today（今天实时）。'
  + '流量：tb_traffic_sources（全店或单品来源）、tb_search_words（引流搜索词）。商品：tb_product_rank（商品排行）、tb_product_analysis（单品核心指标 / 每日 / SKU / 来源）。'
  + '千牛：tb_orders（已卖出的宝贝，按标签筛选翻页）、tb_products（出售中 / 仓库中的宝贝）。'
  + '市场（免费版，区间值）：tb_market_categories 查类目 → tb_market_overview（类目大盘、价格段）、tb_market_rank（类目商品 / 店铺排行）、tb_market_search_words（热搜 / 飙升词）；tb_competitors（竞店监控）。'
  + '多店铺：tb_shops 列出已配置的店，其他工具用 shop 参数选店，比较多家店时逐店调用。日期是北京时间，最新通常到昨天。';

// ---- 工具定义 ----
const shopArg = { type: 'string', description: '店铺名或紫鸟店铺 ID；不填 = 默认店（见 tb_shops）' };
const periodArg = { type: 'string', enum: PERIODS, default: 'recent7', description: 'day 单日 / recent7 近 7 天 / recent30 近 30 天（都以 date 为最后一天）' };
const dateArg = { type: 'string', description: '统计区间的最后一天 YYYY-MM-DD（北京时间）；不填 = 生意参谋最新出数日（通常是昨天）' };
const pageArg = { type: 'integer', minimum: 1, maximum: 500, default: 1 };
const productIdArg = { type: 'string', description: '淘宝 / 天猫商品 ID' };
const categoryArg = { type: 'string', description: '类目 ID（用 tb_market_categories 查）' };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const LOCAL_RO = { ...RO, openWorldHint: false };
const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });

const TOOLS = [
  { name: 'tb_shops', description: '列出已配置的淘宝 / 天猫店铺（名称、紫鸟店铺 ID、哪家是默认店）。', annotations: LOCAL_RO, inputSchema: obj({}), run: shops },
  {
    name: 'tb_store_overview',
    description: '店铺经营概况（生意参谋）：支付金额、支付买家数、支付转化率、客单价、访客数、浏览量、UV 价值、新老访客、跳失率、加购 / 收藏人数、新老支付买家，'
      + '下单金额 / 买家 / 转化，推广总花费、点击、ROI；单日 / 近 7 / 30 天，带较上期变化。period=day 时另给退款、净支付、复购、咨询率、物流时效和同行平均 / 优秀。',
    annotations: RO, inputSchema: obj({ shop: shopArg, period: periodArg, date: dateArg }), run: overview,
  },
  {
    name: 'tb_store_trend',
    description: '店铺近 30 天每日：支付金额、支付买家数、转化率、客单价、访客数、浏览量、支付件数、加购人数、净支付金额、退款金额、老买家支付金额，附合计；可选同行平均 / 优秀。',
    annotations: RO,
    inputSchema: obj({ shop: shopArg, date: { ...dateArg, description: '最后一天 YYYY-MM-DD；不填 = 最新出数日' }, include_peers: { type: 'boolean', default: false, description: '附上每天的同行平均 / 优秀（支付金额、买家数、访客）' } }),
    run: trend,
  },
  { name: 'tb_store_today', description: '店铺今天（北京时间）到目前为止的实时数据：支付金额、支付买家数、转化率、支付件数、访客、浏览量、加购人数、净支付金额、退款率，带较昨天同时段变化。', annotations: RO, inputSchema: obj({ shop: shopArg }), run: today },
  {
    name: 'tb_traffic_sources',
    description: '流量来源：不传 product_id 看全店无线端各来源（手淘搜索、推荐、直通车、站外…）的访客、加购、支付买家、转化；传 product_id 看单品来源树（含二级来源、支付金额）。',
    annotations: RO,
    inputSchema: obj({ shop: shopArg, period: periodArg, date: dateArg, product_id: productIdArg, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }),
    run: sources,
  },
  {
    name: 'tb_product_rank',
    description: '商品排行（生意参谋）：按支付金额 / 访客 / 支付件数 / 转化率 / 加购 / 收藏排序；每个商品的支付金额、件数、买家、转化率、访客、搜索引导访客和转化、加购、收藏、下单、退款、客单价、跳出率、停留时长和环比。',
    annotations: RO,
    inputSchema: obj({
      shop: shopArg, period: periodArg, date: dateArg,
      rank_by: { type: 'string', enum: Object.keys(RANK_BY), default: 'pay_amount', description: 'pay_amount 支付金额 / visitors 访客 / pay_items 支付件数 / pay_rate 转化率 / add_to_cart 加购件数 / collect 收藏人数' },
      page: pageArg, page_size: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    }),
    run: rank,
  },
  {
    name: 'tb_product_analysis',
    description: '单个商品深入分析（商品 360）：overview 核心指标（支付、访客、下单、加购收藏率、新老买家、退款、推广消耗和直接 ROI、询单 / 静默转化率）；trend 每日支付和访客；skus 各 SKU 成交；sources 流量来源树。'
      + '用来回答「这个商品为什么卖得好 / 不好」。',
    annotations: RO,
    inputSchema: obj({
      shop: shopArg, product_id: productIdArg, period: { ...periodArg, default: 'recent30' }, date: dateArg,
      sections: { type: 'array', items: { type: 'string', enum: ['overview', 'trend', 'skus', 'sources'] }, maxItems: 4, description: '要哪些部分，默认 overview、skus、sources' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'SKU / 来源各列多少行' },
    }, ['product_id']),
    run: analysis,
  },
  {
    name: 'tb_search_words',
    description: '引流搜索词（全店）：买家搜哪些词进店，每个词的访客、加购、收藏、支付买家、支付金额、转化率、客单价、UV 价值。',
    annotations: RO,
    inputSchema: obj({
      shop: shopArg, period: periodArg, date: dateArg,
      order_by: { type: 'string', enum: Object.keys(WORD_ORDER), default: 'visitors', description: 'visitors 访客 / pay_buyers 支付买家 / add_to_cart 加购 / collect 收藏' },
      page: pageArg, page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    }),
    run: words,
  },
  {
    name: 'tb_market_categories',
    description: '市场：这家店在生意参谋「市场」免费版里能看的类目（ID、名称、完整路径、是否叶子），按名称搜索。',
    annotations: RO,
    inputSchema: obj({ shop: shopArg, query: { type: 'string', description: '类目名关键词，如 模型、工具' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }),
    run: mktCategories,
  },
  {
    name: 'tb_market_overview',
    description: '市场：类目大盘（支付买家数、支付金额占父类目比例、支付金额增幅、供需比）和类目价格段。数值是区间。',
    annotations: RO,
    inputSchema: obj({ shop: shopArg, category_id: categoryArg, period: periodArg, date: dateArg }, ['category_id']),
    run: mktOverview,
  },
  {
    name: 'tb_market_rank',
    description: '市场：类目里按交易排名的商品或店铺（排名、排名变化、商品 / 店铺名、是否天猫、支付买家数、访客数、核心词、是否本店）；可按价格段筛选。数值是区间。',
    annotations: RO,
    inputSchema: obj({
      shop: shopArg, category_id: categoryArg, period: periodArg, date: dateArg,
      type: { type: 'string', enum: ['items', 'shops'], default: 'items', description: 'items 商品排行 / shops 店铺排行' },
      price_segment: { type: 'string', description: '价格段 ID（tb_market_overview 的 price_segments）；只对商品排行有效' },
      page: pageArg, page_size: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    }, ['category_id']),
    run: mktRank,
  },
  {
    name: 'tb_market_search_words',
    description: '市场：类目搜索词排行——热搜或飙升，搜索词或核心词；每个词的搜索人气、点击率、支付转化率、飙升幅度。可按关键词筛选。数值是区间。',
    annotations: RO,
    inputSchema: obj({
      shop: shopArg, category_id: categoryArg, period: periodArg, date: dateArg,
      rank_type: { type: 'string', enum: ['hot', 'soar'], default: 'hot', description: 'hot 热搜 / soar 飙升' },
      word_type: { type: 'string', enum: ['search', 'core'], default: 'search', description: 'search 搜索词 / core 核心词' },
      keyword: { type: 'string', description: '只看包含这个词的' },
      page: pageArg, page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    }, ['category_id']),
    run: mktWords,
  },
  {
    name: 'tb_competitors',
    description: '竞店监控：在生意参谋里设置的监控竞店，各自的支付买家数、访客数（区间）和变化、标签（交易大增 / 流量大增…）、动态（上新、报名活动）。',
    annotations: RO,
    inputSchema: obj({ shop: shopArg, period: periodArg, date: dateArg, page: pageArg, page_size: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }),
    run: competitors,
  },
  {
    name: 'tb_orders',
    description: '订单（千牛「已卖出的宝贝」）：按标签（全部近 3 个月、待付款、待发货、即将 / 已经发货超时、已发货、退款中、成功、关闭、3 个月前）筛选翻页，'
      + '每单的订单号、下单时间、状态、实付、运费说明、商品（标题、SKU、商家编码、数量、金额、退款等状态）；附待发货 / 超时计数。不输出买家信息。',
    annotations: RO,
    inputSchema: obj({
      shop: shopArg,
      tab: { type: 'string', enum: Object.keys(ORDER_TABS), default: 'latest3Months', description: Object.entries(ORDER_TABS).map(([k, v]) => `${k} ${v}`).join(' / ') },
      page: pageArg,
    }),
    run: orders,
  },
  {
    name: 'tb_products',
    description: '商品列表（千牛「我的宝贝」）：出售中 / 仓库中，每个商品的标题、商家编码、价格、库存、近 30 天销量、类目、上架时间、状态、基础质量分和流量标签；附总数。',
    annotations: RO,
    inputSchema: obj({
      shop: shopArg,
      tab: { type: 'string', enum: Object.keys(PRODUCT_TABS), default: 'on_sale', description: 'on_sale 出售中 / in_stock 仓库中' },
      page: pageArg, page_size: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    }),
    run: products,
  },
];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** 按 inputSchema 做参数检查：未知参数、必填、类型、枚举、范围 */
function checkArgs(tool, args) {
  const { properties, required = [] } = tool.inputSchema;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new QueryError('arguments 必须是对象。');
  for (const key of Object.keys(args)) if (!Object.hasOwn(properties, key)) throw new QueryError(`未知参数：${key}`);
  for (const key of required) if (args[key] === undefined || args[key] === '') throw new QueryError(`缺少参数：${key}`);
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (spec.type === 'integer' && !Number.isInteger(value)) throw new QueryError(`${key} 必须是整数。`);
    if (spec.type === 'string' && typeof value !== 'string') throw new QueryError(`${key} 必须是字符串。`);
    if (spec.type === 'boolean' && typeof value !== 'boolean') throw new QueryError(`${key} 必须是 true / false。`);
    if (spec.type === 'array') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new QueryError(`${key} 必须是字符串数组。`);
      const allowed = spec.items?.enum;
      if (allowed) for (const v of value) if (!allowed.includes(v)) throw new QueryError(`${key} 里的值只能是：${allowed.join('、')}`);
      if (spec.maxItems !== undefined && value.length > spec.maxItems) throw new QueryError(`${key} 最多 ${spec.maxItems} 项。`);
    }
    if (spec.enum && !spec.enum.includes(value)) throw new QueryError(`${key} 只能是：${spec.enum.join('、')}`);
    if (spec.minimum !== undefined && value < spec.minimum) throw new QueryError(`${key} 不能小于 ${spec.minimum}。`);
    if (spec.maximum !== undefined && value > spec.maximum) throw new QueryError(`${key} 不能大于 ${spec.maximum}。`);
  }
}

async function callTool(name, args) {
  const tool = BY_NAME.get(name);
  if (!tool) return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
  try {
    const input = args ?? {};
    checkArgs(tool, input);
    precheck(input);
    return { content: [{ type: 'text', text: JSON.stringify(await tool.run(input)) }] };
  } catch (error) {
    if (!isUserError(error)) process.stderr.write(`[taobao-seller-mcp] ${error?.stack ?? error}\n`);
    return { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true };
  }
}

const listed = TOOLS.map(({ run, ...tool }) => tool);

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'taobao-seller-mcp', version: VERSION },
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listed };
    case 'tools/call':
      return callTool(params?.name, params?.arguments);
    default:
      if (id === undefined) return undefined; // 通知（如 notifications/initialized）不回复
      throw Object.assign(new Error(`不支持的方法：${method}`), { code: -32601 });
  }
}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`taobao-seller-mcp ${VERSION}
淘宝 / 天猫卖家 MCP（stdio）：通过本机紫鸟店铺浏览器里已登录的千牛 / 生意参谋取经营数据、流量、商品排行、订单和商品。

环境变量：
  TB_SHOPS     店铺数组 JSON，如 [{"name":"天猫店","store_id":"12345678901234","default":true}]
  TB_STORE_ID  只有一家店时可以只设紫鸟店铺 ID
  TB_DATA_DIR  浏览器锁文件目录（默认 ~/.taobao-seller-mcp）
  ZINIAO_CLI   ziniao-cli 命令路径（默认自动查找）
`);
  process.exit(0);
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: 'JSON 解析失败' } });
    return;
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    send({ id: null, error: { code: -32600, message: '请求必须是 JSON 对象' } });
    return;
  }
  try {
    const result = await handle(message);
    if (message.id !== undefined && result !== undefined) send({ id: message.id, result });
  } catch (error) {
    if (message.id !== undefined) send({ id: message.id, error: { code: error.code ?? -32603, message: String(error.message ?? error) } });
  }
}).on('close', () => process.exit(0));
