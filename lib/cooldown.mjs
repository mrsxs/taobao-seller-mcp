// 某家店触发淘宝安全验证后冷却一段时间：这期间不再碰浏览器、直接返回，免得客户端接着重试把风控越弄越重。
// 只认明确的「触发了淘宝安全验证」，登录失效之类不算。
// 冷却状态写在数据目录里（和浏览器锁同一个目录），同一台机器上用同一个紫鸟浏览器的其他 MCP 进程也能看到。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class CooldownError extends Error {}

const VERIFY_TEXT = '触发了淘宝安全验证';
export const isVerifyMessage = (msg) => String(msg ?? '').includes(VERIFY_TEXT);
export const isVerifyError = (err) => isVerifyMessage(err?.message);

/** 可选的附加数据：普通失败换成 fallback，安全验证照样抛出去（要让调用方停下并开始冷却） */
export async function optional(promise, fallback) {
  try {
    return await promise;
  } catch (err) {
    if (isVerifyError(err)) throw err;
    return typeof fallback === 'function' ? fallback(err) : fallback;
  }
}

export function createCooldown({ ms = 10 * 60_000, now = () => Date.now(), dir = null } = {}) {
  const file = dir ? join(dir, 'cooldown.json') : null;
  const memory = new Map();
  const load = () => {
    if (!file) return {};
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  };
  const untilFor = (storeId) => Math.max(memory.get(storeId) ?? 0, Number(load()[storeId]) || 0);
  return {
    /** 冷却中就抛 CooldownError */
    check(shop) {
      const t = untilFor(shop.storeId);
      if (!t || now() >= t) return;
      const left = Math.ceil((t - now()) / 60_000);
      throw new CooldownError(`「${shop.name}」刚触发了淘宝安全验证，接下来 ${left} 分钟内不再向这家店发请求。请在紫鸟店铺浏览器里打开生意参谋 / 千牛完成验证；`
        + '完成后等冷却结束再试（删掉数据目录里的 cooldown.json 并重启 MCP 可立即恢复）。不要换别的工具反复试。');
    },
    /** 出错后调用：是安全验证就开始冷却 */
    note(shop, err) {
      if (!isVerifyError(err)) return;
      const t = now() + ms;
      memory.set(shop.storeId, t);
      if (!file) return;
      try {
        const data = load();
        for (const [k, v] of Object.entries(data)) if (!(Number(v) > now())) delete data[k];
        data[shop.storeId] = t;
        mkdirSync(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(data));
        renameSync(tmp, file);
      } catch {
        // 写不了文件时至少本进程内冷却
      }
    },
  };
}
