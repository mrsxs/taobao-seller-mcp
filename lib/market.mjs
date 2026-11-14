// 生意参谋「市场」免费版（普惠版，/mc/free/...）：类目、类目商品 / 店铺排行、搜索词排行（热搜 / 飙升）、类目大盘、价格段、
// 类目洞察（价格带热销商品、属性分析）、竞店监控。
// 免费版的指标给的是区间（如「7500 ~ 1万」「10% ~ 15%」），不是精确值；这里原样输出区间文字。
// 只能看这家店经营的类目（getCateInfo 返回的那些）。
import { SycmError } from './sycm.mjs';

const FREE = { marketVersion: 'free' };
const val = (o) => {
  const v = o && typeof o === 'object' && 'value' in o ? o.value : o;
  return typeof v === 'string' || typeof v === 'number' ? v : null;
};
const round = (v, d = 4) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v ?? null);
const rangeQuery = (r) => ({ dateType: r.period, dateRange: `${r.start}|${r.end}` });

/** getCateInfo 行：[父类目, 类目, 名称, cateFlag(1 一级 / 2 二级 / 0 更深), 版本, 是否叶子 'Y'/'N', 一级类目 ID, 一级类目名] */
export function parseMarketCategories(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => Array.isArray(r) && r.length >= 6).map((r) => ({
    id: Number(r[1]), parent_id: Number(r[0]), name: String(r[2]), cate_flag: Number(r[3]), leaf: r[5] === 'Y',
  }));
  const byId = new Map(list.map((c) => [c.id, c]));
  for (const c of list) {
    const path = [];
    for (let x = c, guard = 0; x && guard < 8; x = byId.get(x.parent_id), guard++) path.unshift(x.name);
    c.path = path.join(' / ');
  }
  return list;
}

export async function marketCategories(get) {
  const list = parseMarketCategories(await get('/mc/common/free/getCateInfo.json', FREE));
  if (!list.length) throw new SycmError('生意参谋「市场」没有返回可看的类目（可能没开通市场免费版）');
  return list;
}

export function findMarketCategory(list, id) {
  const cat = list.find((c) => c.id === Number(id));
  if (!cat) {
    const sample = list.filter((c) => c.leaf).slice(0, 5).map((c) => `${c.id} ${c.name}`).join('、');
    throw new SycmError(`类目 ${id} 不在这家店能看的市场类目里；用 tb_market_categories 查，例如：${sample}`);
  }
  return cat;
}

export function searchMarketCategories(list, { query, limit = 50 } = {}) {
  const q = String(query ?? '').toLowerCase();
  const hits = q ? list.filter((c) => c.path.toLowerCase().includes(q)) : list;
  return { total: hits.length, categories: hits.slice(0, limit).map(({ id, name, path, leaf }) => ({ id, name, path, leaf })) };
}

/** 店铺链接只留 https://域名/路径，去掉参数（防止带出跟踪参数或 ID） */
export function cleanUrl(u) {
  if (!u || typeof u !== 'string') return null;
  try {
    const x = new URL(`https:${u.trim().replace(/^https?:/, '')}`);
    return `https://${x.host}${x.pathname === '/' ? '' : x.pathname}`;
  } catch {
    return null;
  }
}

export const itemUrl = (item, isTmall) => (item?.itemId ? `${isTmall ? 'https://detail.tmall.com' : 'https://item.taobao.com'}/item.htm?id=${item.itemId}` : null);

export function parseMarketItem(r) {
  return {
    rank: val(r.cateRankId),
    rank_change: round(r.cateRankId?.cycleCqc),
    product_id: String(val(r.itemId) ?? r.item?.itemId ?? ''),
    title: r.item?.title ?? null,
    url: itemUrl(r.item, r.shop?.b2CShop === true),
    shop: r.shop?.title ?? null,
    tmall: r.shop?.b2CShop === true,
    pay_buyers: val(r.payByrCnt),
    visitors: val(r.uv),
    core_keywords: val(r.coreKeyWord) ? String(val(r.coreKeyWord)).split(',') : [],
    is_mine: val(r.isSelfItem) === true || r.isSelfItem?.value === true,
    // 流量榜、加购收藏榜才有的指标
    ...(r.searchUv ? { search_visitors: val(r.searchUv) } : {}),
    ...(r.cartByrCnt ? { add_to_cart_buyers: val(r.cartByrCnt) } : {}),
    ...(r.cltByrCnt ? { collect_buyers: val(r.cltByrCnt) } : {}),
  };
}

