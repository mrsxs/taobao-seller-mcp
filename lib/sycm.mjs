// 生意参谋（sycm.taobao.com）：经营概况、每日走势、今日实时、流量来源、商品排行、单品分析、引流搜索词、推广。
// 接口都是 GET JSON，带页面里的 legalityToken；在生意参谋标签页里用原生 fetch 发（lib/page-request.mjs）。
// 日期是北京时间的自然日；最新数据通常到昨天，准确日期用 latestDate() 问接口。
import { optional } from './cooldown.mjs';
import { hasRiskText, isRiskJson, redact } from './risk.mjs';
import { requestInPage, requestManyInPage } from './page-request.mjs';

export const SYCM_ORIGIN = 'https://sycm.taobao.com';

export class SycmError extends Error {}

// ---- 时间口径 ----
export const PERIODS = ['day', 'recent7', 'recent30'];
const PERIOD_DAYS = { day: 1, recent7: 7, recent30: 30 };
const DAY_MS = 86_400_000;

export function assertDate(date, label = 'date') {
  const s = String(date ?? '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== s) throw new SycmError(`${label} 应是 YYYY-MM-DD 格式的日期`);
  return s;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

export function periodRange(period, end) {
  const days = PERIOD_DAYS[period];
  if (!days) throw new SycmError(`period 只能是：${PERIODS.join('、')}`);
  return { period, start: addDays(end, 1 - days), end, days };
}

/** date 不填用最新出数日，填了不能晚于它；latest(fresh) 返回 'YYYY-MM-DD' */
export async function resolveRange({ period = 'recent7', date } = {}, latest) {
  if (date) assertDate(date);
  let newest = await latest();
  if (date && date > newest) newest = await latest(true);
  const end = date || newest;
  if (end > newest) throw new SycmError(`生意参谋的数据最新到 ${newest}，date 不能晚于它`);
  return periodRange(period, end);
}

const rangeQuery = (r) => ({ dateType: r.period, dateRange: `${r.start}|${r.end}` });

// ---- 客户端 ----

export async function sycmContext(cdp) {
  const token = await cdp.evaluate('(window.metaCacheData && window.metaCacheData.legalityToken) || ""', 5000);
  if (!token) throw new SycmError('生意参谋页面没有就绪（拿不到 token）：请确认紫鸟店铺浏览器里能正常打开生意参谋');
  return { token };
}

const LOGIN_EXPIRED = '生意参谋登录已失效，请在紫鸟店铺浏览器里重新登录千牛 / 生意参谋';
const VERIFY = '触发了淘宝安全验证（滑块 / 验证码），请在紫鸟店铺浏览器里打开生意参谋手动完成验证后再试，不要反复重试';

/** 返回的是 HTML 时分辨：安全验证 / 登录页 / 其他（网关错误等） */
export function explainHtml(r, fallback) {
  const head = `${r?.url ?? ''} ${String(r?.text ?? '').slice(0, 3000)}`;
  // 明确的拦截页优先；登录页本身也会加载滑块脚本，所以 captcha / baxia 这类弱信号放在登录判断之后
  if (/punish|x5sec|_____tmd_____/i.test(head)) return VERIFY;
  if (/login\.(taobao|tmall)\.com|loginmyseller|<title>[^<]*登录/i.test(head)) return LOGIN_EXPIRED;
  if (/captcha|baxia|nocaptcha|滑块/i.test(head)) return VERIFY;
  return fallback;
}

export function explainSycm(path, body, status) {
  const msg = String(body?.message || body?.msg || '');
  // 明确的风控信号优先于状态码和登录判断（「请登录验证」「403 + 请完成安全验证」都是验证）
  if (hasRiskText(msg)) return VERIFY;
  if (status === 401 || status === 403) return '生意参谋登录已失效，请在紫鸟店铺浏览器里重新登录千牛 / 生意参谋';
  if (/登录|login/i.test(msg)) return '生意参谋登录已失效，请在紫鸟店铺浏览器里重新登录千牛 / 生意参谋';
  if (/权限|订购|无权/.test(msg)) return `生意参谋没有这个数据的权限（可能需要订购对应模块）：${redact(msg)}`;
  return `生意参谋接口失败（${path}）：${redact(msg) || `HTTP ${status}`}`;
}

export const isRiskBlock = isRiskJson;

/**
 * 返回 get(path, params) → data。响应有两种包法：{ content: { code, data } } 和 { code, data }。
 * get.many([[path, params], …]) → [data, …]：一次往返在页面里按顺序发，遇到验证 / 登录失效就停（后面的不发）。
 */
export function createSycmApi(cdp, ctx, request = requestInPage, requestMany = requestManyInPage) {
  const toReq = (path, params = {}) => {
    const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), token: ctx.token });
    return { url: `${SYCM_ORIGIN}${path}?${qs}` };
  };
  const parse = (path, r) => {
    if (!r || r.error) throw new Error(`生意参谋请求失败（${path}）：${redact(r?.error || '无返回')}`);
    if (r.redirected) throw new SycmError(LOGIN_EXPIRED);
    let json;
    try {
      json = JSON.parse(r.text);
    } catch {
      throw new SycmError(explainHtml(r, `生意参谋返回的不是 JSON（${path}，HTTP ${r.status}）`));
    }
    // 风控拦截时返回的是 mtop 风格的 JSON：{ ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::…'], data: { url: '…/_____tmd_____/punish?x5secdata=…' } }（也可能包在 content 里）
    if (isRiskJson(json)) throw new SycmError(VERIFY);
    const body = json?.content && typeof json.content === 'object' && 'code' in json.content ? json.content : json;
    if (body?.code !== 0 || json?.hasError || body?.hasError) throw new SycmError(explainSycm(path, body, r.status));
    return body.data;
  };
  async function get(path, params = {}) {
    return parse(path, await request(cdp, toReq(path, params)));
  }
  // optional：这几个下标出普通错误时给 null（安全验证、登录失效照样抛）
  get.many = async (calls, { optional = [] } = {}) => {
    const res = await requestMany(cdp, calls.map(([path, params]) => toReq(path, params)));
    // 页面在第一个被重定向 / 出错 / 返回验证页的请求后就停了：按顺序解析，出问题的那个会抛错
    return calls.map(([path], i) => {
      try {
        return parse(path, res?.[i]);
      } catch (err) {
        const hard = err instanceof SycmError && (err.message === VERIFY || err.message === LOGIN_EXPIRED);
        if (optional.includes(i) && !hard && res?.[i]) return null;
        throw err;
      }
    });
  };
  return get;
}

