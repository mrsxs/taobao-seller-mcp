// 千牛卖家中心（myseller.taobao.com 标签页）：已卖出的宝贝（订单）、出售中 / 仓库中的宝贝（商品）、待发货计数。
// 订单接口在 trade.taobao.com，只允许千牛页面跨域调用；返回是 GBK 编码。买家昵称让接口本身隐藏（isHideNick），也不输出收货信息。
import { isBlockingError } from './cooldown.mjs';
import { hasRiskText, isRiskJson, redact, riskInObject } from './risk.mjs';
import { MtopError, mtopFetch } from './mtop-fetch.mjs';
import { requestInPage } from './page-request.mjs';

export class QnError extends Error {}

const SOLD_URL = 'https://trade.taobao.com/trade/itemlist/asyncSold.htm?event_submit_do_query=1&_input_charset=utf8';

// tabCode → 千牛「已卖出的宝贝」上的标签和它带的查询参数（取自接口返回的 tabs[].herf）
const TABS = {
  latest3Months: ['近 3 个月（全部）', {}],
  waitBuyerPay: ['等待买家付款', { auctionStatus: 'NOT_PAID' }],
  confirmation: ['确认中', { auctionStatus: 'HOLD' }],
  waitSend: ['等待发货', { auctionStatus: 'PAID' }],
  deliveryWillTimeOut: ['即将发货超时', { auctionStatus: 'PAID', deliveryTimeType: '' }],
  deliveryHadTimeOut: ['发货已超时', { auctionStatus: 'PAID', deliveryTimeType: '' }],
  haveSendGoods: ['已发货', { auctionStatus: 'SEND' }],
  refunding: ['退款中', { auctionStatus: 'REFUNDING' }],
  success: ['交易成功', { auctionStatus: 'SUCCESS' }],
  closed: ['交易关闭', { auctionStatus: 'DROP' }],
  before3Months: ['3 个月前', { action: 'itemlist/SoldHisQueryAction' }],
};
export const ORDER_TABS = Object.fromEntries(Object.entries(TABS).map(([k, [label]]) => [k, label]));

export function buildSoldForm({ tab = 'latest3Months', page = 1 } = {}) {
  const extra = TABS[tab]?.[1] ?? {};
  return new URLSearchParams({
    isQnNew: 'true', isHideNick: 'true', prePageNo: String(Math.max(1, page - 1)), sifg: '0', action: 'itemlist/SoldQueryAction',
    close: '0', pageNum: String(page), orderStatus: '', rateStatus: '', queryMore: 'false', tabCode: tab, ...extra,
  }).toString();
}