export function parseMarketShop(r) {
  return {
    rank: val(r.cateRankId),
    rank_change: round(r.cateRankId?.cycleCqc),
    shop: r.shop?.title ?? null,
    shop_url: cleanUrl(r.shop?.shopUrl),
    tmall: r.shop?.b2CShop === true,
    pay_buyers: val(r.payByrCnt),
    visitors: val(r.uv),
    items_on_sale: val(r.saleItemCnt),
    is_mine: r.isSelfShop?.value === true,
  };
}

// 市场排行的榜单：不同榜单走不同接口、带不同指标。shops 只有 pay_buyers / growth
export const RANK_BY = {
  pay_buyers: { label: '交易总量', rankType: 'gmv', path: 'rank', indexCode: 'payByrCnt,uv', shops: true },
  growth: { label: '交易增速', rankType: 'growth', path: 'rank', indexCode: 'payByrCnt,uv', shops: true },
  visitors: { label: '流量总量', rankType: 'flow', path: 'rank/search', indexCode: 'uv,searchUv' },
  add_to_cart: { label: '加购收藏', rankType: 'add', path: 'rank/purpose', indexCode: 'cartByrCnt,cltByrCnt,uv' },
  new_items: { label: '新品流量', rankType: 'newitm_ipv', path: 'rank', indexCode: 'uv,payByrCnt,cartByrCnt' },
};

/** 类目排行：items 商品 / shops 店铺；rank_by 见 RANK_BY；price_segment 来自 priceSegments() */
export async function marketRank(get, range, cat, { type = 'items', rankBy = 'pay_buyers', priceSegment = '', page = 1, pageSize = 20 } = {}) {
  const spec = RANK_BY[rankBy];
  if (!spec) throw new SycmError(`rank_by 只能是：${Object.keys(RANK_BY).join('、')}`);
  if (type === 'shops' && !spec.shops) throw new SycmError(`店铺排行只支持 rank_by=pay_buyers / growth（${rankBy} 只有商品排行）`);
  const common = { ...rangeQuery(range), pageSize, page, cateId: cat.id, rankType: spec.rankType, sellerType: -1, cateFlag: cat.cate_flag, keyWord: '', priceSeg: priceSegment, ...FREE };
  const sorted = spec.path === 'rank' ? {} : { order: '', orderBy: '' };
  const d = type === 'shops'
    ? await get('/mc/mq/mkt/shop/offline/rank.json', common)
    : await get(`/mc/mq/mkt/item/offline/${spec.path}.json`, { ...common, ...sorted, minPrice: '', maxPrice: '', indexCode: spec.indexCode });
  const rows = Array.isArray(d) ? d : d?.data || [];
  // 没数据时（如新品榜）接口直接给空数组，没有 recordCount
  return { rank_by: spec.label, total: d?.recordCount ?? (Array.isArray(d) ? d.length : null), [type]: rows.map(type === 'shops' ? parseMarketShop : parseMarketItem) };
}

export async function priceSegments(get, range, cat) {
  const d = await get('/mc/mq/mkt/priceSeg/list.json', { ...rangeQuery(range), cateId: cat.id, sellerType: 0, ...FREE });
  return (Array.isArray(d) ? d : []).map((s) => ({ id: String(s.priceSegId), range: s.priceSegName }));
}

export function parseMarketWord(r) {
  const out = {
    rank: val(r.rn),
    keyword: val(r.searchWord),
    search_popularity: val(r.seIpvUvHits),
    click_rate: round(val(r.clickThroughRate)),
    pay_rate: val(r.payRate),
  };
  if (r.seUvEx) out.rise = round(val(r.seUvEx));
  return out;
}

/** 搜索词排行：rank_type hot 热搜 / soar 飙升；word_type search 搜索词 / core 核心词；keyword 只看包含这个词的 */
export async function marketSearchWords(get, range, cat, { rankType = 'hot', wordType = 'search', keyword = '', page = 1, pageSize = 20 } = {}) {
  const d = await get('/mc/mq/mkt/keyword/rank/pro.json', {
    ...rangeQuery(range), pageSize, page, order: 'desc', orderBy: 'seIpvUvHits', kwType: wordType, rankType, cateId: cat.id, keyWord: keyword, device: 0, ...FREE,
  });
  return { total: d?.recordCount ?? null, words: (d?.data || []).map(parseMarketWord) };
}