export async function latestDate(get) {
  const d = await get('/oneauth/api/commDateByLocation.json', { locationCodes: 'flow_monitor_overview' });
  const day = d?.flow_monitor_overview?.updateDay;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new SycmError('生意参谋没有返回最新数据日期');
  return day;
}

/** 店铺类型：bcSeller 1 = 天猫，0 = 淘宝；主营类目 */
export async function shopInfo(get) {
  const d = await get('/portal/shop/getMainCateInfo.json');
  // 没给明确的 bcSeller 时平台未知（不要默认当淘宝记住）
  const platform = d?.bcSeller === 1 ? 'tmall' : d?.bcSeller === 0 ? 'taobao' : null;
  return { platform, main_category: d?.cateLevel1Name ?? null, main_category_id: d?.cateLevel1Id ?? null };
}

// ---- 解析 ----

// 指标中文名取自生意参谋自己的指标字典（/portal/common/alias/group.json）
export const LABELS = {
  uv: '访客数', pv: '浏览量', itmUv: '商品访客数', itmPv: '商品浏览量', payAmt: '支付金额', payByrCnt: '支付买家数', payRate: '支付转化率',
  payPct: '客单价', uvValue: 'UV价值', newUv: '新访客数', oldUv: '老访客数', bounceRate: '跳失率', stayTime: '平均停留时长（秒）', avgPv: '人均浏览量',
  cartByrCnt: '加购人数', itmCltByrCnt: '商品收藏买家数', shopCltByrCnt: '关注店铺人数', newPayByrCnt: '支付新买家数', payOldByrCnt: '支付老买家数',
  orderAmt: '下单金额', orderBuyerCnt: '下单买家数', orderRate: '下单转化率', orderToPayRate: '下单-支付转化率',
  totalPromoSpend: '总推广花费', clicks: '推广点击量', tROI: '总 ROI', newPortalAdPayAmt: '广告引导成交金额',
  payItmCnt: '支付件数', payOrdCnt: '支付子订单数', netPaymentAmount: '净支付金额', rfdSucAmt: '退款金额（完结时间）', payShopRfdAmt: '退款金额（支付时间）',
  sucRefundRate: '成功退款率', payAmtRfdRate: '金额退款率', ordRfdRate: '订单退款率', olderPayAmt: '老买家支付金额', rePurchasePayAmount: '老客复购金额',
  hasPurchasedUbyCnt: '老客复购人数', consultRate: '咨询率', cartCnt: '加购件数', shopCustomer: '店铺客户数',
  admCostFamtQzt: '全站推广花费', tkExpendAmt: '淘宝客佣金', wwGoodCstEvaRate: '旺旺满意度', rfdFinshDur: '退款处理时长（天）', avgSignTimeHh: '物流到货时长（小时）',
  gotInTime24hRate: '24 小时揽收及时率',
};

