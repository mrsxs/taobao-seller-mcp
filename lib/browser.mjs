// 定位紫鸟店铺浏览器的调试端口，并维护专用的淘宝 / 天猫工作标签页（生意参谋、千牛各一个）。
// 工作标签页用 window.name + sessionStorage 标记认领，不会接管用户自己打开的生意参谋 / 千牛页面。
import { connectCdp, httpJson } from './cdp.mjs';
import { listCandidatePorts } from './ports.mjs';
import { getStoreTargetId, openStore } from './ziniao.mjs';

const READY_TIMEOUT_MS = 40_000;
// 没登录时会跳到这些登录页
export const LOGIN_PAGE = /^https:\/\/(login|loginmyseller|login\.m)\.taobao\.com\/|^https:\/\/login\.tmall\.com\//;
// 安全验证（滑块 / 验证码）页：要人来做，看到就停
const VERIFY_PAGE = /_____tmd_____|\/punish\b|x5secdata|^https:\/\/sec\.taobao\.com\//i;
const VERIFY_TITLE = /验证码|安全验证|滑块|captcha/i;
const TAOBAO_URL = /^https:\/\/([a-z0-9-]+\.)*(taobao|tmall)\.com\//;

// 生意参谋：经营、流量、商品、搜索词数据。接口要页面里的 legalityToken
export const SYCM_SITE = {
  home: 'https://sycm.taobao.com/portal/home.htm',
  urlPrefix: 'https://sycm.taobao.com/',
  readyHost: 'sycm.taobao.com',
  readyExpr: '!!(window.metaCacheData && window.metaCacheData.legalityToken)',
  tabName: 'taobao-seller-mcp:sycm',
  name: '生意参谋',
};

// 千牛卖家中心：订单（trade.taobao.com 只允许这个来源跨域）、商品管理（mtop）
export const QN_SITE = {
  home: 'https://myseller.taobao.com/home.htm/QnworkbenchHome/',
  urlPrefix: 'https://myseller.taobao.com/',
  readyHost: 'myseller.taobao.com',
  readyExpr: "document.readyState !== 'loading' && /_m_h5_tk=/.test(document.cookie)",
  tabName: 'taobao-seller-mcp:qn',
  name: '千牛卖家中心',
};

export const VERIFY_SHOWN = '触发了淘宝安全验证（页面要求滑块 / 验证码）：请在紫鸟店铺浏览器里打开生意参谋 / 千牛手动完成验证后再试，不要反复重试';
export const loginExpired = (site) => `${site.name}未登录：请在紫鸟店铺浏览器里登录这家店的淘宝 / 天猫卖家账号（千牛）后重试`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面层面的阻断（未登录、检查页卡住、验证码）：是用户要处理的情况，不是程序故障 */
export class PageBlockedError extends Error {}

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

const TAB_KEY = 'taobao-seller-mcp:tab';
const OWNED_EXPR = (name) => `(() => { try { if (sessionStorage.getItem(${JSON.stringify(TAB_KEY)}) === ${JSON.stringify(name)}) return true; } catch {} return window.name === ${JSON.stringify(name)}; })()`;
const CLAIM_EXPR = (name) => `(() => { window.name = ${JSON.stringify(name)}; try { sessionStorage.setItem(${JSON.stringify(TAB_KEY)}, ${JSON.stringify(name)}); } catch {} return true; })()`;

const probeExpr = (site) => `({ href: location.href, title: document.title, loaded: document.readyState !== 'loading',
  ready: location.hostname.endsWith(${JSON.stringify(site.readyHost)}) && (${site.readyExpr}) })`;

/** 页面当前状态：就绪 / 登录页 / 安全验证页 / 其他（还在加载或在别的页面） */
export function classifyPage(p) {
  const href = String(p?.href ?? '');
  if (VERIFY_PAGE.test(href) || VERIFY_TITLE.test(String(p?.title ?? ''))) return 'verify';
  if (LOGIN_PAGE.test(href)) return 'login';
  return p?.ready ? 'ready' : 'loading';
}

export async function waitReady(cdp, site, { now = Date.now, pause = sleep } = {}) {
  const deadline = now() + READY_TIMEOUT_MS;
  let onLogin = 0;
  for (;;) {
    const p = await cdp.evaluate(probeExpr(site), 5000).catch(() => null);
    const kind = classifyPage(p);
    if (kind === 'ready') return;
    if (kind === 'verify') throw new PageBlockedError(VERIFY_SHOWN);
    // 停在登录页就别等满超时了（连续两次看到登录页才算，避免跳转途中误判）
    onLogin = kind === 'login' ? onLogin + 1 : 0;
    if (onLogin >= 2) throw new PageBlockedError(loginExpired(site));
    if (now() >= deadline) throw new Error(`${site.name}加载超时，请确认紫鸟店铺浏览器已登录淘宝 / 天猫卖家后台，并检查店铺网络`);
    await pause(800);
  }
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
  let created = null;
  try {
    const { webSocketDebuggerUrl } = await httpJson(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 3000 });
    const browser = await connectCdp(webSocketDebuggerUrl);
    try {
      const { targetId } = await browser.send('Target.createTarget', { url: site.home, background: true });
      created = targetId;
      if (hidden) {
        // 窗口是异步弹出来的：等它弹出后再最小化，并确认确实缩回去了
        const win = await browser.send('Browser.getWindowForTarget', { targetId }).catch(() => null);
        for (let i = 0; win && i < 3; i++) {
          await sleep(800);
          await browser.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'minimized' } }).catch(() => {});
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
  // 已经开出来了就不能再开第二个
  if (created) throw new Error('新开的工作标签页没找到，请稍后再试');
  return httpJson(`http://127.0.0.1:${port}/json/new?${site.home}`, { method: 'PUT', timeoutMs: 8000 });
}

