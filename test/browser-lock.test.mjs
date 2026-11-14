import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withBrowserLock } from '../lib/browser-lock.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'tb-lock-'));
const exists = (p) => access(p).then(() => true, () => false);

test('锁：同一进程内串行，用完删除锁文件', async () => {
  const dir = await tmp();
  try {
    const order = [];
    const slow = (name) => withBrowserLock(dir, async () => {
      order.push(`${name}+`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${name}-`);
    }, { owner: name });
    await Promise.all([slow('a'), slow('b')]);
    // 谁先拿到锁不确定，但两个任务不能交叉：每个任务的开始和结束必须相邻
    assert.equal(order.length, 4);
    assert.equal(order[0][0], order[1][0]);
    assert.equal(order[2][0], order[3][0]);
    assert.notEqual(order[0][0], order[2][0]);
    assert.equal(await exists(join(dir, 'browser.lock')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('锁：出错也释放', async () => {
  const dir = await tmp();
  try {
    await assert.rejects(withBrowserLock(dir, async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await exists(join(dir, 'browser.lock')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('锁：持有者进程已退出时接管', async () => {
  const dir = await tmp();
  try {
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => child.on('exit', r));
    await writeFile(join(dir, 'browser.lock'), JSON.stringify({ pid: child.pid, owner: '已退出', at: Date.now() }));
    assert.equal(await withBrowserLock(dir, async () => 'ok', { waitMs: 2000 }), 'ok');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('锁：另一个活着的进程持有时等待超时，并说明是谁', async () => {
  const dir = await tmp();
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
  try {
    await writeFile(join(dir, 'browser.lock'), JSON.stringify({ pid: holder.pid, owner: '网页服务', at: Date.now() }));
    await assert.rejects(withBrowserLock(dir, async () => 'x', { waitMs: 1200 }), /正被另一个任务使用（网页服务/);
    // 别人的锁不能被删
    assert.equal(JSON.parse(await readFile(join(dir, 'browser.lock'), 'utf8')).owner, '网页服务');
  } finally {
    holder.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
