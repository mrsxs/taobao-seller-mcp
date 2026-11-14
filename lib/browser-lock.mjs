// 跨进程浏览器锁：同一个紫鸟店铺浏览器可能被多个 MCP 进程（Claude Code、Accio 各起一个）同时使用，
// 同一时间只让一个任务操作它，避免标签页互相干扰。
//
// 用本机端口当锁：在 127.0.0.1 上监听一个由数据目录算出来的固定端口，操作系统保证同一时间只有一个进程能监听；
// 进程退出（包括崩溃、被杀）时端口立刻释放，不需要判断「锁过期」，也就没有接管时的竞态。
// 持有者卡住时别人不会抢，而是等到超时并说明是谁在占用（连上锁端口会收到持有者信息）。
import { mkdir, realpath } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';

const POLL_MS = 300;
const BANNER_APP = 'taobao-seller-mcp-lock';
const BANNER_START = `{"app":"${BANNER_APP}"`;
/** 收到的内容还可能是本工具横幅（只收到半截）时不能断定是别的程序 */
const maybeOurs = (buf) => BANNER_START.startsWith(buf) || buf.startsWith(BANNER_START);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 数据目录 → 锁端口（20000–29999，避开系统的临时端口段）。传真实路径；Windows 路径不分大小写 */
export function lockPort(dataDir, platform = process.platform) {
  let key = resolve(dataDir);
  if (platform === 'win32') key = key.toLowerCase();
  let h = 5381;
  for (const ch of key) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return 20000 + (h % 10000);
}

/** 拿锁：监听成功返回 server，端口被占返回 null */
function tryListen(port, banner) {
  return new Promise((done, fail) => {
    const sockets = new Set();
    const srv = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      sock.on('error', () => {});
      sock.end(banner);
    });
    srv.once('error', (err) => (err.code === 'EADDRINUSE' ? done(null) : fail(err)));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      srv.unref();
      srv.dropAll = () => sockets.forEach((s) => s.destroy());
      done(srv);
    });
  });
}

/**
 * 问一下锁端口上是谁：{ kind: 'ours', pid, owner } 本工具的锁；{ kind: 'other' } 确认是别的协议的程序；
 * { kind: 'unknown' } 确认不了（持有者卡住没回话、刚好退出等）。有绝对超时，不会被对方拖住。
 */
export function whoHolds(port, timeoutMs = 1500) {
  return new Promise((done) => {
    let buf = '';
    let settled = false;
    const sock = net.connect({ port, host: '127.0.0.1' });
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      done(v);
    };
    const timer = setTimeout(() => finish(!buf || maybeOurs(buf) ? { kind: 'unknown' } : { kind: 'other' }), timeoutMs);
    sock.on('error', () => finish({ kind: 'unknown' }));
    sock.on('data', (d) => {
      buf += d;
      if (buf.length > 2000) finish({ kind: 'other' });
    });
    sock.on('end', () => {
      if (!buf) return finish({ kind: 'unknown' });
      try {
        const h = JSON.parse(buf);
        finish(h?.app === BANNER_APP ? { kind: 'ours', pid: h.pid, owner: h.owner } : { kind: 'other' });
      } catch {
        finish(maybeOurs(buf) ? { kind: 'unknown' } : { kind: 'other' });
      }
    });
  });
}

/**
 * 拿到锁后执行 fn，结束（含出错）后释放。等待超过 waitMs 报错，并说明谁在占用。
 * opts: { owner: 显示用名称, waitMs, now }
 */
export async function withBrowserLock(dataDir, fn, { owner = 'unknown', waitMs = 90_000, now = () => Date.now() } = {}) {
  await mkdir(dataDir, { recursive: true });
  // 用真实路径算端口：同一个目录的不同写法（如 /tmp 和 /private/tmp、软链接）要落到同一把锁
  const port = lockPort(await realpath(dataDir).catch(() => dataDir));
  const banner = `${JSON.stringify({ app: BANNER_APP, pid: process.pid, owner })}\n`;
  const deadline = now() + waitMs;
  let srv;
  while (!(srv = await tryListen(port, banner))) {
    if (now() >= deadline) {
      const holder = await whoHolds(port);
      const wait = `等待 ${Math.round(waitMs / 1000)} 秒后放弃`;
      if (holder.kind === 'ours') throw new Error(`紫鸟店铺浏览器正被另一个任务使用（${holder.owner ?? '未知'}，进程 ${holder.pid ?? '?'}），${wait}，请稍后再试。`);
      if (holder.kind === 'other') throw new Error(`锁端口 127.0.0.1:${port} 被别的程序占用了（不是本工具），${wait}；请换一个数据目录（环境变量里的 DATA_DIR）后再试。`);
      throw new Error(`紫鸟店铺浏览器的锁还被占着（127.0.0.1:${port}，可能是另一个卡住的任务），${wait}，请稍后再试。`);
    }
    await sleep(POLL_MS);
  }
  try {
    return await fn();
  } finally {
    srv.dropAll?.();
    await new Promise((r) => srv.close(() => r()));
  }
}
