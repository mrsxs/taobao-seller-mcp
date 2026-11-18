import { after, test } from 'node:test';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockPort, whoHolds, withBrowserLock } from '../lib/browser-lock.mjs';

// 子进程里 import 要用 file:// 地址（Windows 上 D:\... 这种路径 ESM 不认）
const LOCK = new URL('../lib/browser-lock.mjs', import.meta.url).href;
// 每个测试用自己的数据目录（锁端口由目录算出来）
const made = [];
const dirFor = (name) => {
  const d = join(tmpdir(), `tsm-lock-${name}-${process.pid}`);
  made.push(d);
  return d;
};
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

test('锁端口：同一目录同一端口，不同目录一般不同，落在 20000–29999；Windows 不分大小写', () => {
  assert.equal(lockPort('C:\\Data\\X', 'win32'), lockPort('c:\\data\\x', 'win32'));
  assert.equal(lockPort('/a/b'), lockPort('/a/b'));
  assert.notEqual(lockPort('/a/b'), lockPort('/a/c'));
  for (const d of ['/x', '/y/z', 'C:\\data']) assert.ok(lockPort(d) >= 20000 && lockPort(d) < 30000);
});

test('锁：同一进程内串行；出错也释放', async () => {
  const dir = dirFor('serial');
  const order = [];
  const slow = (name) => withBrowserLock(dir, async () => {
    order.push(`${name}+`);
    await new Promise((r) => setTimeout(r, 30));
    order.push(`${name}-`);
  }, { owner: name });
  await Promise.all([slow('a'), slow('b')]);
  assert.equal(order.length, 4);
  assert.equal(order[0][0], order[1][0]);
  assert.equal(order[2][0], order[3][0]);
  await assert.rejects(withBrowserLock(dir, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withBrowserLock(dir, async () => 'ok'), 'ok');
});

test('锁：另一个进程持有时等待超时并说明是谁；那个进程被杀后立刻能拿到', async () => {
  const dir = dirFor('child');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withBrowserLock } from ${JSON.stringify(LOCK)};
    await withBrowserLock(${JSON.stringify(dir)}, async () => { process.stdout.write('held\\n'); await new Promise(() => setInterval(() => {}, 1000)); }, { owner: '网页服务' });
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    // 子进程起不来时立刻失败，不一直等
    await new Promise((ok, bad) => {
      const t = setTimeout(() => bad(new Error('子进程 10 秒内没拿到锁')), 10_000);
      child.stdout.once('data', () => { clearTimeout(t); ok(); });
      child.once('error', (e) => { clearTimeout(t); bad(e); });
      child.once('exit', (code) => { clearTimeout(t); bad(new Error(`子进程提前退出 ${code}`)); });
    });
    const { realpathSync } = await import('node:fs');
    assert.deepEqual(await whoHolds(lockPort(realpathSync.native(dir))), { kind: 'ours', pid: child.pid, owner: '网页服务' });
    await assert.rejects(withBrowserLock(dir, async () => 'x', { waitMs: 800 }), new RegExp(`正被另一个任务使用（网页服务，进程 ${child.pid}）`));
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
    assert.equal(await withBrowserLock(dir, async () => 'ok', { waitMs: 3000 }), 'ok');
  } finally {
    child.kill('SIGKILL');
  }
});

test('锁：端口被别的程序占着时说清楚', async () => {
  const dir = dirFor('other');
  const { mkdirSync, realpathSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const other = net.createServer((s) => s.end('hello'));
  await new Promise((r) => other.listen(lockPort(realpathSync.native(dir)), '127.0.0.1', r));
  try {
    await assert.rejects(withBrowserLock(dir, async () => 'x', { waitMs: 500 }), /被别的程序占用了/);
  } finally {
    await new Promise((r) => other.close(r));
  }
});

test('锁：同一个目录的不同写法（软链接）落到同一把锁', async () => {
  const { mkdirSync, symlinkSync } = await import('node:fs');
  const real = dirFor('real');
  const alias = dirFor('alias');
  mkdirSync(real, { recursive: true });
  try {
    symlinkSync(real, alias, 'dir');
  } catch {
    return; // 不支持软链接的环境跳过
  }
  let inside = 0;
  let max = 0;
  const task = (d) => withBrowserLock(d, async () => {
    inside++;
    max = Math.max(max, inside);
    await new Promise((r) => setTimeout(r, 40));
    inside--;
  });
  await Promise.all([task(real), task(alias)]);
  assert.equal(max, 1);
});

test('锁：查占用者有绝对超时（对方一直慢慢发数据也不会拖住）', async () => {
  const chatty = net.createServer((s) => { const t = setInterval(() => s.write('x'), 100); s.on('close', () => clearInterval(t)); s.on('error', () => {}); });
  await new Promise((r) => chatty.listen(0, '127.0.0.1', r));
  try {
    const t0 = Date.now();
    assert.deepEqual(await whoHolds(chatty.address().port, 500), { kind: 'other' });
    assert.ok(Date.now() - t0 < 1500);
  } finally {
    await new Promise((r) => chatty.close(r));
  }
});

test('锁：只收到半截本工具横幅时判「确认不了」，不误报成别的程序', async () => {
  const half = net.createServer((s) => { s.write('{"app":"taobao-seller'); s.on('error', () => {}); });
  await new Promise((r) => half.listen(0, '127.0.0.1', r));
  try {
    assert.deepEqual(await whoHolds(half.address().port, 400), { kind: 'unknown' });
  } finally {
    await new Promise((r) => { half.close(r); });
  }
});
