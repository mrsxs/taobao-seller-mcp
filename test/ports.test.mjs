import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLsof, parseNetstat, parseTasklist } from '../lib/ports.mjs';

test('端口解析：lsof / netstat / tasklist', () => {
  assert.deepEqual(parseLsof('superbrow 123 user 40u IPv4 0x1 0t0 TCP 127.0.0.1:18204 (LISTEN)\nnode 9 a 1u IPv4 0x2 0t0 TCP *:80 (LISTEN)'), [{ name: 'superbrow', port: 18204 }]);
  assert.deepEqual(parseNetstat('  TCP    127.0.0.1:9222    0.0.0.0:0    LISTENING    4321\n  TCP    127.0.0.1:5000    127.0.0.1:6000    ESTABLISHED  1'), [{ port: 9222, pid: 4321 }]);
  assert.equal(parseTasklist('"SuperBrowser.exe","4321","Console","1","10,000 K"').get(4321), 'SuperBrowser.exe');
});

test('找 ziniao-cli：环境变量优先，其次 PATH，再到 nvm（新版本在前）和常见目录', async () => {
  const { resolveZiniaoCli } = await import('../lib/ziniao.mjs');
  const have = (paths) => (p) => paths.includes(p);
  const list = () => ['v20.1.0', 'v25.7.0', 'v22.3.0'];
  assert.equal(resolveZiniaoCli({ ZINIAO_CLI: '/x/cli' }, 'darwin'), '/x/cli');
  assert.equal(resolveZiniaoCli({ PATH: '/a:/b', HOME: '/h' }, 'darwin', have(['/b/ziniao-cli']), list), '/b/ziniao-cli');
  assert.equal(resolveZiniaoCli({ PATH: '/usr/bin', HOME: '/h' }, 'darwin', have(['/h/.nvm/versions/node/v22.3.0/bin/ziniao-cli', '/h/.nvm/versions/node/v25.7.0/bin/ziniao-cli']), list), '/h/.nvm/versions/node/v25.7.0/bin/ziniao-cli');
  assert.equal(resolveZiniaoCli({ PATH: '/usr/bin', HOME: '/h' }, 'darwin', have(['/opt/homebrew/bin/ziniao-cli']), () => { throw new Error('no nvm'); }), '/opt/homebrew/bin/ziniao-cli');
  assert.equal(resolveZiniaoCli({ PATH: '/usr/bin', HOME: '/h' }, 'darwin', have([]), list), 'ziniao-cli');
});
