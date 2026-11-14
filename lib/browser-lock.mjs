// 跨进程浏览器锁：同一个紫鸟店铺浏览器可能被多个 MCP 进程（Claude Code、Accio 各起一个）同时使用，
// 同一时间只让一个任务操作它，避免标签页互相干扰。锁文件放在数据目录下。
import { open, readFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_NAME = 'browser.lock';
const STALE_MS = 15 * 60_000; // 一次抓取远少于 15 分钟；超过视为持有者已卡死
const POLL_MS = 1_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // 进程存在但无权发信号
  }
}

async function readHolder(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function tryAcquire(path, owner, now) {
  try {
    const fh = await open(path, 'wx');
    await fh.writeFile(JSON.stringify({ pid: process.pid, owner, at: now }));
    await fh.close();
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const holder = await readHolder(path);
  // 持有者进程已退出、文件损坏、或持有太久：清掉重试一次
  if (!holder || !alive(holder.pid) || now - holder.at > STALE_MS) {
    await unlink(path).catch(() => {});
    return tryAcquire(path, owner, now).catch(() => false);
  }
  return false;
}

/**
 * 拿到锁后执行 fn，结束（含出错）后释放。等待超过 waitMs 报错，并说明谁在占用。
 * opts: { owner: 显示用名称, waitMs, now }
 */
export async function withBrowserLock(dataDir, fn, { owner = 'unknown', waitMs = 10 * 60_000, now = () => Date.now() } = {}) {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, LOCK_NAME);
  const deadline = now() + waitMs;
  while (!(await tryAcquire(path, owner, now()))) {
    if (now() >= deadline) {
      const holder = await readHolder(path);
      throw new Error(`紫鸟店铺浏览器正被另一个任务使用（${holder?.owner ?? '未知'}，进程 ${holder?.pid ?? '?'}），等待 ${Math.round(waitMs / 1000)} 秒后放弃，请稍后再试。`);
    }
    await sleep(POLL_MS);
  }
  try {
    return await fn();
  } finally {
    const holder = await readHolder(path);
    if (holder?.pid === process.pid) await unlink(path).catch(() => {});
  }
}
