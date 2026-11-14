// 生意参谋「市场 → 竞争」免费版（普惠版）：竞店对比、竞品流失。
// 竞店对比只能选生意参谋里已经设置监控的竞店；竞店指标是区间，本店是精确值。
// 接口里的竞店 userId 是加密串，只在内部用来查询，不输出。
import { optional } from './cooldown.mjs';
import { cleanUrl, itemUrl } from './market.mjs';
import { SycmError } from './sycm.mjs';

const FREE = { marketVersion: 'free' };
const val = (o) => {
  const v = o && typeof o === 'object' && 'value' in o ? o.value : o;
  return typeof v === 'string' || typeof v === 'number' ? v : null;
};
const round = (v, d = 4) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v ?? null);
const rangeQuery = (r) => ({ dateType: r.period, dateRange: `${r.start}|${r.end}` });
// 生意参谋的日期时间戳是北京时间 0 点
const bjDate = (ms) => (Number.isFinite(ms) ? new Date(ms + 8 * 3600_000).toISOString().slice(0, 10) : null);
const isTmallItem = (item) => item?.isMallItem === true || /tm_item_redirect/.test(item?.detailUrl || '');

// 竞店对比的指标
export const SHOP_METRICS = {
  visitors: { code: 'uv', label: '访客数' },
  pay_buyers: { code: 'payByrCnt', label: '支付买家数' },
  pay_rate: { code: 'payRate', label: '支付转化率' },
  add_to_cart: { code: 'cartByrCnt', label: '加购人数' },
  collect: { code: 'cltByrCnt', label: '收藏人数' },
};

/** 生意参谋里设置监控的竞店（含加密 userId，仅内部用） */
export async function monitoredShops(get) {
  const d = await get('/mc/ci/free/config/rival/shop/getMonitoredListExcludeGreatShop.json', FREE);
  const rows = d == null ? [] : Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : null;
  if (!rows) throw new SycmError('生意参谋返回的监控竞店列表格式不对（接口可能改版了）');
  return rows.filter((s) => s && s.userId && s.name).map((s) => ({
    name: String(s.name),
    tmall: s.b2CShop === true,
    url: cleanUrl(s.linkUrl),
    userId: String(s.userId),
  }));
}

export const publicShop = ({ userId, ...rest }) => rest;

/** 按店名找监控竞店：先全等，再包含；找不到或有歧义时列出可选的 */
export function pickRivals(list, names) {
  const options = () => list.map((s) => s.name).join('、') || '（还没有设置监控竞店）';
  return names.map((name) => {
    const q = String(name).trim();
    const exact = list.filter((s) => s.name === q);
    const hits = exact.length ? exact : list.filter((s) => s.name.includes(q));
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new SycmError(`「${q}」不在生意参谋的监控竞店里（竞店对比只能选监控竞店，要先在生意参谋「竞争 → 竞店监控」里添加）。可选：${options()}`);
    throw new SycmError(`「${q}」匹配到多家竞店：${hits.map((s) => s.name).join('、')}，请写完整店名`);
  });
}

const pickMetrics = (o) => Object.fromEntries(Object.entries(SHOP_METRICS).map(([k, m]) => {
  const v = val(o?.[m.code]);
  return [k, m.code === 'payRate' && typeof v === 'number' ? round(v) : v];
}));

/** 核心指标：本店精确值，竞店区间 */
export function parseCoreIndexes(d, rivals) {
  return {
    mine: pickMetrics(d?.selfShop),
    rivals: rivals.map((r, i) => ({ shop: r.name, ...pickMetrics(d?.[`rivalShop${i + 1}`]) })),
  };
}

/** 每日走势：statDate 和指标值是并列数组 */
export function parseCoreTrend(d, code, rivals) {
  const series = (o) => {
    const v = o?.[code];
    return Array.isArray(v) ? v : Array.isArray(v?.value) ? v.value : [];
  };
  const arr = (v) => (Array.isArray(v) ? v : Array.isArray(v?.value) ? v.value : null);
  const self = d?.selfShop;
  const dates = (arr(self?.statDate) || arr(d?.rivalShop1?.statDate) || []).map(bjDate);
  const mine = series(self);
  const others = rivals.map((_, i) => series(d?.[`rivalShop${i + 1}`]));
  return dates.map((date, j) => ({
    date,
    mine: code === 'payRate' && typeof mine[j] === 'number' ? round(mine[j]) : mine[j] ?? null,
    ...Object.fromEntries(rivals.map((r, i) => [r.name, others[i][j] ?? null])),
  }));
}

