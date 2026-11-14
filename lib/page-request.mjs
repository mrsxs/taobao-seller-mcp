// 在店铺浏览器的标签页里发请求（带这家店的登录态和紫鸟代理 IP），结果交回 Node。
// 用隐藏 about:blank iframe 里的原生 fetch：淘宝页面的风控脚本会包装 window.fetch，
// 包装里可能依赖定时器，紫鸟窗口最小化后会被 Chrome 限流卡住；原生 fetch 不受影响。
// 超时由 Node 侧（CDP 调用超时）控制；超时后 Node 再显式取消页面里还没结束的 fetch（abortInPage）。

// ---- 这个函数会被序列化到页面里执行，必须自包含；不用 setTimeout ----
export async function pageRequest({ url, method = 'GET', body = null, headers = {}, encoding = 'utf-8', id = null }) {
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
  const ctrl = new AbortController();
  if (id) (window.__tsmAborts || (window.__tsmAborts = {}))[id] = ctrl;
  try {
    // 从 about:blank iframe 发请求默认不带 Referer，订单接口（trade.taobao.com）会因此返回空；补上当前页面地址
    // 不跟随跳转：接口被重定向（通常是登录失效跳到 login.taobao.com）时跨域跟随会变成看不出原因的 Failed to fetch
    const res = await nativeFetch()(url, { method, credentials: 'include', headers, body: body || undefined, redirect: 'manual', referrer: location.href, signal: ctrl.signal });
    if (res.type === 'opaqueredirect') return { status: res.status, url, redirected: true, text: '' };
    const buf = await res.arrayBuffer();
    return { status: res.status, url: res.url, text: new TextDecoder(encoding).decode(buf) };
  } catch (e) {
    return { error: (e && e.message) || '请求失败' };
  } finally {
    if (id && window.__tsmAborts) delete window.__tsmAborts[id];
  }
}

// ---- 同样在页面里执行：取消 id 对应的请求 ----
export function abortInPage(id) {
  const ctrl = window.__tsmAborts && window.__tsmAborts[id];
  if (!ctrl) return false;
  ctrl.abort();
  delete window.__tsmAborts[id];
  return true;
}

let seq = 0;

/**
 * Node 侧：在 cdp 对应的标签页里执行一次请求。
 * CDP 调用超时只是 Node 不再等，页面里的 fetch 还在跑；这时显式取消它，免得超时后旧请求继续执行、调用方又发下一次。
 */
export async function requestInPage(cdp, req, timeoutMs = 45_000) {
  const id = `${process.pid}-${Date.now()}-${++seq}`;
  try {
    return await cdp.callInPage(pageRequest, { ...req, id }, timeoutMs);
  } catch (err) {
    await Promise.resolve(cdp.callInPage(abortInPage, id, 3000)).catch(() => {});
    throw err;
  }
}