const round = (v, digits = 4) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits : null);

/** 指标对象 { value, cycleCrc } 或带 xxxVariRate 的平铺对象 → { key: { label, value, change } }（只要 keys 里的） */
export function pickMetrics(obj, keys, { changeSuffix } = {}) {
  const out = {};
  for (const k of keys) {
    const raw = obj?.[k];
    if (raw === undefined) continue;
    const isObj = raw && typeof raw === 'object';
    const value = round(isObj ? raw.value : raw);
    if (value === null && !(isObj && raw.value === 0)) continue;
    const change = isObj ? round(raw.cycleCrc) : changeSuffix ? round(obj[`${k}${changeSuffix}`]) : null;
    out[k] = { label: LABELS[k] ?? k, value, ...(change !== null ? { change } : {}) };
  }
  return out;
}

const FLOW_KEYS = ['payAmt', 'payByrCnt', 'payRate', 'payPct', 'uv', 'pv', 'itmUv', 'uvValue', 'newUv', 'oldUv', 'bounceRate', 'stayTime', 'avgPv',
  'cartByrCnt', 'itmCltByrCnt', 'shopCltByrCnt', 'newPayByrCnt', 'payOldByrCnt'];
const SUMMARY_KEYS = ['orderAmt', 'orderBuyerCnt', 'orderRate', 'orderToPayRate'];
const PROMO_KEYS = ['totalPromoSpend', 'clicks', 'tROI', 'newPortalAdPayAmt'];
const CORE_DAY_KEYS = ['payItmCnt', 'payOrdCnt', 'netPaymentAmount', 'rfdSucAmt', 'payShopRfdAmt', 'sucRefundRate', 'payAmtRfdRate', 'ordRfdRate',
  'olderPayAmt', 'rePurchasePayAmount', 'hasPurchasedUbyCnt', 'consultRate', 'cartCnt', 'shopCustomer', 'admCostFamtQzt', 'tkExpendAmt',
  'wwGoodCstEvaRate', 'rfdFinshDur', 'avgSignTimeHh', 'gotInTime24hRate'];
const PEER_KEYS = ['payAmt', 'payByrCnt', 'payRate', 'payPct', 'uv', 'pv', 'cartByrCnt', 'sucRefundRate', 'consultRate'];