/**
 * 会话：缓存「店铺 -> 端口 -> 工作标签页」。
 * 标签页被关闭或浏览器重启时自动重建。site 决定用哪个页面当工作标签页。
 */
export function createBrowserSession(site) {
  let state = null; // { storeId, port, targetId, cdp }
  let justOpened = false; // 最近一次 connect 是否新开了标签页（新开时已经打开了 opts.home）

  const isAlive = async (s) => {
    if (!s?.cdp?.isOpen()) return false;
    const targets = await listTargets(s.port);
    // 标签页还在且还在淘宝 / 天猫（用户可能把它导航到别的网站）
    return Boolean(targets?.some((t) => t.id === s.targetId && TAOBAO_URL.test(t.url)));
  };

  /**
   * 工作标签页可能被带到了别的页面：加载完了又不是工作页，就跳回 home。
   * 停在验证页 / 登录页 / 还在加载时按 waitReady 的规则处理。就绪后补一次认领标记（跨源登录回来时 sessionStorage 是另一份）。
   * 返回是否跳转过（跳到了 home 时调用方不用再跳）。
   */
  async function ensureOnSite(cdp, home) {
    const p = await cdp.evaluate(probeExpr(site), 5000).catch(() => null);
    let navigated = false;
    if (classifyPage(p) === 'loading' && p?.loaded) {
      await navigateAndWait(cdp, home || site.home, site);
      navigated = Boolean(home);
    } else {
      await waitReady(cdp, site);
    }
    await cdp.evaluate(CLAIM_EXPR(site.tabName), 5000).catch(() => {});
    return navigated;
  }

  /** 在候选标签页里找 window.name 是自己的那个 */
  async function findOwned(targets) {
    for (const t of targets.filter((x) => x.type === 'page' && x.webSocketDebuggerUrl && TAOBAO_URL.test(x.url))) {
      try {
        const c = await connectCdp(t.webSocketDebuggerUrl, { connectTimeoutMs: 3000 });
        try {
          if ((await c.evaluate(OWNED_EXPR(site.tabName), 3000)) === true) return t;
        } finally {
          c.close();
        }
      } catch {
        // 连不上的标签跳过
      }
    }
    return null;
  }

  /** opts.home：需要新开工作标签页时直接打开这个地址（比如要搜索的页面），省一次跳转 */
  async function connect(storeId, log = () => {}, opts = {}) {
    justOpened = false;
    if (state?.storeId === storeId && (await isAlive(state))) {
      // 复用时也看一眼页面状态：停在验证页 / 登录页时报错；被带到别的页面时跳回工作页
      justOpened = await ensureOnSite(state.cdp, opts.home);
      return state.cdp;
    }
    state?.cdp?.close();
    state = null;

    log('正在定位紫鸟店铺浏览器…');
    const port = await locatePort(storeId, log);
    const reusable = await findOwned((await listTargets(port)) || []);
    const target = reusable || (await openWorkerTab(port, opts.home ? { ...site, home: opts.home } : site));
    const cdp = await connectCdp(target.webSocketDebuggerUrl);
    let navigated = false;
    try {
      // 认领：window.name 在同站跳转时保留；sessionStorage 按标签页 + 站点保存
      await cdp.evaluate(CLAIM_EXPR(site.tabName), 5000);
      await cdp.send('Network.enable');
      log(`等待${site.name}就绪…`);
      if (reusable) navigated = await ensureOnSite(cdp, opts.home);
      else {
        await waitReady(cdp, site);
        // 新开的标签页最初的文档可能被替换（跳转、检查页），就绪后再认领一次
        await cdp.evaluate(CLAIM_EXPR(site.tabName), 5000).catch(() => {});
      }
    } catch (err) {
      cdp.close();
      throw err;
    }
    state = { storeId, port, targetId: target.id, cdp };
    justOpened = !reusable || navigated;
    return cdp;
  }

  return {
    connect,
    reset: () => {
      state?.cdp?.close();
      state = null;
    },
    info: () => (state ? { storeId: state.storeId, port: state.port, targetId: state.targetId, justOpened } : null),
  };
}

/** 在工作标签页里打开一个地址并等它就绪（遇到验证 / 登录页时抛错） */
export async function navigateAndWait(cdp, url, site) {
  await cdp.evaluate('window.__tsmOldDoc = true', 5000);
  const nav = await cdp.send('Page.navigate', { url });
  if (nav?.errorText) throw new Error(`${site.name}打开失败（${nav.errorText}），请检查店铺网络`);
  const deadline = Date.now() + 20_000;
  // 等旧页面换掉，再按站点规则等就绪
  while (Date.now() < deadline) {
    const fresh = await cdp.evaluate('!window.__tsmOldDoc', 5000).catch(() => false);
    if (fresh) return waitReady(cdp, site);
    await sleep(300);
  }
  throw new Error(`${site.name}打开超时，请检查店铺网络`);
}