/** 类目大盘（类目挖掘）：只支持非一级类目 */
export async function categoryOverview(get, range, cat) {
  if (cat.cate_flag === 1) throw new SycmError('类目大盘要选二级或更细的类目（一级类目不支持）');
  const d = await get('/mc/cate/mining/analysis/detail.json', {
    ...rangeQuery(range), pageSize: 10, page: 1, order: 'desc', orderBy: 'payByrCnt', indType: 'pay_ord_amt', cateId: cat.id, sellerType: -1,
    indexCode: 'payByrCnt,payOrdAmtRate,payAmtGrowRate,supplyDemandRate', ...FREE,
  });
  const r = (d?.data || [])[0];
  if (!r) return null;
  return {
    category: val(r.cateName),
    pay_buyers: val(r.payByrCnt),
    pay_amount_share: val(r.payOrdAmtRate),
    pay_amount_growth: val(r.payAmtGrowRate),
    supply_demand: round(val(r.supplyDemandRate)),
  };
}

export function parseRivalShop(r) {
  return {
    shop: r.shop?.title ?? null,
    shop_url: cleanUrl(r.shop?.shopUrl),
    tmall: r.shop?.b2CShop === true,
    location: [r.shop?.province, r.shop?.city].filter(Boolean).join(' ') || null,
    pay_buyers: val(r.payByrCntIndexFree),
    pay_buyers_change: r.payByrCntIndexFree?.cycleCrc ?? r.payByrCntCycleCrc ?? null,
    visitors: val(r.uvIndexFree),
    visitors_change: r.uvIndexFree?.cycleCrc ?? r.uvCycleCrc ?? null,
    tags: (r.tagList || []).map((t) => t?.tagName).filter(Boolean),
    news: typeof r.info === 'string' ? r.info : null,
  };
}

/** 竞店监控：卖家在生意参谋里设置的监控竞店 */
export async function rivalShops(get, range, { page = 1, pageSize = 20 } = {}) {
  const d = await get('/mc/ci/free/v2/shop/monitor/listShop/page.json', {
    ...rangeQuery(range), pageSize, page, order: 'desc', orderBy: 'payByrCntIndexFree', sellerType: -1,
    indexCode: 'payByrCntIndexFree,payByrCntCycleCrc,uvIndexFree,uvCycleCrc', ...FREE,
  });
  return { total: d?.recordCount ?? null, shops: (d?.data || []).map(parseRivalShop) };
}

// ---- 类目洞察：价格带、属性分析 ----

// 价格带 / 属性值按「增长 × 成交」分的象限（生意参谋页面上的建议原文）
const QUADRANTS = {
  HgHp: '增长快、成交多：可采取发展策略，保持与市场同步增长',
  HgLp: '增长快、成交少：可选择性投资，优化产品长期孵化',
  LgHp: '增长慢、成交多：可重点防御，稳住现有收益',
  LgLp: '增长慢、成交少',
};
const isTmallItem = (item) => item?.isMallItem === true || /tm_item_redirect/.test(item?.detailUrl || '');

/** 价格带：priceseg/analysis 按象限分组返回，这里摊平后按 ID 排 */
export function parsePriceBands(d) {
  // 没数据时接口给 null 或空数组
  if (d == null || (Array.isArray(d) && !d.length)) return [];
  if (typeof d !== 'object' || Array.isArray(d)) throw new SycmError('生意参谋返回的价格带格式不对（接口可能改版了）');
  const out = [];
  for (const [key, rows] of Object.entries(d)) {
    for (const r of Array.isArray(rows) ? rows : []) {
      const id = val(r.priceRangeId);
      if (id === null) continue;
      out.push({ id: String(id), range: val(r.priceRangeName), pay_buyers: val(r.payByrCnt), quadrant: QUADRANTS[key] ?? key });
    }
  }
  return out.sort((a, b) => Number(a.id) - Number(b.id));
}