/** 同行对比：{ key: { label, avg, good } } */
export function pickPeers(rivalAvg, rivalGood, keys = PEER_KEYS) {
  const out = {};
  for (const k of keys) {
    const avg = round(rivalAvg?.[k]?.value);
    const good = round(rivalGood?.[k]?.value);
    if (avg !== null || good !== null) out[k] = { label: LABELS[k] ?? k, ...(avg !== null ? { avg } : {}), ...(good !== null ? { good } : {}) };
  }
  return out;
}

export async function storeOverview(get, range) {
  const q = rangeQuery(range);
  // 一个接一个发：前一个触发安全验证就不再发后面的；推广数据取不到不影响其他，但安全验证要抛出去
  const flow = await get('/flow/new/guide/trend/overview.json', { ...q, device: 0 });
  const summary = await get('/bda/tradinganaly/overview/get_summary.json', { ...q, device: 0 });
  const promo = await optional(get('/portal/board/grow/factor/overview.json', { ...q, device: 2 }), (err) => ({ __error: err.message }));
  const core = range.period === 'day' ? await get('/portal/coreIndex/new/overview/v3.json', { ...q, device: 0 }) : null;
  const out = {
    traffic_and_trade: pickMetrics(flow, FLOW_KEYS),
    order: pickMetrics(summary, SUMMARY_KEYS, { changeSuffix: 'VariRate' }),
    promotion: promo?.__error ? { error: `推广数据没取到：${promo.__error}` } : pickMetrics(promo?.self, PROMO_KEYS),
  };
  if (core) {
    out.more = pickMetrics(core.self, CORE_DAY_KEYS);
    out.peers = pickPeers(core.rivalAvg, core.rivalGood);
  }
  return out;
}

/** 近 30 天每日：coreIndex trend 的 self / rivalAvg / rivalGood 是「字段 → 30 个值」的数组 */
const TREND_KEYS = ['payAmt', 'payByrCnt', 'payRate', 'payPct', 'uv', 'pv', 'payItmCnt', 'cartByrCnt', 'netPaymentAmount', 'rfdSucAmt', 'olderPayAmt'];
export function parseTrend(data, { peers = false } = {}) {
  const self = data?.self ?? {};
  const dates = (self.statDate || []).map((t) => new Date(Number(t) + 8 * 3600_000).toISOString().slice(0, 10));
  const keys = TREND_KEYS.filter((k) => Array.isArray(self[k]));
  const days = dates.map((date, i) => {
    const row = { date };
    for (const k of keys) row[k] = round(self[k][i]);
    if (peers) {
      for (const [slot, src] of [['peer_avg', data.rivalAvg], ['peer_good', data.rivalGood]]) {
        const vals = Object.fromEntries(['payAmt', 'payByrCnt', 'uv'].filter((k) => Array.isArray(src?.[k])).map((k) => [k, round(src[k][i])]));
        if (Object.keys(vals).length) row[slot] = vals;
      }
    }
    return row;
  });
  const totals = Object.fromEntries(['payAmt', 'payByrCnt', 'payItmCnt', 'uv', 'pv', 'netPaymentAmount', 'rfdSucAmt']
    .filter((k) => keys.includes(k)).map((k) => [k, round(days.reduce((s, r) => s + (r[k] ?? 0), 0), 2)]));
  return { labels: Object.fromEntries(keys.map((k) => [k, LABELS[k] ?? k])), days, totals };
}

export async function storeTrend(get, end, opts) {
  return parseTrend(await get('/portal/coreIndex/new/trend/v3.json', { dateType: 'day', dateRange: `${end}|${end}`, device: 0 }), opts);
}

const TODAY_KEYS = ['payAmt', 'payByrCnt', 'payRate', 'payItmCnt', 'payOrdCnt', 'uv', 'pv', 'cartByrCnt', 'netPaymentAmount', 'payAmtRfdRate', 'shopCustomer'];
export async function storeToday(get) {
  const d = await get('/portal/live/new/index/overview/v3.json', { dateType: 'today' });
  const today = d?.data?.today ?? d?.today ?? {};
  return { metrics: pickMetrics(today, TODAY_KEYS) };
}

