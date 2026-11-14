import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildMtopRequest, h5Sign, h5Token, mtopFetch, MtopError } from '../lib/mtop-fetch.mjs';

test('令牌取 _m_h5_tk 的前半段；签名 = md5(token&t&appKey&data)', () => {
  assert.equal(h5Token('a=1; _m_h5_tk=abc123_1794000000000; b=2'), 'abc123');
  assert.equal(h5Token('a=1'), '');
  assert.equal(h5Sign('abc', 1, 'k', '{}'), createHash('md5').update('abc&1&k&{}').digest('hex'));
});

test('组装请求：路径小写、POST 数据放表单、GET 数据放 URL、附加参数', () => {
  const post = buildMtopRequest({ api: 'mtop.A.B', data: { x: 1 }, appKey: 'k', token: 't', t: 5, query: { '__channel-id__': '9' } });
  const u = new URL(post.url);
  assert.equal(u.host, 'h5api.m.taobao.com');
  assert.equal(u.pathname, '/h5/mtop.a.b/1.0/');
  assert.equal(u.searchParams.get('api'), 'mtop.A.B');
  assert.equal(u.searchParams.get('sign'), h5Sign('t', 5, 'k', '{"x":1}'));
  assert.equal(u.searchParams.get('__channel-id__'), '9');
  assert.equal(u.searchParams.get('data'), null);
  assert.equal(post.body, `data=${encodeURIComponent('{"x":1}')}`);
  const get = buildMtopRequest({ api: 'm.x', method: 'GET', data: { y: 2 }, appKey: 'k', token: 't', t: 5, host: 'h5api.m.taobao.com' });
  assert.equal(new URL(get.url).searchParams.get('data'), '{"y":2}');
  assert.equal(get.body, null);
});

function fakeCdp(responses) {
  let cookie = '_m_h5_tk=old_1';
  const sent = [];
  return {
    sent,
    evaluate: async () => cookie,
    callInPage: async (_fn, req) => {
      sent.push(req);
      const next = responses.shift();
      if (next.setCookie) cookie = next.setCookie;
      return next.reply;
    },
  };
}

test('令牌过期：用服务端下发的新令牌重签一次', async () => {
  const cdp = fakeCdp([
    { reply: { status: 200, text: JSON.stringify({ ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'] }) }, setCookie: '_m_h5_tk=new_2' },
    { reply: { status: 200, text: JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { ok: 1 } }) } },
  ]);
  const r = await mtopFetch(cdp, { api: 'm.x', appKey: 'k', data: {} });
  assert.deepEqual(r.data, { ok: 1 });
  assert.equal(cdp.sent.length, 2);
  const sign2 = new URL(cdp.sent[1].url).searchParams.get('sign');
  const t2 = new URL(cdp.sent[1].url).searchParams.get('t');
  assert.equal(sign2, h5Sign('new', t2, 'k', '{}'));
});

test('失败：业务错误、非 JSON、页面 fetch 出错都抛 MtopError，令牌只重试一次', async () => {
  await assert.rejects(mtopFetch(fakeCdp([{ reply: { status: 200, text: JSON.stringify({ ret: ['FAIL_BIZ::不行'] }) } }]), { api: 'm.x', appKey: 'k' }), (e) => e instanceof MtopError && /FAIL_BIZ/.test(e.message));
  await assert.rejects(mtopFetch(fakeCdp([{ reply: { status: 502, text: '<html>' } }]), { api: 'm.x', appKey: 'k' }), /不是 JSON（HTTP 502）/);
  await assert.rejects(mtopFetch(fakeCdp([{ reply: { error: 'Failed to fetch' } }]), { api: 'm.x', appKey: 'k' }), /Failed to fetch/);
  const expired = { reply: { status: 200, text: JSON.stringify({ ret: ['FAIL_SYS_TOKEN_EMPTY::令牌为空'] }) } };
  await assert.rejects(mtopFetch(fakeCdp([expired, { ...expired }]), { api: 'm.x', appKey: 'k' }), /TOKEN_EMPTY/);
});

test('页面请求超时：取消页面里同一个请求再抛错', async () => {
  const { requestInPage, pageRequest, abortInPage } = await import('../lib/page-request.mjs');
  const calls = [];
  const cdp = {
    callInPage: async (fn, arg) => {
      calls.push({ fn, arg });
      if (fn === pageRequest) throw new Error('Runtime.evaluate 超时 (100ms)');
      return true;
    },
  };
  await assert.rejects(requestInPage(cdp, { url: 'https://x.test/a' }, 100), /超时/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].fn, abortInPage);
  assert.equal(calls[1].arg, calls[0].arg.id);
  assert.ok(calls[0].arg.id);
  // 取消失败（比如连接已断）不掩盖原来的错误
  const broken = { callInPage: async () => { throw new Error('原始错误'); } };
  await assert.rejects(requestInPage(broken, { url: 'https://x.test/a' }), /原始错误/);
});

test('安全验证冷却：只认明确的安全验证；按店冷却，到时自动恢复', async () => {
  const { createCooldown, CooldownError } = await import('../lib/cooldown.mjs');
  let t = 0;
  const cd = createCooldown({ ms: 10 * 60_000, now: () => t });
  const a = { storeId: '1', name: '甲店' };
  const b = { storeId: '2', name: '乙店' };
  cd.note(a, new Error('千牛登录已失效或触发了安全验证'));
  cd.check(a);
  cd.note(a, new Error('触发了淘宝安全验证（滑块 / 验证码），请…'));
  assert.throws(() => cd.check(a), (e) => e instanceof CooldownError && /10 分钟内/.test(e.message));
  cd.check(b);
  t = 9 * 60_000 + 1;
  assert.throws(() => cd.check(a), /1 分钟内/);
  t = 10 * 60_000;
  cd.check(a);
});
