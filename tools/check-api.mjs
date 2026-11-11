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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ApiController, withSshFallback } from '../lib/api-controller.js';
import { PveApi } from '../lib/api.js';
import { ConfirmationStore } from '../lib/confirm.js';
import { lxcTools } from './lxc.js';
import { backupTools } from './backup.js';
import { backupJobTools } from './backup-jobs.js';
import { poolTools } from './pools.js';
import { storageAdminTools } from './storage-admin.js';
import { accessTools } from './access.js';

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
    seen.push({ method: request.method, path: url.pathname, query: url.search, body, headers: request.headers, auth: request.headers.authorization });
    const answer = (data, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data }));
    };
    const path = url.pathname;
    if (path === '/api2/json/version') return answer({ version: '7.4-3', release: '7.4' });
    if (path === '/api2/json/nodes') return answer([{ node: 'pve-ci', status: 'online' }, { node: 'pve-2', status: 'online' }]);
    if (path === '/api2/json/cluster/resources') {
      return answer([
        { vmid: 104, node: 'pve-2', type: 'qemu', status: 'running' },
        { vmid: 300, node: 'pve-ci', type: 'lxc', status: 'running', name: 'ct300' },
      ]);
    }
    if (path === '/api2/json/nodes/pve-2/qemu/104/status/current') return answer({ status: 'running' });
    if (path === '/api2/json/nodes/pve-ci/qemu/104/status/current') return answer({ status: 'stopped' });
    if (path === '/api2/json/nodes/pve-2/qemu/104/status/shutdown') return answer(UPID);
    if (path === '/api2/json/nodes/pve-2/qemu/104/resize') return answer(UPID);
    if (path === '/api2/json/nodes/pve-2/qemu/104/config') return answer({ scsi0: 'local-lvm:vm-104-disk-1,size=8G' });
    if (path === `/api2/json/nodes/pve-2/tasks/${encodeURIComponent(UPID)}/status`) {
      return answer({ status: 'stopped', exitstatus: 'OK' });
    }
    if (path === '/api2/json/nodes/pve-ci/vzdump' || path === '/api2/json/nodes/pve-2/vzdump') return answer(UPID);
    if (path === '/api2/json/cluster/backup') {
      if (request.method === 'POST') return answer('backup-abc123');
      return answer([
        { id: 'backup-abc123', storage: 'local', schedule: '02:30', vmid: '100,101', mode: 'snapshot', compress: 'zstd', enabled: 1 },
      ]);
    }
    if (path === '/api2/json/cluster/backup/backup-abc123') {
      if (request.method === 'PUT' || request.method === 'DELETE') return answer(null);
      return answer({ id: 'backup-abc123', storage: 'local', schedule: '02:30', vmid: '100,101', mode: 'snapshot', compress: 'zstd', enabled: 1 });
    }
    if (path === '/api2/json/cluster/backup/backup-stop') {
      return answer({ id: 'backup-stop', storage: 'local', schedule: '03:00', vmid: '104', mode: 'stop', compress: 'zstd', enabled: 1 });
    }
    if (path === '/api2/json/pools') {
      if (request.method === 'POST') return answer(null);
      return answer([{ poolid: 'ci', comment: 'CI pool' }]);
    }
    if (path === '/api2/json/pools/ci') {
      if (request.method === 'PUT') return answer(null);
      return answer({ poolid: 'ci', comment: 'CI pool', members: [{ id: 'qemu/104', type: 'qemu', vmid: 104 }] });
    }
    if (path === '/api2/json/nodes/pve-ci/lxc') return answer(UPID);
    if (path === '/api2/json/nodes/pve-ci/lxc/300/status/current') return answer({ status: 'running' });
    if (path === '/api2/json/nodes/pve-ci/lxc/300/status/stop') return answer(UPID);
    if (path === '/api2/json/nodes/pve-ci/lxc/300/status/start') return answer(UPID);
    if (path === '/api2/json/nodes/pve-ci/lxc/300/status/shutdown') return answer(UPID);
    if (path === '/api2/json/nodes/pve-ci/lxc/300/config') return answer({ hostname: 'ct300', memory: 512 });
    if (path === '/api2/json/nodes/pve-ci/lxc/300/snapshot') return answer([{ name: 'snap1' }]);
    if (path === '/api2/json/storage') {
      if (request.method === 'POST') return answer(null);
      return answer([
        { storage: 'local', type: 'dir', content: 'iso,vztmpl,backup', path: '/var/lib/vz' },
        { storage: 'local-lvm', type: 'lvmthin', content: 'images,rootdir' },
      ]);
    }
    if (path === '/api2/json/storage/local') {
      if (request.method === 'PUT' || request.method === 'DELETE') return answer(null);
      return answer({ storage: 'local', type: 'dir', content: 'iso,vztmpl,backup' });
    }
    if (path === '/api2/json/storage/lab') {
      if (request.method === 'DELETE') return answer(null);
      return answer({ storage: 'lab', type: 'dir' });
    }
    if (path === '/api2/json/nodes/pve-ci/storage/local/content' && request.method === 'GET') {
      return answer([{ volid: 'local:iso/debian-12.iso', size: 536870912, ctime: 1700000000, content: 'iso' }]);
    }
    if (path === '/api2/json/nodes/pve-ci/storage/local/upload') return answer(UPID);
    if (path === '/api2/json/forbidden') {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: null }));
      return undefined;
    }
    if (path === '/api2/json/nodes/pve-ci/storage/local/download-url') return answer(UPID);
    if (path.startsWith('/api2/json/nodes/pve-ci/storage/local/content/') && request.method === 'DELETE') return answer(null);
    if (path === `/api2/json/nodes/pve-ci/tasks/${encodeURIComponent(UPID)}/status`) {
      return answer({ status: 'stopped', exitstatus: 'OK' });
    }
    if (path === '/api2/json/access/users' && request.method === 'GET') {
      return answer([{ userid: 'root@pam' }, { userid: 'ci@pve', groups: 'ci', enable: 1 }]);
    }
    if (path === `/api2/json/access/users/${encodeURIComponent('ci@pve')}` && request.method === 'GET') {
      return answer({ userid: 'ci@pve', groups: 'ci', enable: 1 });
    }
    if (path === '/api2/json/access/users' && request.method === 'POST') return answer(null);
    if (path === `/api2/json/access/users/${encodeURIComponent('ci@pve')}` && (request.method === 'PUT' || request.method === 'DELETE')) {
      return answer(null);
    }
    if (path === '/api2/json/access/groups' && request.method === 'GET') return answer([{ groupid: 'ci', comment: 'CI group' }]);
    if (path === '/api2/json/access/groups' && request.method === 'POST') return answer(null);
    if (path === '/api2/json/access/roles' && request.method === 'GET') {
      return answer([{ roleid: 'PVEAdmin', privs: 'Permissions.Modify,Sys.Modify' }, { roleid: 'DSHOperator', privs: 'VM.Audit,VM.PowerMgmt' }]);
    }
    if (path === '/api2/json/access/roles' && request.method === 'POST') return answer(null);
    if (path === '/api2/json/access/roles/DSHOperator') {
      if (request.method === 'GET') return answer({ roleid: 'DSHOperator', privs: 'VM.Audit,VM.PowerMgmt' });
      if (request.method === 'PUT' || request.method === 'DELETE') return answer(null);
    }
    if (path === '/api2/json/access/acl' && request.method === 'GET') {
      return answer([{ path: '/', roleid: 'PVEAdmin', type: 'token', ugid: 'root@pam!dsh', propagate: 1 }]);
    }
    if (path === '/api2/json/access/acl' && request.method === 'PUT') return answer(null);
    if (path === `/api2/json/access/users/${encodeURIComponent('root@pam')}/token` && request.method === 'GET') {
      return answer([{ tokenid: 'dsh', comment: 'DeepSeek Harness (dsh-pve-vm)' }]);
    }
    if (path === `/api2/json/access/users/${encodeURIComponent('root@pam')}/token/dsh-admin` && request.method === 'POST') {
      return answer({ tokenid: 'dsh-admin', value: 'secret-value-123', privsep: 1 });
    }
    if (path === `/api2/json/access/users/${encodeURIComponent('root@pam')}/token/dsh-admin` && request.method === 'DELETE') {
      return answer(null);
    }
    return answer({ message: `unexpected ${request.method} ${path}` }, 500);
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiUrl = `http://127.0.0.1:${port}`;