// 只输出原始值：字段万一是对象（接口改版），不把整个对象透传出去
const val = (o) => {
  const v = o && typeof o === 'object' && 'value' in o ? o.value : o;
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;
};

export function parseSourceRow(r) {
  const out = { source: val(r.pageName), page_id: val(r.pageId) ?? null };
  const desc = val(r.pageDesc);
  if (desc) out.description = desc;
  for (const [from, to] of [['uv', 'visitors'], ['pv', 'views'], ['cartByrCnt', 'add_to_cart_buyers'], ['itmPayByrCnt', 'pay_buyers'], ['payByrCnt', 'pay_buyers'],
    ['payRate', 'pay_rate'], ['payAmt', 'pay_amount'], ['cltItmCnt', 'collectors'], ['payItmCnt', 'pay_items']]) {
    const raw = r[from];
    if (raw === undefined || out[to] !== undefined) continue;
    const v = round(val(raw));
    if (v === null) continue;
    out[to] = v;
    if (raw && typeof raw === 'object' && raw.cycleCrc !== undefined && raw.cycleCrc !== null && from === 'uv') out.visitors_change = round(raw.cycleCrc);
  }
  if (Array.isArray(r.children) && r.children.length) out.children = r.children.map(parseSourceRow);
  return out;
}

const listOf = (d) => (Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : d && typeof d === 'object' ? Object.values(d).filter((x) => x && typeof x === 'object') : []);

/** 流量来源：全店（前 N 个来源）或单品（来源树，含二级来源） */
export async function trafficSources(get, range, { productId, limit = 20 } = {}) {
  const q = rangeQuery(range);
  if (productId) {
    const d = await get('/flow/item/source/tree/support.json', {
      ...q, pageSize: limit, page: 1, order: 'desc', orderBy: 'uv', itemId: productId, flowBizType: 'classic', crowdType: 'all',
      indexCode: 'uv,cltItmCnt,payByrCnt,payRate,payAmt',
    });
    return { sources: listOf(d).map(parseSourceRow) };
  }
  const d = await get('/flow/v3/overview/shopFlowSourceTop/v4.json', {
    ...q, pageSize: limit, page: 1, order: 'desc', orderBy: 'uv', device: 2, flowBizType: 'all', pageType: 'all', indexCode: 'uv,itmPayByrCnt,payRate',
  });
  return { sources: listOf(d).map(parseSourceRow) };
}

export const RANK_BY = { pay_amount: 'payAmt', visitors: 'itmUv', pay_items: 'payItmCnt', pay_rate: 'payRate', add_to_cart: 'itemCartCnt', collect: 'itemCltByrCnt' };

const detailUrl = (item) => {
  const id = item?.itemId;
  if (!id) return null;
  return item.mallItem ? `https://detail.tmall.com/item.htm?id=${id}` : `https://item.taobao.com/item.htm?id=${id}`;
};

export function parseRankRow(r) {
  const n = (k) => round(val(r[k]));
  const ch = (k) => (r[k] && typeof r[k] === 'object' && r[k].cycleCrc !== undefined ? round(r[k].cycleCrc) : null);
  return {
    product_id: String(r.item?.itemId ?? val(r.itemId) ?? ''),
    title: r.item?.title ?? '',
    url: detailUrl(r.item),
    status: r.itemStatus ?? null,
    pay_amount: n('payAmt'),
    pay_amount_change: ch('payAmt'),
    pay_items: n('payItmCnt'),
    pay_buyers: n('payByrCnt'),
    pay_rate: n('payRate'),
    visitors: n('itmUv'),
    visitors_change: ch('itmUv'),
    views: n('itmPv'),
    search_visitors: n('seGuideUv'),
    search_pay_buyers: n('seGuidePayByrCnt'),
    search_pay_rate: n('seGuidePayRate'),
    add_to_cart_items: n('itemCartCnt'),
    collectors: n('itemCltByrCnt'),
    order_amount: n('crtAmt'),
    order_buyers: n('crtByrCnt'),
    refund_amount: n('sucRefundAmt'),
    avg_order_value: n('payPct'),
    visitor_value: n('uvAvgValue'),
    bounce_rate: n('itmBounceRate'),
    avg_stay_seconds: round(val(r.itmStayTime ?? r.stayTimeAvg), 1),
  };
}

