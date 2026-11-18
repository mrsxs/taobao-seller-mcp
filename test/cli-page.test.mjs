import assert from 'node:assert/strict';
import { test } from 'node:test';
import { directCdpBlocked } from '../lib/browser.mjs';
import { connectCliPage, wrapForCmd } from '../lib/cli-page.mjs';

/** 假的 page exec：在一个假 window 上真的执行脚本（start 起任务、read 读回结果） */
function fakePage() {
  const window = {};
  const calls = [];
  const exec = async (script) => {
    calls.push(script);
    // eslint-disable-next-line no-new-func
    const value = new Function('window', `return ${script}`)(window);
    await new Promise((r) => setTimeout(r, 1));
    return { result: value };
  };
  return { window, calls, exec };
}

test('evaluate：起任务再读回结果，支持 Promise，读完就删掉', async () => {
  const p = fakePage();
  const page = connectCliPage('123456', 'T1', { platform: 'linux', exec: p.exec, sleep: () => Promise.resolve() });
  assert.deepEqual(await page.evaluate('Promise.resolve({ a: 1, b: [2, 3] })'), { a: 1, b: [2, 3] });
  assert.equal(await page.evaluate('undefined'), null);
  assert.equal(await page.callInPage((x) => x.n * 2, { n: 21 }), 42);
  assert.deepEqual(Object.keys(p.window), []);
});

test('evaluate：页面里抛错 / 起不来 / 超时都报错', async () => {
  const p = fakePage();
  const page = connectCliPage('123456', 'T1', { platform: 'linux', exec: p.exec, sleep: () => Promise.resolve() });
  await assert.rejects(page.evaluate('Promise.reject(new Error("boom"))'), /页面脚本异常: .*boom/);
  const broken = connectCliPage('123456', 'T1', { platform: 'linux', exec: async () => ({ exceptionDetails: { text: 'SyntaxError' } }) });
  await assert.rejects(broken.evaluate('1'), /页面脚本异常: SyntaxError/);
  const navigating = connectCliPage('123456', 'T1', { platform: 'linux', exec: async () => ({ result: undefined }) });
  await assert.rejects(navigating.evaluate('1'), /没有启动/);
  const never = connectCliPage('123456', 'T1', { platform: 'linux', exec: async (s) => ({ result: s.includes("'started'") ? 'started' : null }), sleep: () => new Promise((r) => setTimeout(r, 5)) });
  await assert.rejects(never.evaluate('1', 30), /超时/);
});

test('send：导航在页面里改 location，页面报错回 errorText；Network.enable 不用做；别的不支持', async () => {
  const p = fakePage();
  p.window.location = { href: 'about:blank' };
  const page = connectCliPage('123456', 'T1', { platform: 'linux', exec: async (script) => ({ result: new Function('window', 'location', `return ${script}`)(p.window, p.window.location) }) });
  assert.deepEqual(await page.send('Page.navigate', { url: 'https://sycm.taobao.com/x?a=1&b=2' }), {});
  assert.equal(p.window.location.href, 'https://sycm.taobao.com/x?a=1&b=2');
  assert.deepEqual(await page.send('Network.enable'), {});
  const failing = connectCliPage('123456', 'T1', { platform: 'linux', exec: async () => ({ exceptionDetails: { text: 'blocked' } }) });
  assert.deepEqual(await failing.send('Page.navigate', { url: 'u' }), { errorText: '页面脚本异常: blocked' });
  await assert.rejects(page.send('Target.createTarget'), /不支持/);
});

