// ziniao-cli 封装：列店铺、打开店铺、获取店铺当前页面的 targetId
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * 找 ziniao-cli：ZINIAO_CLI → PATH → 常见的 npm 全局目录。
 * Accio 等客户端用自带的 Node 启动 MCP，PATH 里没有 nvm / npm 全局目录，只写 'ziniao-cli' 会 ENOENT。
 */
export function resolveZiniaoCli(env = process.env, platform = process.platform, exists = existsSync, listDir = readdirSync) {
  if (env.ZINIAO_CLI) return env.ZINIAO_CLI;
  // 按目标平台的路径规则拼（测试里会模拟别的平台）
  const { delimiter, join } = platform === 'win32' ? win32 : posix;
  const names = platform === 'win32' ? ['ziniao-cli.cmd', 'ziniao-cli.exe', 'ziniao-cli'] : ['ziniao-cli'];
  const dirs = String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === 'win32') {
    if (env.APPDATA) dirs.push(join(env.APPDATA, 'npm'));
  } else {
    // nvm：新版本在前
    const nvm = join(env.NVM_DIR || join(home, '.nvm'), 'versions', 'node');
    try {
      const versions = listDir(nvm).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      dirs.push(...versions.map((v) => join(nvm, v, 'bin')));
    } catch {
      // 没装 nvm
    }
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global', 'bin'), join(home, '.volta', 'bin'));
  }
  for (const dir of dirs) for (const name of names) if (exists(join(dir, name))) return join(dir, name);
  return 'ziniao-cli';
}

let cli = null;
const CLI = () => (cli ??= resolveZiniaoCli());

function runCli(args, timeoutMs = 60_000) {
  // TSM_TRACE=1：每次调用 ziniao-cli 的命令和耗时打到 stderr（排查慢）
  if (process.env.TSM_TRACE) {
    const t0 = Date.now();
    return runCliRaw(args, timeoutMs).finally(() => process.stderr.write(`[ziniao-cli] ${args.slice(0, 2).join(' ')} ${Date.now() - t0}ms\n`));
  }
  return runCliRaw(args, timeoutMs);
}

function runCliRaw(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Windows 上 npm 全局命令是 ziniao-cli.cmd，必须经 shell 执行（参数都是程序生成的数字/固定值，无注入风险）
    const opts = { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' };
    execFile(CLI(), args, opts, (err, stdout, stderr) => {
      const text = String(stdout || '');
      const jsonStart = text.indexOf('{');
      if (jsonStart < 0) {
        const reason = err?.code === 'ENOENT'
          ? '找不到 ziniao-cli：请先安装紫鸟 CLI（npm i -g @ziniao-open/cli），或用环境变量 ZINIAO_CLI 指定它的完整路径'
          : String(stderr || '').trim() || err?.message || '无输出';
        return reject(new Error(`ziniao-cli ${args.slice(0, 2).join(' ')} 失败: ${reason}`));
      }
      let json;
      try {
        json = JSON.parse(text.slice(jsonStart));
      } catch {
        return reject(new Error(`ziniao-cli ${args.slice(0, 2).join(' ')} 输出无法解析`));
      }
      if (json.ok === false) {
        return reject(new Error(`ziniao-cli ${args.slice(0, 2).join(' ')}: ${json.error?.message || '调用失败'}`));
      }
      resolve(json);
    });
  });
}

export function assertStoreId(storeId) {
  if (!/^\d{5,24}$/.test(String(storeId || ''))) throw new Error('店铺 ID 格式不正确');
  return String(storeId);
}

export async function listStores() {
  const json = await runCli(['store', 'list', '--all']);
  // 带 --all 时结果包在 data 里，不带时在顶层
  const items = json.data?.items || json.items || [];
  return items.map((s) => ({
    storeId: String(s.storeId),
    storeName: s.storeName,
    platformName: s.platformName,
    ip: s.ip,
  }));
}

export async function openStore(storeId) {
  const json = await runCli(['store', 'open', '--id', assertStoreId(storeId)], 240_000);
  return json.data;
}

/** 通过 page exec 拿到店铺浏览器里 CLI 默认页面的 targetId，用来匹配调试端口 */
export async function getStoreTargetId(storeId) {
  const json = await runCli(['page', 'exec', '--store-id', assertStoreId(storeId), '--script', '1'], 30_000);
  const targetId = json?.data?.data?.targetId;
  if (!targetId) throw new Error('未获取到店铺页面 targetId');
  return targetId;
}

/** 店铺浏览器里的标签页（经紫鸟 Bridge，不需要调试端口令牌）：[{ id, url, title, type: 'page' }] */
export async function listPagesCli(storeId) {
  const json = await runCli(['page', 'list', '--store-id', assertStoreId(storeId)], 30_000);
  const pages = json?.data?.data?.pages ?? json?.data?.pages ?? [];
  return pages.map((p) => ({ id: String(p.targetId), url: String(p.url ?? ''), title: String(p.title ?? ''), type: 'page' }));
}

/** 在指定标签页里执行一段脚本，返回 Runtime.evaluate 的结果（原始值直接在 result 里） */
export async function execCli(storeId, targetId, script, timeoutMs = 30_000) {
  const json = await runCli(['page', 'exec', '--store-id', assertStoreId(storeId), '--target-id', String(targetId), '--timeout', String(timeoutMs), '--script', script], timeoutMs + 15_000);
  return json?.data?.data ?? {};
}

/**
 * 经 Bridge 的 execute_script 执行并等结果（awaitPromise + returnByValue）：一次调用拿到值，不用轮询。
 * 参数是 JSON：Windows 上经 cmd.exe 时引号会被弄乱，所以只在非 Windows 用（Windows 用 execCli + 轮询）。
 */
export async function evaluateCli(storeId, targetId, script, timeoutMs = 30_000) {
  const args = { storeId: assertStoreId(storeId), targetId: String(targetId), script, awaitPromise: true, returnByValue: true, timeout: timeoutMs };
  const json = await runCli(['zclaw', 'invoke', 'execute_script', '--args', JSON.stringify(args)], timeoutMs + 15_000);
  return json?.data?.data ?? {};
}