export async function productRank(get, range, { rankBy = 'pay_amount', page = 1, pageSize = 20 } = {}) {
  const d = await get('/cc/item/view/top.json', {
    ...rangeQuery(range), pageSize, page, order: 'desc', orderBy: RANK_BY[rankBy], device: 0, compareType: 'cycle',
    keyword: '', follow: 'false', cateId: '', cateLevel: '', indexCode: 'payAmt,sucRefundAmt,payItmCnt',
  });
  return { total: d?.recordCount ?? null, products: (d?.data || []).map(parseRankRow) };
}

const ITEM_KEYS = ['payAmt', 'payItmCnt', 'payByrCnt', 'payRate', 'itmUv', 'itmPv', 'crtAmt', 'crtByrCnt', 'crtItmQty', 'crtRate', 'itemCartByrCnt',
  'itemCartCnt', 'visitCartRate', 'itemCltByrCnt', 'visitCltRate', 'newPayByrCnt', 'payOldByrCnt', 'olderPayAmt', 'rfdSucAmt', 'uvAvgValue',
  'itmBounceRate', 'itmStayTime', 'fCharge', 'pDROI', 'wwConsultPayRate', 'itmVstPayByrRate', 'descScore'];
const ITEM_LABELS = {
  itmUv: '商品访客数', itmPv: '商品浏览量', crtAmt: '下单金额', crtByrCnt: '下单买家数', crtItmQty: '下单件数', crtRate: '下单转化率',
  itemCartByrCnt: '商品加购人数', itemCartCnt: '商品加购件数', visitCartRate: '访问加购转化率', itemCltByrCnt: '商品收藏人数', visitCltRate: '访问收藏转化率',
  uvAvgValue: '访客平均价值', itmBounceRate: '商品详情页跳出率', itmStayTime: '平均停留时长（秒）', fCharge: '推广消耗', pDROI: '推广直接 ROI',
  wwConsultPayRate: '询单转化率', itmVstPayByrRate: '静默转化率', descScore: '描述相符评分',
};
Object.assign(LABELS, ITEM_LABELS);

export function parseSkus(d) {
  return (d?.data || []).map((r) => ({
    sku_id: String(val(r.skuId) ?? ''),
    sku: val(r.skuName) ?? null,
    pay_amount: round(val(r.payAmt)),
    pay_items: round(val(r.payItmCnt)),
    pay_buyers: round(val(r.payByrCnt)),
    add_to_cart_items: round(val(r.cartCnt)),
  }));
}

/** 单品：sale/trend 返回「字段 → 每天一个值」，按近 30 天请求；点数对不上天数时不标日期（避免标错） */
export function parseItemTrend(d, range) {
  const keys = ['payAmt', 'payItmCnt', 'payByrCnt', 'itmUv', 'payRate', 'itemCartByrCnt'].filter((k) => Array.isArray(d?.[k]));
  const n = Math.max(0, ...keys.map((k) => d[k].length));
  const start = addDays(range.end, 1 - n);
  const labelled = n === range.days;
  return Array.from({ length: n }, (_, i) => Object.fromEntries([[labelled ? 'date' : 'index', labelled ? addDays(start, i) : i], ...keys.map((k) => [k, round(d[k][i])])]));
}

