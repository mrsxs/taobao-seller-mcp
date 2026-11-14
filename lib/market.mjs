// 生意参谋「市场」免费版（/mc/free/...）：类目、类目商品 / 店铺排行、搜索词排行（热搜 / 飙升）、类目大盘、价格段、竞店监控。
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

const itemUrl = (item, isTmall) => (item?.itemId ? `${isTmall ? 'https://detail.tmall.com' : 'https://item.taobao.com'}/item.htm?id=${item.itemId}` : null);

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
  };
}

export function parseMarketShop(r) {
  return {
    rank: val(r.cateRankId),
    rank_change: round(r.cateRankId?.cycleCqc),
    shop: r.shop?.title ?? null,
    shop_url: r.shop?.shopUrl ? `https:${r.shop.shopUrl.replace(/^https?:/, '')}` : null,
    tmall: r.shop?.b2CShop === true,
    pay_buyers: val(r.payByrCnt),
    visitors: val(r.uv),
    items_on_sale: val(r.saleItemCnt),
    is_mine: r.isSelfShop?.value === true,
  };
}

/** 类目排行：items 商品 / shops 店铺，按交易排；price_segment 来自 priceSegments() */
export async function marketRank(get, range, cat, { type = 'items', priceSegment = '', page = 1, pageSize = 20 } = {}) {
  const common = { ...rangeQuery(range), pageSize, page, cateId: cat.id, rankType: 'gmv', sellerType: -1, cateFlag: cat.cate_flag, keyWord: '', priceSeg: priceSegment, ...FREE };
  const d = type === 'shops'
    ? await get('/mc/mq/mkt/shop/offline/rank.json', common)
    : await get('/mc/mq/mkt/item/offline/rank.json', { ...common, minPrice: '', maxPrice: '', indexCode: 'payByrCnt,uv' });
  return { total: d?.recordCount ?? null, [type]: (d?.data || []).map(type === 'shops' ? parseMarketShop : parseMarketItem) };
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
    shop_url: r.shop?.shopUrl ? `https:${r.shop.shopUrl.replace(/^https?:/, '')}` : null,
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