export async function priceBands(get, range, cat) {
  return parsePriceBands(await get('/mc/mq/mkt/cate/insights/priceseg/analysis.json', {
    ...rangeQuery(range), cateId: cat.id, sellerType: -1, indType: 'pay_ord_amt', ...FREE,
  }));
}

/** 价格带 / 属性值下的热销商品：件单价 = 支付金额 ÷ 支付件数（成交均价，含优惠、跨 SKU 平均，不是标价） */
export function parseHotItem(r) {
  const tmall = isTmallItem(r.item);
  const price = val(r.perItemAmt);
  return {
    product_id: String(val(r.itemId) ?? r.item?.itemId ?? ''),
    title: r.item?.title ?? null,
    url: itemUrl(r.item, tmall),
    tmall,
    pay_orders: val(r.payMentVolume),
    unit_price: typeof price === 'number' ? round(price, 2) : price,
    ...(r.payAmt ? { pay_amount: val(r.payAmt) } : {}),
  };
}

const HOT_QUERY = { pageSize: 10, page: 1, order: 'desc', orderBy: 'payMentVolume', indType: 'pay_ord_amt', sellerType: -1, indexCode: 'payMentVolume,perItemAmt', ...FREE };

/** 某个价格带里卖得最好的商品（接口一次给前 50 个） */
export async function priceBandItems(get, range, cat, bandId) {
  const d = await get('/mc/mq/mkt/cate/insights/priceseg/item/hotsale.json', { ...rangeQuery(range), ...HOT_QUERY, cateId: cat.id, priceRangeId: bandId });
  return (Array.isArray(d) ? d : d?.data || []).map(parseHotItem);
}

/** 类目可分析的属性（品牌、尺码、颜色分类…） */
export async function attributeList(get, cat) {
  const d = await get('/mc/mq/cate/insights/prop/list.json', { cateId: cat.id, ...FREE });
  return (Array.isArray(d) ? d : []).filter((p) => p && p.id != null).map((p) => ({ id: String(p.id), name: String(p.name ?? '') }));
}

/** 属性名或 ID → 属性 ID；找不到时列出可选的 */
export function resolveAttributes(list, wanted) {
  const props = wanted.map((w) => {
    const q = String(w).trim();
    const hit = list.find((p) => p.id === q || p.name === q);
    if (!hit) throw new SycmError(`这个类目没有属性「${q}」；可选：${list.map((p) => p.name).join('、') || '（无）'}`);
    return hit;
  });
  if (new Set(props.map((p) => p.id)).size !== props.length) throw new SycmError('attributes 里的两个属性是同一个');
  return props;
}

export function parseAttributeValue(r) {
  return {
    value: val(r.valueName),
    value_ids: val(r.valueIds) === null ? null : String(val(r.valueIds)),
    pay_buyers: val(r.payByrCnt),
    pay_amount_share: val(r.payOrdAmtRate),
    pay_amount_growth: val(r.payAmtGrowRate),
    active_items_growth: round(val(r.dynamicPctSaleRate)),
  };
}

/** 属性分析明细：按 1~2 个属性的取值组合看支付买家数、支付金额占比和增速、动销商品增速 */
export async function attributeAnalysis(get, range, cat, propIds, { page = 1, pageSize = 20 } = {}) {
  const d = await get('/mc/mq/cate/insights/prop/detail.json', {
    ...rangeQuery(range), pageSize, page, order: 'desc', orderBy: 'payByrCnt', propIds: propIds.join(','), indType: 'pay_ord_amt',
    cateId: cat.id, sellerType: -1, indexCode: 'payByrCnt,payOrdAmtRate,payAmtGrowRate,dynamicPctSaleRate', ...FREE,
  });
  return { total: d?.recordCount ?? null, values: (d?.data || []).map(parseAttributeValue) };
}

/** 某个属性值组合下卖得最好的商品；value_ids 和 prop_ids 一一对应（来自 attributeAnalysis 的 value_ids） */
export async function attributeItems(get, range, cat, propIds, valueIds) {
  const d = await get('/mc/mq/cate/insights/prop/hotitem/security.json', { ...rangeQuery(range), ...HOT_QUERY, cateId: cat.id, propIds: propIds.join(','), valueIds });
  return (Array.isArray(d) ? d : d?.data || []).map(parseHotItem);
}