test('Windows：脚本 base64 编码后只剩 cmd 不会动的字符，页面里能还原（含中文和 & > 引号空格）', async () => {
  const code = `(() => JSON.stringify({ zh: "中文 & > | %PATH%", q: 'x y' }))()`;
  const wrapped = wrapForCmd(code);
  assert.match(wrapped, /^eval\(decodeURIComponent\(escape\(atob\('[A-Za-z0-9+/=]+'\)\)\)\)$/);
  assert.deepEqual(JSON.parse((0, eval)(wrapped)), { zh: '中文 & > | %PATH%', q: 'x y' });
  // win32 时 exec 收到的是编码后的脚本，结果照常读回
  const p = fakePage();
  const seen = [];
  const page = connectCliPage('123456', 'T1', { platform: 'win32', exec: async (s) => { seen.push(s); return p.exec((0, eval)(`(${JSON.stringify(s)})`).replace(/^eval\(decodeURIComponent\(escape\(atob\('(.*)'\)\)\)\)$/, (_, b) => Buffer.from(b, 'base64').toString('utf8'))); }, sleep: () => Promise.resolve() });
  assert.equal(await page.evaluate('Promise.resolve(7)'), 7);
  assert.ok(seen.every((s) => /^eval\(decodeURIComponent/.test(s)));
});

test('directCdpBlocked：WebSocket 连不上（要令牌）才算被挡；端口本身不通按原路子', async () => {
  const http = async () => ({ webSocketDebuggerUrl: 'ws://x' });
  assert.equal(await directCdpBlocked(1, { http, connect: async () => ({ close() {} }) }), false);
  assert.equal(await directCdpBlocked(1, { http, connect: async () => { throw new Error('Invalid or missing token'); } }), true);
  assert.equal(await directCdpBlocked(1, { http: async () => { throw new Error('ECONNREFUSED'); }, connect: async () => ({ close() {} }) }), false);
});

test('命令行模式的 mtop：交给页面 SDK 发，不读 cookie；风控和失败照常报', async () => {
  const { mtopFetch, MtopError } = await import('../lib/mtop-fetch.mjs');
  const scripts = [];
  const cdp = (reply) => ({ viaCli: true, evaluate: async (s) => { scripts.push(s); return reply; } });
  const ok = await mtopFetch(cdp({ ret: ['SUCCESS::调用成功'], data: { n: 1 } }), { api: 'mtop.x', data: { a: 1 } });
  assert.deepEqual(ok.data, { n: 1 });
  assert.ok(scripts.every((s) => !s.includes('document.cookie') && s.includes('lib.mtop')));
  await assert.rejects(mtopFetch(cdp({ ret: ['FAIL_SYS_USER_VALIDATE::验证'] }), { api: 'mtop.x' }), MtopError);
  await assert.rejects(mtopFetch(cdp({ ret: ['FAIL_BIZ::x'] }), { api: 'mtop.x' }), /FAIL_BIZ/);
  await assert.rejects(mtopFetch(cdp({ __err: '千牛页面里没有 mtop SDK' }), { api: 'mtop.x' }), /没有 mtop SDK/);
});

test('命令行模式等页面就绪：千牛不读 cookie，改看 mtop SDK', async () => {
  const { QN_SITE, waitReady } = await import('../lib/browser.mjs');
  const seen = [];
  const cdp = { viaCli: true, evaluate: async (s) => { seen.push(s); return { href: 'https://myseller.taobao.com/home.htm', title: '', loaded: true, ready: true }; } };
  await waitReady(cdp, QN_SITE);
  assert.ok(seen.length && seen.every((s) => !s.includes('document.cookie') && s.includes('lib.mtop')));
});

test('快路（非 Windows）：一次调用等 Promise 按值返回；页面异常照常报；不轮询', async () => {
  const calls = [];
  const awaitExec = async (script) => {
    calls.push(script);
    if (script.includes('throw')) return { exceptionDetails: { exception: { description: 'Error: boom' } } };
    return { result: await (0, eval)(script) };
  };
  const page = connectCliPage('123456', 'T1', { platform: 'darwin', awaitExec, exec: async () => { throw new Error('不该走轮询'); } });
  assert.deepEqual(await page.evaluate('Promise.resolve({ a: 1 })'), { a: 1 });
  assert.equal(await page.evaluateSync('1 + 1'), 2);
  assert.equal(await page.evaluate('undefined'), null);
  await assert.rejects(page.evaluate('(() => { throw new Error("boom"); })()'), /页面脚本异常: Error: boom/);
  assert.equal(calls.length, 4);
});

test('生意参谋批量请求：一次往返按顺序发，解析时遇到验证就报错；单品分析一次发完', async () => {
  const { createSycmApi, productAnalysis } = await import('../lib/sycm.mjs');
  const ok = (data) => ({ status: 200, url: 'u', text: JSON.stringify({ code: 0, data }) });
  const sent = [];
  const requestMany = async (_cdp, reqs) => {
    sent.push(reqs.map((r) => new URL(r.url).pathname));
    return reqs.map((r) => ok({ path: new URL(r.url).pathname, token: new URL(r.url).searchParams.get('token') }));
  };
  const get = createSycmApi({}, { token: 'T' }, async () => { throw new Error('不该单发'); }, requestMany);
  const out = await productAnalysis(get, { start: '2026-11-11', end: '2026-11-17' }, '123', { sections: ['overview', 'skus', 'sources'] });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], ['/cc/item/sale/overview.json', '/cc/item/sale/sku/list.json', '/flow/item/source/tree/support.json']);
  assert.ok('overview' in out && 'skus' in out && 'sources' in out);
  // 页面在验证页后停了：第二个返回验证页，第三个没发 → 解析到第二个就抛错
  const risky = createSycmApi({}, { token: 'T' }, null, async () => [ok({}), { status: 200, url: 'x', text: '<html>_____tmd_____/punish</html>' }]);
  await assert.rejects(risky.many([['/a', {}], ['/b', {}], ['/c', {}]]), /安全验证/);
});

test('批量请求的 optional：普通错误给 null，安全验证照样报错；竞店对比一次发完', async () => {
  const { createSycmApi } = await import('../lib/sycm.mjs');
  const { shopCompare } = await import('../lib/rival.mjs');
  const ok = (data) => ({ status: 200, url: 'u', text: JSON.stringify({ code: 0, data }) });
  const bad = { status: 200, url: 'u', text: JSON.stringify({ code: 1, message: '没有数据' }) };
  const g1 = createSycmApi({}, { token: 'T' }, null, async () => [ok(1), bad]);
  assert.deepEqual(await g1.many([['/a', {}], ['/b', {}]], { optional: [1] }), [1, null]);
  await assert.rejects(g1.many([['/a', {}], ['/b', {}]]), /生意参谋/);
  const g2 = createSycmApi({}, { token: 'T' }, null, async () => [ok(1), { status: 200, url: 'x', text: 'punish x5sec' }]);
  await assert.rejects(g2.many([['/a', {}], ['/b', {}]], { optional: [1] }), /安全验证/);
  const sent = [];
  const g3 = createSycmApi({}, { token: 'T' }, async () => { throw new Error('不该单发'); }, async (_c, reqs) => {
    sent.push(reqs.map((r) => new URL(r.url).pathname));
    return reqs.map((r, i) => (i === reqs.length - 1 ? bad : ok({})));
  });
  const out = await shopCompare(g3, { start: '2026-11-11', end: '2026-11-17' }, [{ userId: 1, name: 'A' }, { userId: 2, name: 'B' }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, 6);
  assert.equal(out.rivals.length, 2);
  assert.equal(out.rivals[1].news, null);
});
