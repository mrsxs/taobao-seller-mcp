// 不依赖页面定时器的 mtop 调用（淘宝 / 天猫 h5api）。
// 页面自带的 window.lib.mtop 内部用 setTimeout；紫鸟窗口最小化或标签页在后台超过 5 分钟后，Chrome 会把
// 定时器限流到约 1 分钟一次，请求会卡住几分钟（2026-11-14 实测：后台 >120 秒无返回，前台 0.86 秒）。
// 这里在 Node 里按 H5 规则签名（sign = md5(token&t&appKey&data)，token 取 cookie _m_h5_tk 的前半段），
// 页面里只发一次 fetch；超时由 Node 侧（CDP 调用超时）控制，不受页面限流影响。
import { createHash } from 'node:crypto';
import { requestInPage } from './page-request.mjs';

// 令牌缺失 / 过期时服务端会在响应里下发新的 _m_h5_tk，重签一次即可。
// FAIL_SYS_ILLEGAL_ACCESS 是签名和令牌对不上（非法请求），淘宝页面自己的 mtop 库遇到它也是刷新令牌重发一次（2026-11-14 核对千牛页面脚本）。
// 风控（RGV587_ERROR、FAIL_SYS_USER_VALIDATE）不在这里，直接报错，不重试。
const TOKEN_RETRY = /FAIL_SYS_TOKEN_EMPTY|FAIL_SYS_TOKEN_EXOIRED|FAIL_SYS_TOKEN_EXPIRED|FAIL_SYS_ILLEGAL_ACCESS/;

const RISK = /RGV587|FAIL_SYS_USER_VALIDATE/;

// 淘宝 / 天猫 H5 mtop（千牛卖家中心页面用的就是这个 appKey 和 ttid）
export const TB_MTOP_HOST = 'h5api.m.taobao.com';
export const TB_APP_KEY = '12574478';
export const TB_TTID = '11320@taobao_WEB_9.9.99';

export class MtopError extends Error {
  constructor(message, ret) {
    super(message);
    this.ret = ret;
  }
}

export function h5Token(cookieHeader) {
  const m = String(cookieHeader || '').match(/(?:^|;\s*)_m_h5_tk=([^;]+)/);
  return m ? decodeURIComponent(m[1]).split('_')[0] : '';
}

export function h5Sign(token, t, appKey, dataStr) {
  return createHash('md5').update(`${token}&${t}&${appKey}&${dataStr}`).digest('hex');
}

/** 组装请求（纯函数，便于测试）：返回 { url, body } */
export function buildMtopRequest({ api, v = '1.0', data = {}, appKey = TB_APP_KEY, host = TB_MTOP_HOST, method = 'POST', query = {}, token, t }) {
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  const qs = new URLSearchParams({
    jsv: '2.7.2', appKey: String(appKey), t: String(t), sign: h5Sign(token, t, appKey, dataStr),
    api, v, type: 'originaljson', dataType: 'json', ...query,
  });
  if (method === 'GET') qs.set('data', dataStr);
  return {
    url: `https://${host}/h5/${api.toLowerCase()}/${v}/?${qs}`,
    body: method === 'POST' ? `data=${encodeURIComponent(dataStr)}` : null,
  };
}

/**
 * 在店铺浏览器的标签页里调用一个 mtop 接口。cdp 来自 createBrowserSession().connect()。
 * opts: { api, v, data, appKey, host, method: 'POST'|'GET', query: 额外 URL 参数, headers: 额外请求头, timeoutMs }
 * 成功返回完整响应 JSON（{ ret, data, ... }）；失败抛 MtopError（带 ret）。
 */
export async function mtopFetch(cdp, { timeoutMs = 60_000, headers, ...opts }) {
  for (let attempt = 0; ; attempt++) {
    // 只取签名要用的 _m_h5_tk，不把整串 cookie 搬进 Node
    const token = h5Token(await cdp.evaluate(String.raw`(document.cookie.match(/(?:^|;\s*)_m_h5_tk=[^;]+/) || [''])[0]`, 5000));
    const req = buildMtopRequest({ ...opts, token, t: Date.now() });
    const r = await requestInPage(cdp, {
      url: req.url, method: req.body ? 'POST' : 'GET', body: req.body,
      headers: { ...(headers || {}), ...(req.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    }, timeoutMs);
    if (!r || r.error) throw new MtopError(`${opts.api} 请求失败：${r?.error || '无返回'}`);
    if (r.redirected) throw new MtopError(`${opts.api} 失败：FAIL_SYS_SESSION_EXPIRED::被重定向（登录失效）`, ['FAIL_SYS_SESSION_EXPIRED']);
    let json;
    try {
      json = JSON.parse(r.text);
    } catch {
      if (/x5sec|punish|_____tmd_____/i.test(String(r.text).slice(0, 3000))) {
        throw new MtopError(`${opts.api} 失败：FAIL_SYS_USER_VALIDATE::返回了安全验证页`, ['FAIL_SYS_USER_VALIDATE']);
      }
      throw new MtopError(`${opts.api} 返回的不是 JSON（HTTP ${r.status}）`);
    }
    const ret = (json.ret || []).join(';');
    // 先认风控：风控绝不重试
    if (RISK.test(ret)) throw new MtopError(`${opts.api} 失败：${ret}`, json.ret);
    if (TOKEN_RETRY.test(ret) && attempt === 0) continue;
    if (!/^SUCCESS/.test(json.ret?.[0] || '')) throw new MtopError(`${opts.api} 失败：${ret || `HTTP ${r.status}`}`, json.ret);
    return json;
  }
}
