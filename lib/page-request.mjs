// 在店铺浏览器的标签页里发请求（带这家店的登录态和紫鸟代理 IP），结果交回 Node。
// 用隐藏 about:blank iframe 里的原生 fetch：淘宝页面的风控脚本会包装 window.fetch，
// 包装里可能依赖定时器，紫鸟窗口最小化后会被 Chrome 限流卡住；原生 fetch 不受影响。
// 超时由 Node 侧（CDP 调用超时）控制。

// ---- 这个函数会被序列化到页面里执行，必须自包含；不用 setTimeout ----
export async function pageRequest({ url, method = 'GET', body = null, headers = {}, encoding = 'utf-8' }) {
  const nativeFetch = () => {
    let f = window.__tsmNativeFetch;
    if (f && window.__tsmFrame && window.__tsmFrame.isConnected) return f;
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.setAttribute('aria-hidden', 'true');
    document.documentElement.appendChild(frame);
    window.__tsmFrame = frame;
    f = window.__tsmNativeFetch = frame.contentWindow.fetch.bind(frame.contentWindow);
    return f;
  };
  try {
    // 从 about:blank iframe 发请求默认不带 Referer，订单接口（trade.taobao.com）会因此返回空；补上当前页面地址
    // 不跟随跳转：接口被重定向（通常是登录失效跳到 login.taobao.com）时跨域跟随会变成看不出原因的 Failed to fetch
    const res = await nativeFetch()(url, { method, credentials: 'include', headers, body: body || undefined, redirect: 'manual', referrer: location.href });
    if (res.type === 'opaqueredirect') return { status: res.status, url, redirected: true, text: '' };
    const buf = await res.arrayBuffer();
    return { status: res.status, url: res.url, text: new TextDecoder(encoding).decode(buf) };
  } catch (e) {
    return { error: (e && e.message) || '请求失败' };
  }
}

/** Node 侧：在 cdp 对应的标签页里执行一次请求 */
export function requestInPage(cdp, req, timeoutMs = 45_000) {
  return cdp.callInPage(pageRequest, req, timeoutMs);
}