export function parseRivalTopItem(r, topBy = 'pay_buyers') {
  const tmall = isTmallItem(r.item);
  const metric = topBy === 'visitors' ? 'uv' : 'payByrCnt';
  return {
    product_id: String(val(r.itemId) ?? r.item?.itemId ?? ''),
    title: r.item?.title ?? null,
    url: itemUrl(r.item, tmall),
    [topBy === 'visitors' ? 'visitors' : 'pay_buyers']: val(r[metric]),
    change: r[metric]?.cycleCrc ?? null,
  };
}

/**
 * 竞店对比：本店 vs 1~2 家监控竞店的核心指标、某个指标的近 30 天每日走势、各竞店的热门商品和动态。
 * top_by：visitors 按访客 / pay_buyers 按支付买家
 */
export async function shopCompare(get, range, rivals, { metric = 'visitors', topBy = 'pay_buyers', topLimit = 10 } = {}) {
  const m = SHOP_METRICS[metric];
  if (!m) throw new SycmError(`metric 只能是：${Object.keys(SHOP_METRICS).join('、')}`);
  const q = { ...rangeQuery(range), rivalUser1Id: rivals[0]?.userId ?? '', rivalUser2Id: rivals[1]?.userId ?? '', ...FREE };
  const topCode = topBy === 'visitors' ? 'uv' : 'payByrCnt';
  // 一个接一个发（不并发）：前一个触发安全验证就不再发后面的
  const idx = await get('/mc/mq/rivalShop/analysis/getCoreIndexes.json', q);
  const trend = await get('/mc/mq/rivalShop/analysis/getCoreTrend.json', { ...q, indexCode: m.code });
  const perRival = [];
  for (const r of rivals) {
    const top = await get('/mc/mq/rivalShop/analysis/getTopItems/page.json', {
      ...rangeQuery(range), orderBy: topCode, rivalUserId: r.userId, topType: topBy === 'visitors' ? 'uv' : 'trade', indexCode: topCode, ...FREE,
    });
    const news = await optional(get('/mc/mq/mkt/offline/rival/operation/summary.json', { ...rangeQuery(range), rivalSellerId: r.userId, ...FREE }), null);
    perRival.push({
      shop: r.name,
      tmall: r.tmall,
      url: r.url,
      news: typeof news?.info === 'string' ? news.info : null,
      top_items: (Array.isArray(top) ? top : top?.data || []).slice(0, topLimit).map((row) => parseRivalTopItem(row, topBy)),
    });
  }
  return {
    core: parseCoreIndexes(idx, rivals),
    trend: { metric: m.label, days: parseCoreTrend(trend, m.code, rivals) },
    rivals: perRival,
  };
}

// ---- 竞品流失 ----

export function parseLossItem(r) {
  return {
    product_id: String(val(r.itemId) ?? r.item?.itemId ?? ''),
    title: r.item?.title ?? null,
    lost_pay_amount: round(val(r.payLostAmt), 2),
    lost_buyers: val(r.losByrCnt),
    loss_rate: round(val(r.losRate)),
    lost_collect_buyers: val(r.cltLosByrCnt),
    lost_cart_buyers: val(r.cartLosByrCnt),
    lost_to_items: val(r.losItmCnt),
    lost_to_shops: val(r.losShopCnt),
  };
}

/** 本店哪些商品的买家流失到了竞品：流失金额、流失人数、流失率、收藏 / 加购后流失、流失去向的商品数和店铺数 */
export async function lossItems(get, range, cateId, { page = 1, pageSize = 20 } = {}) {
  const d = await get('/mc/free/ci/item/view/drain/recognition.json', {
    ...rangeQuery(range), pageSize, page, order: 'desc', orderBy: 'payLostAmt', cateId,
    indexCode: 'payLostAmt,losByrCnt,losRate,cltLosByrCnt,cartLosByrCnt', ...FREE,
  });
  return { total: d?.recordCount ?? null, items: (d?.data || []).map(parseLossItem) };
}

/** 流失去向（单日、主营类目）：本店访客流失最多的竞品和竞店，lost_index 是流失指数，只比较相对大小 */
export function parseLossTargets(d) {
  return {
    main_category: d?.mainCateName ?? null,
    items: (d?.top5ItemResult || []).map((r) => {
      const tmall = isTmallItem(r.item);
      return {
        product_id: String(val(r.itemId) ?? r.item?.itemId ?? ''),
        title: r.item?.title ?? null,
        url: itemUrl(r.item, tmall),
        lost_index: round(val(r.lostIndex), 1),
      };
    }),
    shops: (d?.top5ShopResult || []).map((r) => ({
      shop: r.shop?.title ?? null,
      tmall: r.shop?.b2CShop === true,
      shop_url: cleanUrl(r.shop?.shopUrl),
      lost_index: round(val(r.lostIndex), 1),
    })),
  };
}

export async function lossTargets(get, day) {
  return parseLossTargets(await get('/mc/free/ci/shop/getRivalDrain.json', { dateType: 'day', dateRange: `${day}|${day}`, ...FREE }));
}
