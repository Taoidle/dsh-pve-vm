/**
 * Checks the API transport without a Proxmox node: a local HTTP server answers
 * the handful of endpoints the controller uses.
 *
 * What is pinned here is the contract the tools already rely on — the token
 * header, `pveshGet` returning the parsed `data`, `qm` verbs becoming REST calls,
 * a UPID being awaited, and cross-node placement lookup. If any of that drifts,
 * the tools break in a way that only shows up against a real node.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { ApiController, withSshFallback } from '../lib/api-controller.js';
import { PveApi } from '../lib/api.js';

const problems = [];
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    problems.push(`${name}: ${error.message}`);
    console.log(`FAIL ${name}: ${error.message}`);
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    problems.push(`${name}: ${error.message}`);
    console.log(`FAIL ${name}: ${error.message}`);
  }
};

const TOKEN = 'root@pam!dsh=0123456789abcdef0123456789abcdef0123';
const seen = [];
const UPID = 'UPID:pve-ci:000A1B2C:00000001:64F00000:qmshutdown:104:root@pam:';

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    seen.push({ method: request.method, path: url.pathname, query: url.search, body, auth: request.headers.authorization });
    const answer = (data, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data }));
    };
    const path = url.pathname;
    if (path === '/api2/json/version') return answer({ version: '7.4-3', release: '7.4' });
    if (path === '/api2/json/nodes') return answer([{ node: 'pve-ci', status: 'online' }, { node: 'pve-2', status: 'online' }]);
    if (path === '/api2/json/cluster/resources') {
      return answer([{ vmid: 104, node: 'pve-2', type: 'qemu', status: 'running' }]);
    }
    if (path === '/api2/json/nodes/pve-2/qemu/104/status/current') return answer({ status: 'running' });
    if (path === '/api2/json/nodes/pve-ci/qemu/104/status/current') return answer({ status: 'stopped' });
    if (path === '/api2/json/nodes/pve-2/qemu/104/status/shutdown') return answer(UPID);
    if (path === '/api2/json/nodes/pve-2/qemu/104/resize') return answer(UPID);
    if (path === '/api2/json/nodes/pve-2/qemu/104/config') return answer({ scsi0: 'local-lvm:vm-104-disk-1,size=8G' });
    if (path === `/api2/json/nodes/pve-2/tasks/${encodeURIComponent(UPID)}/status`) {
      return answer({ status: 'stopped', exitstatus: 'OK' });
    }
    if (path === '/api2/json/nodes/pve-ci/vzdump') return answer(UPID);
    return answer({ message: `unexpected ${request.method} ${path}` }, 500);
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiUrl = `http://127.0.0.1:${port}`;

const settings = {
  ssh: { host: 'pve-ci', user: 'root', port: 22, keyPath: '', sshConfig: '', extraOptions: [] },
  allowVmids: [104],
  instance: 'x99i',
  api: { url: apiUrl, token: TOKEN, fingerprint: '', insecureTls: false },
  node: '',
  mode: 'api',
  enableConsole: true,
  enableGuest: true,
  inputChannel: 'auto',
  sendkeyDelayMs: 80,
  consoleTimeoutMs: 15_000,
  sessionIdleMs: 300_000,
  guestTimeoutMs: 60_000,
  guestTypeCommand: 'true',
  view: { autoOpen: false, followAgent: true, fps: 2, scale: 2 },
};

const controller = withSshFallback(new ApiController({ settings: () => settings, spawn: () => { throw new Error('ssh must not be used by the API transport'); }, cwd: process.cwd() }));

await checkAsync('cross-node placement is read from /cluster/resources', async () => {
  assert.equal(await controller.nodeFor(104), 'pve-2');
  const call = seen.find((item) => item.path === '/api2/json/cluster/resources');
  assert.ok(call, 'cluster resources was not requested');
  assert.equal(call.query, '?type=vm');
});

await checkAsync('the token header is PVEAPIToken=user@realm!id=secret', async () => {
  seen.length = 0;
  await controller.pveshGet('/version');
  assert.equal(seen[0].auth, `PVEAPIToken=${TOKEN}`);
});

await checkAsync('pveshGet returns the parsed data, not an envelope', async () => {
  const config = await controller.pveshGet('/nodes/pve-2/qemu/104/config');
  assert.equal(config.scsi0, 'local-lvm:vm-104-disk-1,size=8G');
});

await checkAsync('qm status follows the VM to its node', async () => {
  seen.length = 0;
  const result = await controller.qm(['status', 104]);
  assert.equal(result.stdout, 'status: running');
  assert.equal(seen[0].path, '/api2/json/nodes/pve-2/qemu/104/status/current');
});

await checkAsync('qm shutdown posts to the status endpoint and awaits the task', async () => {
  seen.length = 0;
  const result = await controller.qm(['shutdown', 104, '--timeout', '30']);
  assert.equal(result.exitCode, 0);
  const post = seen.find((item) => item.method === 'POST');
  assert.equal(post.path, '/api2/json/nodes/pve-2/qemu/104/status/shutdown');
  assert.deepEqual(JSON.parse(post.body), { timeout: 30 });
  assert.ok(seen.some((item) => item.path.includes('/tasks/')), 'the UPID was not awaited');
});

await checkAsync('qm resize becomes POST resize with disk and size', async () => {
  seen.length = 0;
  await controller.qmOk(['resize', 104, 'scsi0', '+8G']);
  const call = seen.find((item) => item.path.endsWith('/resize'));
  assert.deepEqual(JSON.parse(call.body), { disk: 'scsi0', size: '+8G' });
});

await checkAsync('qm set becomes PUT config with delete for a bare key', async () => {
  seen.length = 0;
  await controller.qmOk(['set', 104, '--memory', '4096', '--delete', 'ide2']);
  const call = seen.find((item) => item.method === 'PUT');
  assert.equal(call.path, '/api2/json/nodes/pve-2/qemu/104/config');
  assert.deepEqual(JSON.parse(call.body), { memory: '4096', delete: 'ide2' });
});

await checkAsync('pvesh create returns the UPID as stdout so the tools keep parsing it', async () => {
  seen.length = 0;
  const result = await controller.pvesh('create', '/nodes/pve-ci/vzdump', { params: { vmid: 104, storage: 'local' } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, UPID);
  const call = seen.find((item) => item.method === 'POST');
  assert.equal(call.path, '/api2/json/nodes/pve-ci/vzdump');
  assert.deepEqual(JSON.parse(call.body), { vmid: 104, storage: 'local' });
});

await checkAsync('the allow list still guards the VM id before any call', async () => {
  await assert.rejects(async () => {
    controller.assertAllowed(999);
  }, /not in allowVmids/);
});

await check('the certificate fingerprint is normalised so either case matches', () => {
  const api = new PveApi({ baseUrl: 'https://127.0.0.1:8006', token: TOKEN });
  assert.equal(api.fingerprint, '');
  const pinned = new PveApi({ baseUrl: 'https://127.0.0.1:8006', token: TOKEN, fingerprint: 'AA:BB:CC' });
  assert.equal(pinned.fingerprint, 'aabbcc');
  pinned.close();
  api.close();
});

controller.closeAll();
server.close();

console.log(JSON.stringify({ problems }));
process.exitCode = problems.length === 0 ? 0 : 1;
