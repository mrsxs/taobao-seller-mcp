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
