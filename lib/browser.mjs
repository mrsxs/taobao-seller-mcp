// 定位紫鸟店铺浏览器的调试端口，并维护专用的淘宝 / 天猫工作标签页（生意参谋、千牛各一个）
import { connectCdp, httpJson } from './cdp.mjs';
import { listCandidatePorts } from './ports.mjs';
import { getStoreTargetId, openStore } from './ziniao.mjs';

const MTOP_READY_TIMEOUT_MS = 40_000;
// 没登录时会跳到这些登录页：仍然复用这个标签页（等用户登录），不要每次调用都新开一个
const LOGIN_PAGE = /^https:\/\/(login|loginmyseller|login\.m)\.taobao\.com\/|^https:\/\/login\.tmall\.com\//;

// 生意参谋：经营、流量、商品、搜索词数据。接口要页面里的 legalityToken
export const SYCM_SITE = {
  home: 'https://sycm.taobao.com/portal/home.htm',
  urlPrefix: 'https://sycm.taobao.com/',
  readyHost: 'sycm.taobao.com',
  readyExpr: '!!(window.metaCacheData && window.metaCacheData.legalityToken)',
  reuseAlso: LOGIN_PAGE,
  name: '生意参谋',
};

// 千牛卖家中心：订单（trade.taobao.com 只允许这个来源跨域）、商品管理（mtop）
export const QN_SITE = {
  home: 'https://myseller.taobao.com/home.htm/QnworkbenchHome/',
  urlPrefix: 'https://myseller.taobao.com/',
  readyHost: 'myseller.taobao.com',
  readyExpr: "document.readyState !== 'loading' && /_m_h5_tk=/.test(document.cookie)",
  reuseAlso: LOGIN_PAGE,
  name: '千牛卖家中心',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets(port, timeoutMs = 3000) {
  try {
    const list = await httpJson(`http://127.0.0.1:${port}/json/list`, { timeoutMs });
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/** 用 targetId 在候选端口里找到这个店铺对应的浏览器（并行探测） */
async function findPortByTarget(targetId) {
  const ports = await listCandidatePorts();
  const found = await Promise.all(ports.map(async (port) => ((await listTargets(port, 1500))?.some((t) => t.id === targetId) ? port : null)));
  return found.find(Boolean) || null;
}

async function locatePort(storeId, log) {
  let targetId;
  try {
    targetId = await getStoreTargetId(storeId);
  } catch {
    log('店铺浏览器未运行，正在通过紫鸟打开…');
    await openStore(storeId);
    await sleep(3000);
    targetId = await getStoreTargetId(storeId);
  }
  const port = await findPortByTarget(targetId);
  if (!port) throw new Error('找不到店铺浏览器的调试端口，请确认紫鸟店铺浏览器已打开');
  return port;
}

async function waitMtopReady(cdp, site) {
  const deadline = Date.now() + MTOP_READY_TIMEOUT_MS;
  const expr = `location.hostname.endsWith(${JSON.stringify(site.readyHost)}) && (${site.readyExpr || '!!(window.lib && window.lib.mtop)'})`;
  let onLogin = 0;
  while (Date.now() < deadline) {
    const ready = await cdp.evaluate(expr, 5000).catch(() => false);
    if (ready) return;
    // 停在登录页就别等满超时了（连续两次看到登录页才算，避免跳转途中误判）
    if (site.reuseAlso) {
      const href = await cdp.evaluate('location.href', 5000).catch(() => '');
      onLogin = site.reuseAlso.test(href) ? onLogin + 1 : 0;
      if (onLogin >= 2) throw new Error(`${site.name}未登录：请在紫鸟店铺浏览器里登录这家店的淘宝 / 天猫卖家账号（千牛）后重试`);
    }
    await sleep(800);
  }
  throw new Error(`${site.name}加载超时，请确认紫鸟店铺浏览器已登录淘宝 / 天猫卖家后台，并检查店铺网络`);
}

/** 窗口里是否有可见的标签页；一个都没有说明紫鸟窗口最小化了（或被完全挡住，用户没在看） */
async function anyTabVisible(port) {
  // 扩展的 offscreen 页等不是用户看的标签，跳过
  const pages = ((await listTargets(port)) || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && /^(https?:|about:)/.test(t.url));
  for (const t of pages) {
    try {
      const c = await connectCdp(t.webSocketDebuggerUrl, { connectTimeoutMs: 3000 });
      try {
        if ((await c.evaluate('document.visibilityState', 3000)) === 'visible') return true;
      } finally {
        c.close();
      }
    } catch {
      // 扩展页等连不上的标签跳过
    }
  }
  return false;
}

/**
 * 新开工作标签页。用浏览器级 CDP 的 Target.createTarget({ background: true })。
 * 紫鸟里新开标签页会把最小化的窗口弹出来（2026-11-14 实测，background 也一样），
 * 所以开之前先看窗口是否在用户眼前，不在就开完立刻再最小化回去。工作标签页开好后一直复用，只有第一次会开。
 */
async function openWorkerTab(port, site) {
  const hidden = !(await anyTabVisible(port));
  try {
    const { webSocketDebuggerUrl } = await httpJson(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 3000 });
    const browser = await connectCdp(webSocketDebuggerUrl);
    try {
      const { targetId } = await browser.send('Target.createTarget', { url: site.home, background: true });
      if (hidden) {
        // 窗口是异步弹出来的：等它弹出后再最小化，并确认确实缩回去了
        const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId });
        for (let i = 0; i < 3; i++) {
          await sleep(800);
          await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }).catch(() => {});
          await sleep(400);
          if (!(await anyTabVisible(port))) break;
        }
      }
      for (let i = 0; i < 20; i++) {
        const found = (await listTargets(port))?.find((t) => t.id === targetId);
        if (found?.webSocketDebuggerUrl) return found;
        await sleep(250);
      }
    } finally {
      browser.close();
    }
  } catch {
    // 拿不到浏览器级连接时退回旧方式（可能会把窗口弹出来）
  }
  return httpJson(`http://127.0.0.1:${port}/json/new?${site.home}`, { method: 'PUT', timeoutMs: 8000 });
}