const settings = {
  ssh: { host: 'pve-ci', user: 'root', port: 22, keyPath: '', sshConfig: '', extraOptions: [] },
  allowVmids: [104, 300],
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



await checkAsync('a bare 403 is explained as a missing privilege', async () => {
  await assert.rejects(async () => {
    await controller.pveshGet('/forbidden');
  }, (error) => error.code === 'API_DENIED' && /permission denied/.test(error.message) && /role/.test(error.message));
});

await checkAsync('a bare token secret fails as BAD_ARGUMENT before any request', async () => {
  const broken = withSshFallback(
    new ApiController({
      settings: () => ({ ...settings, api: { url: apiUrl, token: 'just-the-secret', fingerprint: '', insecureTls: false } }),
      spawn: () => {
        throw new Error('ssh must not be used by the API transport');
      },
      cwd: process.cwd(),
    }),
  );
  await assert.rejects(async () => {
    await broken.pveshGet('/storage');
  }, (error) => error.code === 'BAD_ARGUMENT' && /user@realm!tokenid=secret/.test(error.message));
  broken.closeAll();
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

const toolDeps = {
  pool: { target: () => ({ name: 'x99i', controller, settings }) },
  settings: () => settings,
  confirms: new ConfirmationStore(),
};
const byName = (list, name) => {
  const found = list.find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`tool ${name} is not registered`);
  return found;
};
const lxc = lxcTools(toolDeps);

await checkAsync('lxc_list reads containers from /cluster/resources and honours the allow list', async () => {
  const out = await byName(lxc, 'lxc_list').execute({}, {});
  assert.equal(out.instance, 'x99i');
  assert.deepEqual(out.containers.map((entry) => entry.vmid), [300]);
  assert.equal(out.containers[0].node, 'pve-ci');
});

await checkAsync('lxc_status resolves the node and reads status plus config', async () => {
  seen.length = 0;
  const out = await byName(lxc, 'lxc_status').execute({ vmid: 300 }, {});
  assert.equal(out.node, 'pve-ci');
  assert.equal(out.config.hostname, 'ct300');
  assert.ok(seen.some((entry) => entry.path.endsWith('/lxc/300/status/current')));
});

await checkAsync('lxc_power stop is gated: nothing happens before the token comes back', async () => {
  const tool = byName(lxc, 'lxc_power');
  seen.length = 0;
  const first = await tool.execute({ vmid: 300, action: 'stop' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(seen.filter((entry) => entry.path.endsWith('/status/stop')).length, 0);
  const done = await tool.execute({ vmid: 300, action: 'stop', confirm: first.confirm }, {});
  assert.equal(done.action, 'stop');
  assert.ok(seen.some((entry) => entry.path.endsWith('/lxc/300/status/stop')));
});

await checkAsync('lxc_power start runs without a token', async () => {
  const tool = byName(lxc, 'lxc_power');
  seen.length = 0;
  const out = await tool.execute({ vmid: 300, action: 'start' }, {});
  assert.equal(out.action, 'start');
  assert.ok(seen.some((entry) => entry.path.endsWith('/status/start')));
});

await checkAsync('lxc_power shutdown is gated like a VM shutdown', async () => {
  const tool = byName(lxc, 'lxc_power');
  seen.length = 0;
  const first = await tool.execute({ vmid: 300, action: 'shutdown' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(first.risk, 'danger');
  assert.equal(seen.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/status/shutdown')).length, 0);
  const done = await tool.execute({ vmid: 300, action: 'shutdown', confirm: first.confirm }, {});
  assert.equal(done.action, 'shutdown');
  assert.equal(done.state, 'running');
  assert.ok(seen.some((entry) => entry.method === 'POST' && entry.path.endsWith('/lxc/300/status/shutdown')));
});

await checkAsync('lxc_create posts the template and the storage to /nodes/{node}/lxc', async () => {
  const tool = byName(lxc, 'lxc_create');
  seen.length = 0;
  const out = await tool.execute({ ostemplate: 'local:vztmpl/debian-12.tar.zst', vmid: 301, storage: 'local-lvm', memory: 1024 }, {});
  assert.equal(out.vmid, 301);
  const post = seen.find((entry) => entry.method === 'POST' && entry.path.endsWith('/nodes/pve-ci/lxc'));
  assert.ok(post, 'the create call was not posted');
  const body = JSON.parse(post.body);
  assert.equal(body.ostemplate, 'local:vztmpl/debian-12.tar.zst');
  assert.equal(body.memory, 1024);
  assert.equal(body.unprivileged, 1);
});

await checkAsync('backup_job run reuses the job record for vzdump', async () => {
  const tool = byName(backupJobTools(toolDeps), 'backup_job');
  seen.length = 0;
  const out = await tool.execute({ action: 'run', id: 'backup-abc123' }, {});
  assert.equal(out.node, 'pve-ci');
  const post = seen.find((entry) => entry.method === 'POST' && entry.path.endsWith('/vzdump'));
  assert.ok(post, 'vzdump was not started');
  const body = JSON.parse(post.body);
  assert.equal(body.vmid, '100,101');
  assert.equal(body.storage, 'local');
});

await checkAsync('backup_job create needs a token and answers the job id', async () => {
  const tool = byName(backupJobTools(toolDeps), 'backup_job');
  const first = await tool.execute({ action: 'create', storage: 'local', schedule: '02:30', vmid: '100' }, {});
  assert.equal(first.status, 'confirmation-required');
  const done = await tool.execute({ action: 'create', storage: 'local', schedule: '02:30', vmid: '100', confirm: first.confirm }, {});
  assert.equal(done.id, 'backup-abc123');
});

await checkAsync('vm_backup start with mode=stop needs a token and performs nothing before it', async () => {
  const tool = byName(backupTools(toolDeps), 'vm_backup');
  seen.length = 0;
  const first = await tool.execute({ action: 'start', vmid: 104, mode: 'stop' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(first.performed, false);
  assert.equal(first.risk, 'danger');
  assert.match(first.summary, /mode "stop"/);
  assert.match(first.summary, /stopped/);
  assert.equal(seen.filter((entry) => entry.method === 'POST').length, 0);
  const done = await tool.execute({ action: 'start', vmid: 104, mode: 'stop', confirm: first.confirm }, {});
  assert.equal(done.action, 'start');
  assert.match(done.upid, /^UPID:/);
  assert.ok(seen.some((entry) => entry.method === 'POST' && entry.path === '/api2/json/nodes/pve-2/vzdump'));
});

await checkAsync('vm_backup start with mode=snapshot runs without a token', async () => {
  const tool = byName(backupTools(toolDeps), 'vm_backup');
  seen.length = 0;
  const out = await tool.execute({ action: 'start', vmid: 104 }, {});
  assert.equal(out.action, 'start');
  assert.match(out.upid, /^UPID:/);
  assert.ok(seen.some((entry) => entry.method === 'POST' && entry.path === '/api2/json/nodes/pve-2/vzdump'));
});

await checkAsync('backup_job run with a stored stop mode needs a token', async () => {
  const tool = byName(backupJobTools(toolDeps), 'backup_job');
  seen.length = 0;
  const first = await tool.execute({ action: 'run', id: 'backup-stop' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(first.risk, 'danger');
  assert.match(first.summary, /mode "stop"/);
  assert.equal(seen.filter((entry) => entry.method === 'POST').length, 0);
  const done = await tool.execute({ action: 'run', id: 'backup-stop', confirm: first.confirm }, {});
  assert.match(done.upid, /^UPID:/);
  assert.ok(seen.some((entry) => entry.method === 'POST' && entry.path === '/api2/json/nodes/pve-ci/vzdump'));
});

await checkAsync('pve_pool creates a pool and lists one pool in detail', async () => {
  const tool = byName(poolTools(toolDeps), 'pve_pool');
  seen.length = 0;
  const out = await tool.execute({ action: 'create', pool: 'lab', comment: 'lab' }, {});
  assert.equal(out.pool, 'lab');
  const post = seen.find((entry) => entry.method === 'POST' && entry.path.endsWith('/pools'));
  assert.ok(post, 'the pool was not created');
  const detail = await tool.execute({ action: 'list', pool: 'ci' }, {});
  assert.equal(detail.pools[0].members[0].vmid, 104);
});

await checkAsync('pve_pool update needs a token and names the membership change', async () => {
  const tool = byName(poolTools(toolDeps), 'pve_pool');
  seen.length = 0;
  const first = await tool.execute({ action: 'update', pool: 'ci', vms: '105' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(first.performed, false);
  assert.equal(first.risk, 'danger');
  assert.match(first.summary, /added \[105\]/);
  assert.match(first.summary, /removed \[104\]/);
  assert.match(first.summary, /ACL/i);
  assert.equal(seen.filter((entry) => entry.method === 'PUT').length, 0);
  const done = await tool.execute({ action: 'update', pool: 'ci', vms: '105', confirm: first.confirm }, {});
  assert.equal(done.action, 'update');
  assert.ok(seen.some((entry) => entry.method === 'PUT' && entry.path === '/api2/json/pools/ci'));
});


const storage = storageAdminTools(toolDeps);
const storageTool = byName(storage, 'pve_storage');
const contentTool = byName(storage, 'storage_content');

await checkAsync('pve_storage lists the storage records and can filter one', async () => {
  const all = await storageTool.execute({ action: 'list' }, {});
  assert.deepEqual(all.storages.map((entry) => entry.storage), ['local', 'local-lvm']);
  const one = await storageTool.execute({ action: 'list', storage: 'local' }, {});
  assert.equal(one.storages.length, 1);
  assert.equal(one.storages[0].type, 'dir');
});

await checkAsync('pve_storage create is gated and posts the definition', async () => {
  seen.length = 0;
  const first = await storageTool.execute({ action: 'create', storage: 'lab', type: 'dir', path: '/mnt/lab' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(seen.filter((entry) => entry.method === 'POST').length, 0);
  const done = await storageTool.execute({ action: 'create', storage: 'lab', type: 'dir', path: '/mnt/lab', confirm: first.confirm }, {});
  assert.equal(done.storage, 'lab');
  const post = seen.find((entry) => entry.method === 'POST' && entry.path.endsWith('/storage'));
  assert.ok(post, 'the storage record was not posted');
  const body = JSON.parse(post.body);
  assert.equal(body.storage, 'lab');
  assert.equal(body.type, 'dir');
  assert.equal(body.path, '/mnt/lab');
  assert.equal(body.content, 'images,iso,backup');
});

await checkAsync('pve_storage delete is gated and sends DELETE', async () => {
  seen.length = 0;
  const first = await storageTool.execute({ action: 'delete', storage: 'lab' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(seen.filter((entry) => entry.method === 'DELETE').length, 0);
  await storageTool.execute({ action: 'delete', storage: 'lab', confirm: first.confirm }, {});
  assert.ok(seen.some((entry) => entry.method === 'DELETE' && entry.path === '/api2/json/storage/lab'));
});

await checkAsync('storage_content list asks for the content kind on the right node', async () => {
  seen.length = 0;
  const out = await contentTool.execute({ action: 'list', storage: 'local' }, {});
  assert.equal(out.node, 'pve-ci');
  assert.equal(out.volumes[0].volid, 'local:iso/debian-12.iso');
  const call = seen.find((entry) => entry.path.endsWith('/storage/local/content'));
  assert.ok(call, 'the content endpoint was not read');
  assert.match(call.query, /content=iso/);
});

await checkAsync('storage_content upload-iso streams multipart and awaits the UPID', async () => {
  const file = path.join(os.tmpdir(), 'pve-check-probe.iso');
  fs.writeFileSync(file, Buffer.from('probe-iso-bytes'));
  try {
    seen.length = 0;
    const out = await contentTool.execute({ action: 'upload-iso', storage: 'local', file, filename: 'probe.iso' }, {});
    assert.equal(out.filename, 'probe.iso');
    const post = seen.find((entry) => entry.method === 'POST' && entry.path.endsWith('/storage/local/upload'));
    assert.ok(post, 'the upload was not posted');
    assert.match(post.headers?.['content-type'] ?? '', /multipart\/form-data; boundary=----dshpve/);
    assert.match(post.body, /name="filename"; filename="probe\.iso"/);
    assert.match(post.body, /probe-iso-bytes/);
    assert.ok(seen.some((entry) => entry.path.includes('/tasks/')), 'the upload task was not awaited');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

await checkAsync('storage_content delete-volume is gated and deletes the full volume id', async () => {
  seen.length = 0;
  const first = await contentTool.execute({ action: 'delete-volume', storage: 'local', volume: 'local:iso/debian-12.iso' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(seen.filter((entry) => entry.method === 'DELETE').length, 0);
  await contentTool.execute({ action: 'delete-volume', storage: 'local', volume: 'local:iso/debian-12.iso', confirm: first.confirm }, {});
  assert.ok(
    seen.some((entry) => entry.method === 'DELETE' && entry.path === `/api2/json/nodes/pve-ci/storage/local/content/${encodeURIComponent('local:iso/debian-12.iso')}`),
  );
});

await checkAsync('storage_content download-url posts the URL to the node', async () => {
  seen.length = 0;
  const out = await contentTool.execute({ action: 'download-url', storage: 'local', url: 'https://example.invalid/debian.iso' }, {});
  assert.equal(out.upid, UPID);
  const post = seen.find((entry) => entry.path.endsWith('/download-url'));
  assert.deepEqual(JSON.parse(post.body), { url: 'https://example.invalid/debian.iso', content: 'iso' });
});

const failingWriteDeps = {
  pool: {
    target: () => ({
      name: 'x99i',
      controller: {
        nodeName: async () => 'pve-ci',
        pvesh: async () => ({ exitCode: 1, stdout: '', stderr: 'storage "local" is read-only' }),
      },
      settings,
    }),
  },
  settings: () => settings,
  confirms: new ConfirmationStore(),
};

await checkAsync('a storage write that exits non-zero surfaces the stderr instead of success', async () => {
  const failingStorage = storageAdminTools(failingWriteDeps);
  await assert.rejects(
    () => byName(failingStorage, 'storage_content').execute({ action: 'download-url', storage: 'local', url: 'https://example.invalid/x.iso' }, {}),
    (error) => error.code === 'NODE_COMMAND_FAILED' && /exited with 1/.test(error.message) && /read-only/.test(error.message),
  );
  const tool = byName(failingStorage, 'pve_storage');
  const first = await tool.execute({ action: 'delete', storage: 'lab' }, {});
  assert.equal(first.status, 'confirmation-required');
  await assert.rejects(
    () => tool.execute({ action: 'delete', storage: 'lab', confirm: first.confirm }, {}),
    (error) => error.code === 'NODE_COMMAND_FAILED' && /exited with 1/.test(error.message) && /read-only/.test(error.message),
  );
});

await checkAsync('storage_content import-disk asks for confirmation before touching a VM', async () => {
  seen.length = 0;
  const first = await contentTool.execute({ action: 'import-disk', storage: 'local-lvm', vmid: 104, source: '/tmp/disk.qcow2' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.match(first.summary, /import/i);
});


const access = accessTools(toolDeps);
const byTool = (name) => byName(access, name);

await checkAsync('pve_user lists and reads one user', async () => {
  const tool = byTool('pve_user');
  const all = await tool.execute({ action: 'list' }, {});
  assert.deepEqual(all.users.map((entry) => entry.userid), ['root@pam', 'ci@pve']);
  const one = await tool.execute({ action: 'get', userid: 'ci@pve' }, {});
  assert.equal(one.user.groups, 'ci');
});

await checkAsync('pve_user create is gated and posts the account', async () => {
  const tool = byTool('pve_user');
  seen.length = 0;
  const first = await tool.execute({ action: 'create', userid: 'ops@pve', password: 'x'.repeat(12), groups: 'ci' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(seen.filter((entry) => entry.method === 'POST').length, 0);
  const done = await tool.execute({ action: 'create', userid: 'ops@pve', password: 'x'.repeat(12), groups: 'ci', confirm: first.confirm }, {});
  assert.equal(done.userid, 'ops@pve');
  const post = seen.find((entry) => entry.method === 'POST' && entry.path === '/api2/json/access/users');
  const body = JSON.parse(post.body);
  assert.equal(body.userid, 'ops@pve');
  assert.equal(body.groups, 'ci');
  assert.equal(body.password.length, 12);
});

await checkAsync('pve_user rejects a user id without a realm', async () => {
  const tool = byTool('pve_user');
  await assert.rejects(async () => {
    await tool.execute({ action: 'get', userid: 'root' }, {});
  }, /name@realm/);
});

await checkAsync('pve_role create is gated and sends the privilege list', async () => {
  const tool = byTool('pve_role');
  seen.length = 0;
  const first = await tool.execute({ action: 'create', roleid: 'DSHOperator', privs: 'VM.Audit, VM.PowerMgmt' }, {});
  assert.equal(first.status, 'confirmation-required');
  const done = await tool.execute({ action: 'create', roleid: 'DSHOperator', privs: 'VM.Audit, VM.PowerMgmt', confirm: first.confirm }, {});
  assert.equal(done.privs, 'VM.Audit,VM.PowerMgmt');
  const post = seen.find((entry) => entry.method === 'POST' && entry.path === '/api2/json/access/roles');
  assert.deepEqual(JSON.parse(post.body), { roleid: 'DSHOperator', privs: 'VM.Audit,VM.PowerMgmt' });
});

await checkAsync('pve_role update append keeps the existing privileges', async () => {
  const tool = byTool('pve_role');
  seen.length = 0;
  const first = await tool.execute({ action: 'update', roleid: 'DSHOperator', privs: 'VM.Console', append: true }, {});
  const done = await tool.execute({ action: 'update', roleid: 'DSHOperator', privs: 'VM.Console', append: true, confirm: first.confirm }, {});
  assert.equal(done.privs, 'VM.Audit,VM.PowerMgmt,VM.Console');
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path === '/api2/json/access/roles/DSHOperator');
  assert.deepEqual(JSON.parse(put.body), { privs: 'VM.Audit,VM.PowerMgmt,VM.Console' });
});

await checkAsync('pve_acl set is gated and grants exactly one subject', async () => {
  const tool = byTool('pve_acl');
  seen.length = 0;
  const first = await tool.execute({ action: 'set', path: '/vms/104', tokens: 'root@pam!dsh', roles: 'PVEAdmin' }, {});
  assert.equal(first.status, 'confirmation-required');
  await tool.execute({ action: 'set', path: '/vms/104', tokens: 'root@pam!dsh', roles: 'PVEAdmin', confirm: first.confirm }, {});
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path === '/api2/json/access/acl');
  assert.deepEqual(JSON.parse(put.body), { path: '/vms/104', roles: 'PVEAdmin', tokens: 'root@pam!dsh', propagate: 1 });
});

await checkAsync('pve_acl remove puts delete=1 on the same endpoint', async () => {
  const tool = byTool('pve_acl');
  seen.length = 0;
  const first = await tool.execute({ action: 'remove', path: '/vms/104', tokens: 'root@pam!dsh', roles: 'PVEAdmin' }, {});
  await tool.execute({ action: 'remove', path: '/vms/104', tokens: 'root@pam!dsh', roles: 'PVEAdmin', confirm: first.confirm }, {});
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path === '/api2/json/access/acl');
  assert.equal(JSON.parse(put.body).delete, 1);
});

await checkAsync('pve_acl refuses two subject kinds at once', async () => {
  const tool = byTool('pve_acl');
  await assert.rejects(async () => {
    await tool.execute({ action: 'set', path: '/', users: 'root@pam', groups: 'ci', roles: 'PVEAdmin' }, {});
  }, /exactly one of/);
});

await checkAsync('pve_token create is gated and returns the one-time secret', async () => {
  const tool = byTool('pve_token');
  seen.length = 0;
  const first = await tool.execute({ action: 'create', userid: 'root@pam', tokenid: 'dsh-admin' }, {});
  assert.equal(first.status, 'confirmation-required');
  const done = await tool.execute({ action: 'create', userid: 'root@pam', tokenid: 'dsh-admin', confirm: first.confirm }, {});
  assert.equal(done.secret, 'secret-value-123');
  const post = seen.find((entry) => entry.method === 'POST' && entry.path.endsWith('/token/dsh-admin'));
  assert.deepEqual(JSON.parse(post.body), { tokenid: 'dsh-admin' });
});

await checkAsync('pve_token remove is gated and deletes the token path', async () => {
  const tool = byTool('pve_token');
  seen.length = 0;
  const first = await tool.execute({ action: 'remove', userid: 'root@pam', tokenid: 'dsh-admin' }, {});
  assert.equal(first.status, 'confirmation-required');
  await tool.execute({ action: 'remove', userid: 'root@pam', tokenid: 'dsh-admin', confirm: first.confirm }, {});
  assert.ok(seen.some((entry) => entry.method === 'DELETE' && entry.path.endsWith('/token/dsh-admin')));
});

controller.closeAll();
server.close();

console.log(JSON.stringify({ problems }));
process.exitCode = problems.length === 0 ? 0 : 1;
