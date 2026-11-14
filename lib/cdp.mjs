// 极简 Chrome DevTools Protocol 客户端（Node 22+ 自带 WebSocket，无需依赖）

const DEFAULT_TIMEOUT_MS = 30_000;

export async function httpJson(url, { method = 'GET', timeoutMs = 5000 } = {}) {
  const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${method} ${url} -> HTTP ${res.status}`);
  return res.json();
}

/** 连接到一个 page target 的 webSocketDebuggerUrl */
export function connectCdp(wsUrl, { connectTimeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;
    let closed = false;

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`连接浏览器调试端口超时: ${wsUrl}`));
    }, connectTimeoutMs);

    const failAll = (err) => {
      for (const { reject: rej, timer: t } of pending.values()) {
        clearTimeout(t);
        rej(err);
      }
      pending.clear();
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const entry = msg.id ? pending.get(msg.id) : null;
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    };
    ws.onclose = () => {
      closed = true;
      failAll(new Error('浏览器连接已断开'));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`无法连接浏览器调试端口: ${wsUrl}`));
    };

    const send = (method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) =>
      new Promise((res, rej) => {
        if (closed) return rej(new Error('浏览器连接已断开'));
        const id = ++nextId;
        const t = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`${method} 超时 (${timeoutMs}ms)`));
        }, timeoutMs);
        pending.set(id, { resolve: res, reject: rej, timer: t, method });
        ws.send(JSON.stringify({ id, method, params }));
      });

    /** 在页面里执行表达式，返回值必须可 JSON 序列化；页面异常会转成 Error */
    const evaluate = async (expression, timeoutMs = DEFAULT_TIMEOUT_MS) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
      if (result.exceptionDetails) {
        const d = result.exceptionDetails;
        throw new Error(`页面脚本异常: ${d.exception?.description || d.text || 'unknown'}`);
      }
      return result.result?.value;
    };

    /** 把一个自包含函数序列化后在页面执行：callInPage(fn, arg) */
    const callInPage = (fn, arg, timeoutMs) => evaluate(`(${fn.toString()})(${JSON.stringify(arg ?? null)})`, timeoutMs);

    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        send,
        evaluate,
        callInPage,
        isOpen: () => !closed,
        close: () => ws.close(),
      });
    };
  });
}