const texts = (list) => (list || []).map((x) => (x?.name ? `${x.name}：${x.value}` : x?.value)).filter(Boolean);
const extraValue = (list, name) => (list || []).find((x) => x?.name === name)?.value ?? null;
const money = (s) => {
  const m = String(s ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  return Number(m[0]) * (/万/.test(String(s)) ? 10000 : 1);
};

export function parseOrder(o) {
  return {
    order_id: String(o.id ?? o.orderInfo?.id ?? ''),
    created_at: o.orderInfo?.createTime ?? null,
    status: o.statusInfo?.text ?? null,
    paid: money(o.payInfo?.actualFee),
    shipping: o.payInfo?.postType ?? null,
    items: (o.subOrders || []).map((s) => ({
      title: s.itemInfo?.title ?? null,
      sku: texts(s.itemInfo?.skuText).join('；') || null,
      seller_code: extraValue(s.itemInfo?.extra, '商家编码'),
      quantity: Number(s.quantity) || null,
      price: money(s.priceInfo?.realTotal),
      // 子订单上的状态按钮文字，如「退款成功」「未发货」「发货剩余时间」
      notes: (s.operations || []).map((x) => x?.text).filter((t) => typeof t === 'string' && t.length <= 20),
    })),
  };
}

export function parseSold(json) {
  return {
    page: json?.page?.currentPage ?? null,
    page_size: json?.page?.pageSize ?? null,
    total: json?.page?.totalNumber ?? null,
    total_pages: json?.page?.totalPage ?? null,
    orders: (json?.mainOrders || []).map(parseOrder),
  };
}

const ORDERS_VERIFY = '触发了淘宝安全验证，请在紫鸟店铺浏览器里打开千牛「已卖出的宝贝」手动完成验证后再试，不要反复重试';

export async function listOrders(cdp, { tab = 'latest3Months', page = 1 } = {}, request = requestInPage) {
  const r = await request(cdp, {
    url: SOLD_URL, method: 'POST', encoding: 'gbk',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: buildSoldForm({ tab, page }),
  });
  if (!r || r.error) throw new Error(`订单请求失败：${redact(r?.error || '无返回')}`);
  if (r.redirected) throw new QnError('千牛登录已失效，请在紫鸟店铺浏览器里重新登录千牛');
  let json;
  try {
    json = JSON.parse(r.text);
  } catch {
    const head = `${r.url} ${r.text.slice(0, 2000)}`;
    if (/x5sec|punish|_____tmd_____/i.test(head)) throw new QnError(ORDERS_VERIFY);
    if (/login/i.test(head)) throw new QnError('千牛登录已失效，请在紫鸟店铺浏览器里重新登录千牛');
    if (/captcha/i.test(head)) throw new QnError(ORDERS_VERIFY);
    throw new QnError(`订单接口返回的不是 JSON（HTTP ${r.status}）`);
  }
  if (isRiskJson(json)) throw new QnError(ORDERS_VERIFY);
  if (json?.error) {
    const text = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
    if (hasRiskText(text)) throw new QnError(ORDERS_VERIFY);
    if (/登录|login/i.test(text)) throw new QnError('千牛登录已失效，请在紫鸟店铺浏览器里重新登录千牛');
    throw new QnError(`订单接口报错：${redact(text)}`);
  }
  // 正常返回（包括没有订单）都带 mainOrders 数组或分页信息；都没有说明不是正常结果
  const pageOk = Boolean(json?.page) && typeof json.page === 'object' && !Array.isArray(json.page);
  if (!json || typeof json !== 'object' || !(Array.isArray(json.mainOrders) || pageOk) || (json.mainOrders !== undefined && !Array.isArray(json.mainOrders))) throw new QnError('订单接口返回的数据不完整');
  return parseSold(json);
}

// ---- mtop（千牛页面 Node 签名） ----

export function explainMtop(api, message) {
  const msg = String(message || '');
  // 验证优先于登录判断（「FAIL_SYS_USER_VALIDATE::请登录验证」是验证）
  if (hasRiskText(msg)) return '触发了淘宝安全验证，请在紫鸟店铺浏览器里打开千牛手动完成验证后重试';
  if (/SESSION_EXPIRED|SID_INVALID|login|登录/i.test(msg)) return '千牛登录已失效，请在紫鸟店铺浏览器里重新登录千牛';
  return `千牛接口失败（${api}）：${redact(msg.replace(/^[^：]*：/, ''))}`;
}

export function createQnMtop(cdp, fetchImpl = mtopFetch) {
  return async function call(api, data) {
    try {
      const res = await fetchImpl(cdp, { api, v: '1.0', method: 'POST', data, query: { ttid: '11320@taobao_WEB_9.9.99', type: 'originaljson', timeout: '20000' }, timeoutMs: 45_000 });
      return res.data;
    } catch (err) {
      if (err instanceof MtopError) throw new QnError(explainMtop(api, err.message));
      throw err;
    }
  };
}

export async function orderCounts(call) {
  const d = await call('mtop.taobao.trade.order.nums.pc', {
    sourceApp: 'qianniuTrademanager', sellerCountEnum: JSON.stringify(['wait_consign', 'consign_to_timeout', 'consign_already_timeout']),
  });
  const m = d?.countMap || {};
  return { to_ship: m.wait_consign ?? null, ship_timeout_soon: m.consign_to_timeout ?? null, ship_timed_out: m.consign_already_timeout ?? null };
}

export const PRODUCT_TABS = { on_sale: '出售中', in_stock: '仓库中' };

const textOf = (desc, re) => (desc || []).map((d) => d?.text).find((t) => typeof t === 'string' && re.test(t)) ?? null;

export function parseProductRow(r) {
  const desc = r.itemDesc?.desc || [];
  const title = desc.find((d) => d?.uiType === 'link')?.text ?? desc[0]?.text ?? '';
  const code = textOf(desc, /编码[:：]/);
  return {
    product_id: r.itemId ? String(r.itemId) : null,
    title,
    seller_code: code ? code.replace(/.*编码[:：]\s*/, '') : null,
    price: r.managerPrice?.currentPrice ?? null,
    stock: money(r.managerQuantityNew?.text),
    sales_30d: typeof r.soldQuantity_m === 'number' ? r.soldQuantity_m : money(r.soldQuantity_m),
    category_id: r.catId ? String(r.catId) : null,
    listed_at: r.upShelfDate_m?.value ?? null,
    status: r.upShelfDate_m?.status?.text ?? null,
    quality_score: r.diagnoseInfoV3?.basicScore ?? null,
    traffic_label: r.diagnoseInfoV3?.scoreLabel ?? null,
  };
}

export function parseProductTable(result) {
  let parsed = result;
  if (typeof result === 'string') {
    try {
      parsed = JSON.parse(result);
    } catch {
      throw new QnError('商品列表返回无法解析');
    }
  }
  // 先看整个内层对象有没有风控（错误码和文案可能分开放，data.url 也可能指向验证页）
  if (riskInObject(parsed) || riskInObject(parsed?.data)) throw new QnError('触发了淘宝安全验证，请在紫鸟店铺浏览器里打开千牛手动完成验证后重试');
  if (parsed?.success === false) {
    // 错误码和所有文案一起交给分类（只取一条会漏掉「登录已失效」这类提示）
    const all = [parsed?.errorCode, parsed?.msg?.globalMessage?.text, parsed?.errorMsg, parsed?.errorMessage, parsed?.message].filter((x) => typeof x === 'string' && x);
    throw new QnError(explainMtop('商品列表', all.join('：') || '未知错误'));
  }
  // 缺结果不是「没有商品」：报错，不当空列表（也不会把这个平台记成已识别）
  const isObj = (o) => Boolean(o) && typeof o === 'object' && !Array.isArray(o);
  const t = parsed?.data?.table;
  if (!isObj(parsed) || !isObj(parsed.data) || !isObj(t) || (t.dataSource !== undefined && !Array.isArray(t.dataSource))) throw new QnError('商品列表返回的数据不完整');
  const data = parsed.data;
  const table = data.table ?? {};
  const pager = data.pagination ?? table.pagination ?? {};
  return { total: pager.total ?? null, products: (table.dataSource || []).map(parseProductRow) };
}

/** 天猫店和淘宝店的商品管理接口只差一个前缀；platform 不知道时先试天猫，失败再试淘宝 */
export async function listProducts(call, { platform, tab = 'on_sale', page = 1, pageSize = 20 } = {}) {
  const tryOne = async (p) => {
    const d = await call(`mtop.${p}.sell.pc.manage.async`, {
      url: `/${p}/manager/table.htm`,
      jsonBody: JSON.stringify({ tab, pagination: { current: page, pageSize }, filtertab: '', filter: {}, table: {} }),
    });
    return { platform: p, ...parseProductTable(d?.result) };
  };
  if (platform) return tryOne(platform);
  try {
    return await tryOne('tmall');
  } catch (err) {
    // 安全验证、登录失效不能换接口再试
    if (!(err instanceof QnError) || isBlockingError(err)) throw err;
    return tryOne('taobao');
  }
}
