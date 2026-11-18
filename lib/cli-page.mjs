// 紫鸟新版店铺浏览器（2026-11 起）的调试端口要令牌，直连 WebSocket 报「Invalid or missing token」。
// 这时改经 ziniao-cli（紫鸟 Bridge）在标签页里执行脚本，接口和 cdp.mjs 的连接对象一样（evaluate / callInPage / send）。
// 非 Windows：Bridge 的 execute_script 带 awaitPromise / returnByValue，一次调用拿到值（evaluateCli）。
// Windows：只能用 page exec（不等 Promise、对象只回引用），所以先在页面里起一个任务把结果写进 window，再反复读回 JSON 字符串。
import { evaluateCli, execCli } from './ziniao.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 200;
let seq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Windows 上 ziniao-cli 是 .cmd，要经 cmd.exe 执行：参数里的空格、引号、> & | % 都会被 cmd 吃掉或改掉。
 * 所以把脚本 base64 编码，在页面里解开再执行（生意参谋页允许 eval，2026-11-18 实测；中文按 UTF-8 还原）。
 */
export function wrapForCmd(code) {
  return `eval(decodeURIComponent(escape(atob('${Buffer.from(code, 'utf8').toString('base64')}'))))`;
}

function pageError(res) {
  const d = res?.exceptionDetails;
  return d ? new Error(`页面脚本异常: ${d.exception?.description || d.text || 'unknown'}`) : null;
}

/**
 * 连到店铺浏览器的一个标签页（经命令行）。deps 用于测试：{ exec(script, timeoutMs), awaitExec(script, timeoutMs), sleep(ms), platform }。
 */
export function connectCliPage(storeId, targetId, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const run = deps.exec ?? ((script, timeoutMs) => execCli(storeId, targetId, script, timeoutMs));
  // 一次调用等结果的快路：非 Windows 默认开（测试里只给 exec 时不开）
  const awaitExec = deps.awaitExec ?? (deps.exec || platform === 'win32' ? null : (script, timeoutMs) => evaluateCli(storeId, targetId, script, timeoutMs));
  const encode = platform === 'win32' ? wrapForCmd : (code) => code;
  const exec = (script, timeoutMs) => run(encode(script), timeoutMs);
  const pause = deps.sleep ?? sleep;

  /** 快路：一次调用，Bridge 等 Promise 并按值返回 */
  const evaluateAwait = async (expression, timeoutMs) => {
    const res = await awaitExec(expression, timeoutMs);
    const err = pageError(res);
    if (err) throw err;
    return res?.result === undefined ? null : res.result;
  };

  /** 在页面里执行表达式（可以是 Promise），返回值必须可 JSON 序列化；页面异常会转成 Error */
  const evaluate = async (expression, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    if (awaitExec) return evaluateAwait(expression, timeoutMs);
    const key = `__tsm_cli_${Date.now().toString(36)}_${++seq}`;
    const k = JSON.stringify(key);
    const start = `(() => { window[${k}] = null; Promise.resolve().then(() => (${expression})).then(`
      + `(v) => { window[${k}] = { ok: true, v: v === undefined ? null : v }; },`
      + `(e) => { window[${k}] = { ok: false, e: String((e && (e.stack || e.message)) || e) }; }); return 'started'; })()`;
    const started = await exec(start, Math.min(timeoutMs, DEFAULT_TIMEOUT_MS));
    const err = pageError(started);
    if (err) throw err;
    if (started?.result !== 'started') throw new Error('页面脚本没有启动（标签页可能正在跳转）');
    const read = `(() => { const r = window[${k}]; if (!r) return null; delete window[${k}]; return JSON.stringify(r); })()`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await exec(read, DEFAULT_TIMEOUT_MS);
      const e = pageError(res);
      if (e) throw e;
      if (typeof res?.result === 'string') {
        const r = JSON.parse(res.result);
        if (!r.ok) throw new Error(`页面脚本异常: ${r.e}`);
        return r.v;
      }
      await pause(POLL_MS);
    }
    throw new Error(`页面脚本超时 (${timeoutMs}ms)`);
  };

  /** 同步表达式（不返回 Promise）：一次调用直接拿结果，省掉「起任务 + 读回」的第二次调用 */
  const evaluateSync = async (expression, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    if (awaitExec) return evaluateAwait(expression, timeoutMs);
    const res = await exec(`(() => { try { const v = (${expression}); return JSON.stringify({ ok: true, v: v === undefined ? null : v }); } `
      + `catch (e) { return JSON.stringify({ ok: false, e: String((e && (e.stack || e.message)) || e) }); } })()`, timeoutMs);
    const err = pageError(res);
    if (err) throw err;
    if (typeof res?.result !== 'string') throw new Error('页面脚本没有返回（标签页可能正在跳转）');
    const r = JSON.parse(res.result);
    if (!r.ok) throw new Error(`页面脚本异常: ${r.e}`);
    return r.v;
  };

  /** cdp.mjs 里 send 用到的两个方法：导航、开网络事件（命令行模式不需要） */
  const send = async (method, params = {}) => {
    if (method === 'Network.enable') return {};
    if (method === 'Page.navigate') {
      // 在页面里改 location（不用 page visit --url：Windows 的 cmd 会把网址里的 & 当成命令分隔符）
      try {
        const script = `(() => { location.href = ${JSON.stringify(String(params.url))}; return 'ok'; })()`;
        const res = awaitExec ? await awaitExec(script, DEFAULT_TIMEOUT_MS) : await exec(script, DEFAULT_TIMEOUT_MS);
        const err = pageError(res);
        return err ? { errorText: err.message } : {};
      } catch (err) {
        return { errorText: err.message };
      }
    }
    throw new Error(`经紫鸟命令行不支持 ${method}`);
  };

  return {
    send,
    evaluate,
    evaluateSync,
    callInPage: (fn, arg, timeoutMs) => evaluate(`(${fn.toString()})(${JSON.stringify(arg ?? null)})`, timeoutMs),
    isOpen: () => true,
    close: () => {},
    viaCli: true,
  };
}