/**
 * 会话：缓存「店铺 -> 端口 -> 工作标签页」。
 * 标签页被关闭或浏览器重启时自动重建。site 决定用买家前台还是卖家后台的标签页。
 */
export function createBrowserSession(site) {
  let state = null; // { storeId, port, targetId, cdp }

  const isAlive = async (s) => {
    if (!s?.cdp?.isOpen()) return false;
    const targets = await listTargets(s.port);
    // 标签页还在且仍停留在对应站点（用户可能把它导航到别的网站）
    return Boolean(targets?.some((t) => t.id === s.targetId && t.url.startsWith(site.urlPrefix)));
  };

  async function connect(storeId, log = () => {}) {
    if (state?.storeId === storeId && (await isAlive(state))) return state.cdp;
    state?.cdp?.close();
    state = null;

    log('正在定位紫鸟店铺浏览器…');
    const port = await locatePort(storeId, log);
    const targets = (await listTargets(port)) || [];
    const reusable = targets.find((t) => t.type === 'page' && t.url.startsWith(site.urlPrefix))
      ?? (site.reuseAlso ? targets.find((t) => t.type === 'page' && site.reuseAlso.test(t.url)) : undefined);
    const target = reusable || (await openWorkerTab(port, site));
    const cdp = await connectCdp(target.webSocketDebuggerUrl);
    try {
      await cdp.send('Network.enable');
      log(`等待${site.name}就绪…`);
      await waitMtopReady(cdp, site);
    } catch (err) {
      cdp.close();
      throw err;
    }
    state = { storeId, port, targetId: target.id, cdp };
    return cdp;
  }

  return {
    connect,
    reset: () => {
      state?.cdp?.close();
      state = null;
    },
    info: () => (state ? { storeId: state.storeId, port: state.port, targetId: state.targetId } : null),
  };
}