export async function productAnalysis(get, range, productId, { sections, limit = 20 }) {
  const q = rangeQuery(range);
  const jobs = {
    overview: async () => pickMetrics(await get('/cc/item/sale/overview.json', { ...q, device: 0, itemId: productId }), ITEM_KEYS),
    trend: async () => {
      const r30 = periodRange('recent30', range.end);
      return parseItemTrend(await get('/cc/item/sale/trend.json', { ...rangeQuery(r30), indexCode: 'itmUv', device: 0, itemId: productId }), r30);
    },
    skus: async () => {
      const d = await get('/cc/item/sale/sku/list.json', {
        ...q, pageSize: limit, page: 1, order: 'desc', orderBy: 'payAmt', device: 0, itemId: productId, indexCode: 'cartCnt,payAmt,payByrCnt,payItmCnt',
      });
      return { total: d?.recordCount ?? null, top: parseSkus(d) };
    },
    sources: async () => (await trafficSources(get, range, { productId, limit })).sources,
  };
  const wanted = [...new Set(sections)];
  // 一次往返在页面里按顺序发完（前一个触发安全验证就不再发后面的）；没有 get.many 时一个接一个发
  if (typeof get.many === 'function') {
    const r30 = periodRange('recent30', range.end);
    const specs = {
      overview: ['/cc/item/sale/overview.json', { ...q, device: 0, itemId: productId }],
      trend: ['/cc/item/sale/trend.json', { ...rangeQuery(r30), indexCode: 'itmUv', device: 0, itemId: productId }],
      skus: ['/cc/item/sale/sku/list.json', { ...q, pageSize: limit, page: 1, order: 'desc', orderBy: 'payAmt', device: 0, itemId: productId, indexCode: 'cartCnt,payAmt,payByrCnt,payItmCnt' }],
      sources: ['/flow/item/source/tree/support.json', { ...q, pageSize: limit, page: 1, order: 'desc', orderBy: 'uv', itemId: productId, flowBizType: 'classic', crowdType: 'all', indexCode: 'uv,cltItmCnt,payByrCnt,payRate,payAmt' }],
    };
    const data = await get.many(wanted.map((s) => specs[s]));
    const out = {};
    wanted.forEach((s, i) => {
      const d = data[i];
      if (s === 'overview') out.overview = pickMetrics(d, ITEM_KEYS);
      else if (s === 'trend') out.trend = parseItemTrend(d, r30);
      else if (s === 'skus') out.skus = { total: d?.recordCount ?? null, top: parseSkus(d) };
      else out.sources = listOf(d).map(parseSourceRow);
    });
    return out;
  }
  const out = {};
  for (const s of wanted) out[s] = await jobs[s]();
  return out;
}

export const WORD_ORDER = { visitors: 'uv', pay_buyers: 'payOrderUserCnt', add_to_cart: 'goodsCartByrCnt', collect: 'goodsCltByrCnt' };

export function parseWord(r) {
  return {
    keyword: val(r.seKeyword),
    visitors: round(val(r.uv)),
    add_to_cart_buyers: round(val(r.goodsCartByrCnt)),
    collectors: round(val(r.goodsCltByrCnt)),
    pay_buyers: round(val(r.payOrderUserCnt)),
    pay_amount: round(val(r.payAmt)),
    pay_rate: round(val(r.payConvertRate)),
    avg_order_value: round(val(r.perByrAmt)),
    visitor_value: round(val(r.uvValue)),
  };
}

/** 引流搜索词：买家用哪些词搜进本店（全店） */
export async function searchWords(get, range, { orderBy = 'visitors', page = 1, pageSize = 20 } = {}) {
  const d = await get('/flow/v4/shop/wordAide/drainageSearch.json', {
    ...rangeQuery(range), pageSize, page, order: 'desc', orderBy: WORD_ORDER[orderBy], device: 2, kwType: 'se_keyword',
    indexCode: 'uv,goodsCartByrCnt,goodsCltByrCnt,payOrderUserCnt',
  });
  return { total: d?.recordCount ?? null, words: (d?.data || []).map(parseWord) };
}
