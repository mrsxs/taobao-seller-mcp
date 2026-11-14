// 跨平台列出本机监听端口（用于寻找紫鸟内核浏览器的调试端口）
// macOS/Linux: lsof；Windows: netstat + tasklist。按进程名优先筛选紫鸟，筛不到就返回全部本机端口（再靠 targetId 精确匹配）
import { execFile } from 'node:child_process';

const ZINIAO_PROCESS = /ziniao|superbrowser/i;

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (_err, stdout) => resolve(String(stdout || '')));
  });

/**
 * 解析 `netstat -ano -p tcp`：返回 [{ port, pid }]（只要 127.0.0.1 上处于监听的端口）
 * 状态词在非英文 Windows 上会被本地化，所以用「外部地址端口为 0」判断监听
 */
export function parseNetstat(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols[0] === 'TCP' && /^127\.0\.0\.1:\d+$/.test(cols[1]) && /:0$/.test(cols[2] || ''))
    .map((cols) => ({ port: Number(cols[1].split(':')[1]), pid: Number(cols[4]) }));
}

/** 解析 `tasklist /FO CSV /NH`：返回 Map(pid -> 进程名) */
export function parseTasklist(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const cols = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (cols.length >= 2) map.set(Number(cols[1]), cols[0]);
  }
  return map;
}

/** 解析 `lsof -nP -iTCP -sTCP:LISTEN`：返回 [{ port, name }] */
export function parseLsof(text) {
  return [...text.matchAll(/^(\S+)\s+\d+\s.*?127\.0\.0\.1:(\d+) \(LISTEN\)/gm)].map((m) => ({ name: m[1], port: Number(m[2]) }));
}

const unique = (ports) => [...new Set(ports)];

async function windowsPorts() {
  const [netstat, tasklist] = await Promise.all([run('netstat', ['-ano', '-p', 'tcp']), run('tasklist', ['/FO', 'CSV', '/NH'])]);
  const listening = parseNetstat(netstat);
  const names = parseTasklist(tasklist);
  const ziniao = listening.filter((l) => ZINIAO_PROCESS.test(names.get(l.pid) || ''));
  return unique((ziniao.length ? ziniao : listening).map((l) => l.port));
}

async function unixPorts() {
  const all = parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']));
  const ziniao = all.filter((l) => ZINIAO_PROCESS.test(l.name));
  return unique((ziniao.length ? ziniao : all).map((l) => l.port));
}

export function listCandidatePorts(platform = process.platform) {
  return platform === 'win32' ? windowsPorts() : unixPorts();
}
