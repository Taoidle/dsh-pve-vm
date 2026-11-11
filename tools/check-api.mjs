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
import { storageTools } from './storage.js';
import { vmDetailTools } from './vm-detail.js';
import { guestExtraTools } from './guest-extra.js';
import { passthroughTools } from './passthrough.js';
import { lxcExtraTools } from './lxc-extra.js';
import { clusterExtraTools } from './cluster-extra.js';
import { nodeExtraTools } from './node-extra.js';
import { accessExtraTools } from './access-extra.js';
import { firewallExtraTools } from './firewall-extra.js';
import { monitorExtraTools } from './monitor-extra.js';

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
    if (path === '/api2/json/nodes/pve-2/qemu/104/config') {
      return answer({
        scsi0: 'local-lvm:vm-104-disk-1,size=8G',
        unused0: 'local-lvm:vm-104-disk-9',
        hostpci2: '0000:01:00.0',
        usb0: 'host=1-2',
      });
    }
    if (path === '/api2/json/nodes/pve-2/qemu/104/pending') return answer([{ key: 'scsi1', value: 'local-lvm:vm-104-disk-2', pending: 'delete' }]);
    if (path === '/api2/json/nodes/pve-2/qemu/104/unlink') return answer(null);
    if (path === '/api2/json/nodes/pve-2/qemu/104/rrddata') return answer([{ time: 1700000000, cpu: 0.12, mem: 1024 }]);
    if (path === '/api2/json/nodes/pve-2/qemu/104/feature') return answer({ hasFeature: 1, nodes: ['pve-2'] });
    if (path === '/api2/json/nodes/pve-2/qemu/104/cloudinit') {
      if (request.method === 'PUT') return answer(null);
      return answer({ ciuser: { old: 'debian', new: 'debian' } });
    }
    if (path === '/api2/json/nodes/pve-2/qemu/104/cloudinit/dump') return answer('#cloud-config\nusers: []\n');
    if (path === '/api2/json/nodes/pve-2/qemu/104/agent/fsfreeze-freeze') return answer({ frozen: true });
    if (path === '/api2/json/nodes/pve-2/qemu/104/agent/fsfreeze-thaw') return answer({ frozen: false });
    if (path === '/api2/json/nodes/pve-2/qemu/104/agent/set-user-password') return answer({ result: null });
    if (path === '/api2/json/nodes/pve-2/qemu/104/agent/exec') return answer({ pid: 4242 });
    if (path === '/api2/json/nodes/pve-2/qemu/104/agent/exec-status') return answer({ exited: true, exitcode: 0, 'out-data': 'hi\n' });
    if (path === '/api2/json/nodes/pve-2/qemu/104/agent/get-osinfo') return answer({ result: { id: 'debian', 'pretty-name': 'Debian GNU/Linux 12' } });
    if (path === '/api2/json/nodes/pve-2/qemu/104/agent/get-fsinfo') return answer({ result: [{ name: '/', type: 'ext4' }] });
    if (path === '/api2/json/nodes/pve-2/qemu/104/agent/network-get-interfaces') return answer({ result: [{ name: 'eth0' }] });
    if (path === '/api2/json/nodes/pve-ci/hardware/pci') return answer([{ id: '0000:01:00.0', vendor_name: 'NVIDIA', device_name: 'GA102' }]);
    if (path === '/api2/json/nodes/pve-ci/hardware/usb') return answer([{ busnum: 1, devnum: 2, usbpath: '1-2', vendid: '1234', prodid: '5678', product: 'Keyboard' }]);
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
    if (path === '/api2/json/nodes/pve-ci/lxc/300/clone') return answer(UPID);
    if (path === '/api2/json/nodes/pve-ci/lxc/300/migrate') return answer(UPID);
    if (path === '/api2/json/nodes/pve-ci/lxc/300/resize') return answer(UPID);
    if (path === '/api2/json/nodes/pve-ci/lxc/300/move_volume') return answer(UPID);
    if (path === '/api2/json/nodes/pve-ci/lxc/300/template') return answer(null);
    if (path === '/api2/json/nodes/pve-ci/lxc/300/feature') return answer({ hasFeature: 1, nodes: ['pve-ci'] });
    if (path === '/api2/json/nodes/pve-ci/lxc/300/rrddata') return answer([{ time: 1700000000, cpu: 0.2 }]);
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
    const fail = (message, status = 501) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: null, message }));
    };

    // --- cluster extra tools ---
    if (path === '/api2/json/cluster/ha/resources') {
      if (request.method === 'POST') return answer(null);
      return answer([{ sid: 'vm:104', type: 'vm', state: 'started', group: 'nodes' }]);
    }
    if (path === `/api2/json/cluster/ha/resources/${encodeURIComponent('vm:104')}`) {
      if (request.method === 'PUT' || request.method === 'DELETE') return answer(null);
      return answer({ sid: 'vm:104', type: 'vm', state: 'started' });
    }
    if (path === '/api2/json/cluster/ha/groups') {
      if (request.method === 'POST') return answer(null);
      return answer([{ group: 'nodes', nodes: 'pve-ci:1', restricted: 0 }]);
    }
    if (path === '/api2/json/cluster/ha/groups/nodes') {
      if (request.method === 'PUT' || request.method === 'DELETE') return answer(null);
      return answer({ group: 'nodes', nodes: 'pve-ci:1' });
    }
    if (path === '/api2/json/cluster/ha/status/current') {
      return answer([{ id: 'quorum', type: 'quorum', status: 'OK', node: 'pve-ci', quorate: 1 }]);
    }
    if (path === '/api2/json/cluster/ha/rules') return fail('no such resource');
    if (path === '/api2/json/cluster/replication') {
      if (request.method === 'POST') return answer(null);
      return answer([{ id: '104-0', source: 'pve-ci', target: 'pve-2', schedule: '*/15', disable: 0 }]);
    }
    if (path === '/api2/json/cluster/replication/104-0') {
      if (request.method === 'PUT' || request.method === 'DELETE') return answer(null);
      return answer({ id: '104-0', source: 'pve-ci', target: 'pve-2', schedule: '*/15' });
    }
    if (path === '/api2/json/nodes/pve-ci/replication/104-0/schedule_now' && request.method === 'POST') return answer(null);
    if (path === '/api2/json/cluster/options') {
      if (request.method === 'PUT') return answer(null);
      return answer({ language: 'en', console: 'xtermjs' });
    }
    if (path === '/api2/json/cluster/metrics/server') {
      if (request.method === 'POST') return answer(null);
      return answer([{ id: 'influx', type: 'influxdb', server: 'metrics.lab', port: 8089, disable: 0 }]);
    }
    if (path === '/api2/json/cluster/metrics/server/influx') {
      if (request.method === 'PUT' || request.method === 'DELETE') return answer(null);
      return answer({ id: 'influx', type: 'influxdb', server: 'metrics.lab', port: 8089 });
    }
    if (path === '/api2/json/cluster/metrics/influxdb') return fail('no such resource');
    if (path === '/api2/json/cluster/tasks') {
      return answer([
        { upid: 'UPID:pve-ci:00000001:00000001:64F00001:qmstart:104:root@pam:', type: 'qmstart', id: '104', status: 'OK', node: 'pve-ci', user: 'root@pam', starttime: 1_700_000_100 },
        { upid: 'UPID:pve-ci:00000002:00000002:64F00000:vzdump:104:root@pam:', type: 'vzdump', id: '104', status: 'OK', node: 'pve-ci', user: 'root@pam', starttime: 1_700_000_000 },
      ]);
    }

    // --- node extra tools ---
    if (path === '/api2/json/nodes/pve-ci/dns') {
      if (request.method === 'PUT') return answer(null);
      return answer({ search: 'lab', dns1: '1.1.1.1' });
    }
    if (path === '/api2/json/nodes/pve-ci/time') {
      if (request.method === 'PUT') return answer(null);
      return answer({ timezone: 'UTC', localtime: 1_700_000_000 });
    }
    if (path === '/api2/json/nodes/pve-ci/disks/list') {
      return answer([{ devpath: '/dev/sda', model: 'Samsung SSD', size: 512_110_190_592, health: 'PASSED' }]);
    }
    if (path === '/api2/json/nodes/pve-ci/disks/smart') return answer({ health: 'PASSED', type: 'ata' });
    if (path === '/api2/json/nodes/pve-ci/disks/zfs') return answer([{ name: 'tank', state: 'ONLINE' }]);
    if (path === '/api2/json/nodes/pve-ci/disks/lvm') return answer([{ name: 'pve', size: '100G' }]);
    if (path === '/api2/json/nodes/pve-ci/disks/directory') return answer([{ path: '/var/lib/vz' }]);
    if (path === '/api2/json/nodes/pve-ci/apt/repositories') {
      if (request.method === 'PUT' || request.method === 'POST') return answer(null);
      return answer({ files: [{ path: '/etc/apt/sources.list', repositories: [{ index: 0, enabled: 1, handle: 'no-subscription' }] }] });
    }
    if (path === '/api2/json/nodes/pve-ci/hosts') {
      if (request.method === 'PUT' || request.method === 'DELETE') return fail('no such resource');
      if (request.method === 'POST') return answer(null);
      return answer({ data: '127.0.0.1 localhost\n192.168.2.220 pve-ci\n', digest: 'hosts-digest' });
    }
    if (path === '/api2/json/nodes/pve-ci/wakeonlan' && request.method === 'POST') return answer(null);
    if (path === '/api2/json/nodes/pve-ci/execute' && request.method === 'POST') {
      return answer([{ data: { release: '7.4', version: '7.4-3' }, status: 200 }]);
    }
    if (path === '/api2/json/nodes/pve-ci/rrddata') return answer([{ time: 1_700_000_000, cpu: 0.08, memused: 2_000_000_000 }]);
    if (path === '/api2/json/nodes/pve-ci/diagnostics') return fail('no such resource');
    if (path === '/api2/json/nodes/pve-ci/report') return answer('PVE REPORT\npveversion: 7.4\nhostname: pve-ci\n');
    if (path === '/api2/json/nodes/pve-ci/subscription') {
      if (request.method === 'PUT' || request.method === 'POST' || request.method === 'DELETE') return answer(null);
      return answer({ status: 'Active', level: 'c', key: 'pve8c-0123456789', nextduedate: '2027-01-01' });
    }
    if (path === '/api2/json/nodes/pve-ci/certificates/info') {
      return answer([{ filename: 'pveproxy-ssl.pem', subject: 'CN=pve-ci', issuer: 'CN=lab-ca', notafter: '2027-01-01' }]);
    }
    if (path === '/api2/json/nodes/pve-ci/certificates/custom' && (request.method === 'POST' || request.method === 'DELETE')) {
      return answer(null);
    }
    if (path === '/api2/json/nodes/pve-ci/certificates/acme/certificate' && ['POST', 'PUT', 'DELETE'].includes(request.method)) {
      return answer(null);
    }
    if (path === '/api2/json/cluster/notifications/endpoints') return fail('no such resource');

    // --- access extra tools ---
    if (path === '/api2/json/access/domains') {
      if (request.method === 'POST') return answer(null);
      return answer([{ realm: 'pam', type: 'pam', comment: 'Linux PAM' }]);
    }
    if (path === '/api2/json/access/domains/pam') {
      if (request.method === 'PUT' || request.method === 'DELETE') return answer(null);
      return answer({ realm: 'pam', type: 'pam', comment: 'Linux PAM' });
    }
    if (path === '/api2/json/access/domains/pam/sync' && request.method === 'POST') return answer('sync-job-1');
    if (path === `/api2/json/access/users/${encodeURIComponent('root@pam')}/tfa`) {
      return answer([{ id: 'totp-1', type: 'totp', enable: 1, description: 'phone' }]);
    }
    if (path === `/api2/json/access/tfa/${encodeURIComponent('root@pam')}/totp-1` && request.method === 'DELETE') return answer(null);
    if (path === '/api2/json/access/permissions') {
      return answer({ '/': { 'Sys.Audit': 1 }, '/vms/104': { 'VM.Audit': 1 } });
    }
    if (path === `/api2/json/access/users/${encodeURIComponent('root@pam')}/permissions`) return fail('no such resource');
    if (path === '/api2/json/access/password' && request.method === 'PUT') return answer(null);
    if (path === `/api2/json/access/users/${encodeURIComponent('root@pam')}/token/dsh-rotate` && request.method === 'PUT') {
      return answer({ value: 'new-secret-value', privsep: 1 });
    }

    // --- firewall extra tools ---
    if (path === '/api2/json/cluster/firewall/groups') {
      if (request.method === 'POST') return answer(null);
      return answer([{ group: 'web', comment: 'web servers' }]);
    }
    if (path === '/api2/json/cluster/firewall/groups/web') {
      if (request.method === 'POST' || request.method === 'DELETE') return answer(null);
      return answer([{ pos: 0, action: 'ACCEPT', type: 'in', proto: 'tcp', dport: '22' }]);
    }
    if (path === '/api2/json/cluster/firewall/groups/web/0' && (request.method === 'PUT' || request.method === 'DELETE')) return answer(null);
    if (path === '/api2/json/cluster/firewall/ipset') {
      if (request.method === 'POST') return answer(null);
      return answer([{ name: 'blocked', comment: 'blocked ranges' }]);
    }
    if (path === '/api2/json/cluster/firewall/ipset/blocked') {
      if (request.method === 'POST' || request.method === 'DELETE') return answer(null);
      return answer([{ cidr: '10.0.0.0/8', nomatch: 0 }]);
    }
    if (path === `/api2/json/cluster/firewall/ipset/blocked/${encodeURIComponent('10.0.0.0/8')}` && (request.method === 'PUT' || request.method === 'DELETE')) {
      return answer(null);
    }
    if (path === '/api2/json/cluster/firewall/aliases') {
      if (request.method === 'POST') return answer(null);
      return answer([{ name: 'dns', cidr: '1.1.1.1', comment: 'DNS' }]);
    }
    if (path === '/api2/json/cluster/firewall/aliases/dns') {
      if (request.method === 'PUT' || request.method === 'DELETE') return answer(null);
      return answer({ name: 'dns', cidr: '1.1.1.1', comment: 'DNS' });
    }
    if (path === '/api2/json/cluster/firewall/options') {
      if (request.method === 'PUT') return answer(null);
      return answer({ enable: 1, policy_in: 'DROP', policy_out: 'ACCEPT' });
    }
    if (path === '/api2/json/cluster/firewall/refs') return answer({ alias: [{ name: 'dns', ref: '/cluster/firewall/rules/0' }] });
    if (path === '/api2/json/nodes/pve-ci/firewall/log') {
      return answer([{ n: 1, t: '1700000000', d: 'ACCEPT tcp -- 1.2.3.4 0.0.0.0/0 tcp dpt:22' }]);
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


const diskTools = storageTools(toolDeps);
const diskTool = byName(diskTools, 'vm_disk');

await checkAsync('vm_disk list also reports detached unusedN volumes', async () => {
  const out = await diskTool.execute({ vmid: 104, action: 'list' }, {});
  const slots = out.disks.map((disk) => disk.slot);
  assert.ok(slots.includes('scsi0'));
  assert.ok(slots.includes('unused0'));
  assert.equal(out.disks.find((disk) => disk.slot === 'unused0').unused, true);
});

await checkAsync('vm_disk unlink is gated and sends the idlist as PUT', async () => {
  seen.length = 0;
  const first = await diskTool.execute({ vmid: 104, action: 'unlink', slots: 'unused0' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(seen.filter((entry) => entry.path.endsWith('/unlink')).length, 0);
  const done = await diskTool.execute({ vmid: 104, action: 'unlink', slots: 'unused0', confirm: first.confirm }, {});
  assert.deepEqual(done.slots, ['unused0']);
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path.endsWith('/qemu/104/unlink'));
  assert.deepEqual(JSON.parse(put.body), { idlist: 'unused0' });
});

await checkAsync('vm_disk pending-delete is gated and uses config delete', async () => {
  seen.length = 0;
  const first = await diskTool.execute({ vmid: 104, action: 'pending-delete', key: 'scsi1' }, {});
  assert.equal(first.status, 'confirmation-required');
  const done = await diskTool.execute({ vmid: 104, action: 'pending-delete', key: 'scsi1', confirm: first.confirm }, {});
  assert.equal(done.key, 'scsi1');
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path.endsWith('/qemu/104/config'));
  assert.deepEqual(JSON.parse(put.body), { delete: 'scsi1' });
  assert.ok(seen.some((entry) => entry.path.endsWith('/qemu/104/pending')));
});

const detailTool = byName(vmDetailTools(toolDeps), 'vm_detail');

await checkAsync('vm_detail rrddata passes timeframe and uppercase cf', async () => {
  seen.length = 0;
  const out = await detailTool.execute({ vmid: 104, action: 'rrddata', timeframe: 'day', cf: 'max' }, {});
  assert.equal(out.cf, 'MAX');
  assert.equal(out.data.length, 1);
  const call = seen.find((entry) => entry.path.endsWith('/qemu/104/rrddata'));
  assert.match(call.query, /timeframe=day/);
  assert.match(call.query, /cf=MAX/);
});

await checkAsync('vm_detail feature reports support and the answering nodes', async () => {
  seen.length = 0;
  const out = await detailTool.execute({ vmid: 104, action: 'feature', feature: 'snapshot' }, {});
  assert.equal(out.supported, true);
  assert.deepEqual(out.nodes, ['pve-2']);
  const call = seen.find((entry) => entry.path.endsWith('/qemu/104/feature'));
  assert.match(call.query, /feature=snapshot/);
});

const guestTool = byName(guestExtraTools(toolDeps), 'vm_guest');

await checkAsync('vm_guest cloudinit-dump returns the requested config as text', async () => {
  seen.length = 0;
  const out = await guestTool.execute({ vmid: 104, action: 'cloudinit-dump', type: 'network' }, {});
  assert.match(out.text, /cloud-config/);
  assert.match(seen.find((entry) => entry.path.endsWith('/cloudinit/dump')).query, /type=network/);
});

await checkAsync('vm_guest cloudinit-set is gated and writes fields then regenerates', async () => {
  seen.length = 0;
  const first = await guestTool.execute({ vmid: 104, action: 'cloudinit-set', settings: ['ciuser=debian'] }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(seen.filter((entry) => entry.method === 'PUT').length, 0);
  const done = await guestTool.execute({ vmid: 104, action: 'cloudinit-set', settings: ['ciuser=debian'], confirm: first.confirm }, {});
  assert.deepEqual(done.fields, ['ciuser']);
  const puts = seen.filter((entry) => entry.method === 'PUT');
  assert.ok(puts.some((entry) => entry.path.endsWith('/qemu/104/config')));
  assert.ok(puts.some((entry) => entry.path.endsWith('/qemu/104/cloudinit')));
  assert.deepEqual(JSON.parse(puts.find((entry) => entry.path.endsWith('/config')).body), { ciuser: 'debian' });
});

await checkAsync('vm_guest fsfreeze freeze is gated and thaw stays available', async () => {
  seen.length = 0;
  const first = await guestTool.execute({ vmid: 104, action: 'fsfreeze', freeze: true }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(seen.filter((entry) => entry.path.endsWith('/fsfreeze-freeze')).length, 0);
  const done = await guestTool.execute({ vmid: 104, action: 'fsfreeze', freeze: true, confirm: first.confirm }, {});
  assert.equal(done.frozen, true);
  assert.ok(seen.some((entry) => entry.method === 'POST' && entry.path.endsWith('/agent/fsfreeze-freeze')));
  const thaw = await guestTool.execute({ vmid: 104, action: 'fsfreeze', freeze: false }, {});
  assert.equal(thaw.frozen, false);
  assert.ok(seen.some((entry) => entry.path.endsWith('/agent/fsfreeze-thaw')));
});

await checkAsync('vm_guest password is gated and never echoes the secret', async () => {
  seen.length = 0;
  const secret = 'hunter2-secret';
  const first = await guestTool.execute({ vmid: 104, action: 'password', user: 'root', password: secret }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.ok(!first.summary.includes(secret));
  const done = await guestTool.execute({ vmid: 104, action: 'password', user: 'root', password: secret, confirm: first.confirm }, {});
  assert.equal(done.user, 'root');
  assert.ok(!JSON.stringify(done).includes(secret));
  const post = seen.find((entry) => entry.path.endsWith('/agent/set-user-password'));
  assert.deepEqual(JSON.parse(post.body), { username: 'root', password: secret });
});

await checkAsync('vm_guest exec is gated, NUL-joins argv and allow-lists the executable', async () => {
  seen.length = 0;
  await assert.rejects(
    async () => guestTool.execute({ vmid: 104, action: 'exec', path: '/tmp/evil', args: [] }, {}),
    /allow list/,
  );
  const first = await guestTool.execute({ vmid: 104, action: 'exec', path: '/bin/echo', args: ['hi there'] }, {});
  assert.equal(first.status, 'confirmation-required');
  const done = await guestTool.execute({ vmid: 104, action: 'exec', path: '/bin/echo', args: ['hi there'], confirm: first.confirm }, {});
  assert.equal(done.pid, 4242);
  const post = seen.find((entry) => entry.path.endsWith('/agent/exec'));
  assert.equal(JSON.parse(post.body).command, '/bin/echo\u0000hi there');
});

await checkAsync('vm_guest probes use the get-osinfo and network-get-interfaces endpoints', async () => {
  seen.length = 0;
  const os = await guestTool.execute({ vmid: 104, action: 'osinfo' }, {});
  assert.equal(os.data.result.id, 'debian');
  await guestTool.execute({ vmid: 104, action: 'interfaces' }, {});
  assert.ok(seen.some((entry) => entry.path.endsWith('/agent/network-get-interfaces')));
});

const passTool = byName(passthroughTools(toolDeps), 'vm_passthrough');

await checkAsync('vm_passthrough lists PCI and USB hardware on the node', async () => {
  seen.length = 0;
  const pci = await passTool.execute({ action: 'pci-list' }, {});
  assert.equal(pci.devices[0].id, '0000:01:00.0');
  const usb = await passTool.execute({ action: 'usb-list' }, {});
  assert.equal(usb.devices[0].usbpath, '1-2');
  assert.ok(seen.some((entry) => entry.path.endsWith('/hardware/pci')));
  assert.ok(seen.some((entry) => entry.path.endsWith('/hardware/usb')));
});

await checkAsync('vm_passthrough pci-attach is gated and writes hostpciN with options', async () => {
  seen.length = 0;
  const first = await passTool.execute({ vmid: 104, action: 'pci-attach', slot: 3, id: '0000:02:00.0', pcie: true, xVga: true }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(seen.filter((entry) => entry.method === 'PUT').length, 0);
  const done = await passTool.execute({ vmid: 104, action: 'pci-attach', slot: 3, id: '0000:02:00.0', pcie: true, xVga: true, confirm: first.confirm }, {});
  assert.equal(done.key, 'hostpci3');
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path.endsWith('/qemu/104/config'));
  assert.deepEqual(JSON.parse(put.body), { hostpci3: '0000:02:00.0,pcie=1,x-vga=1' });
});

await checkAsync('vm_passthrough usb-attach maps vendor:product to host=', async () => {
  seen.length = 0;
  const first = await passTool.execute({ vmid: 104, action: 'usb-attach', slot: 1, device: '1234:5678' }, {});
  assert.equal(first.status, 'confirmation-required');
  const done = await passTool.execute({ vmid: 104, action: 'usb-attach', slot: 1, device: '1234:5678', confirm: first.confirm }, {});
  assert.equal(done.value, 'host=1234:5678');
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path.endsWith('/qemu/104/config'));
  assert.deepEqual(JSON.parse(put.body), { usb1: 'host=1234:5678' });
});

await checkAsync('vm_passthrough detach is gated and deletes the configured slot', async () => {
  seen.length = 0;
  const first = await passTool.execute({ vmid: 104, action: 'detach', kind: 'pci', slot: 2 }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.match(first.summary, /hostpci2/);
  const done = await passTool.execute({ vmid: 104, action: 'detach', kind: 'pci', slot: 2, confirm: first.confirm }, {});
  assert.equal(done.removed, '0000:01:00.0');
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path.endsWith('/qemu/104/config'));
  assert.deepEqual(JSON.parse(put.body), { delete: 'hostpci2' });
});

const extraLxc = lxcExtraTools(toolDeps);

await checkAsync('lxc_clone posts the new id and awaits the task', async () => {
  seen.length = 0;
  const out = await byName(extraLxc, 'lxc_clone').execute({ vmid: 300, newid: 301, hostname: 'ct301', full: true }, {});
  assert.equal(out.newid, 301);
  assert.equal(out.upid, UPID);
  const post = seen.find((entry) => entry.method === 'POST' && entry.path.endsWith('/lxc/300/clone'));
  assert.deepEqual(JSON.parse(post.body), { newid: 301, hostname: 'ct301', full: 1 });
  assert.ok(seen.some((entry) => entry.path.includes('/tasks/')));
});

await checkAsync('lxc_migrate is gated and posts the target', async () => {
  seen.length = 0;
  const tool = byName(extraLxc, 'lxc_migrate');
  const first = await tool.execute({ vmid: 300, target: 'pve-2' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(seen.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/migrate')).length, 0);
  const done = await tool.execute({ vmid: 300, target: 'pve-2', online: true, confirm: first.confirm }, {});
  assert.equal(done.target, 'pve-2');
  const post = seen.find((entry) => entry.method === 'POST' && entry.path.endsWith('/lxc/300/migrate'));
  assert.deepEqual(JSON.parse(post.body), { target: 'pve-2', online: 1 });
});

await checkAsync('lxc_resize puts the disk and size on the resize endpoint', async () => {
  seen.length = 0;
  const out = await byName(extraLxc, 'lxc_resize').execute({ vmid: 300, disk: 'mp0', size: '+8G' }, {});
  assert.equal(out.disk, 'mp0');
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path.endsWith('/lxc/300/resize'));
  assert.deepEqual(JSON.parse(put.body), { disk: 'mp0', size: '+8G' });
});

await checkAsync('lxc_move_volume is gated and carries delete + storage', async () => {
  seen.length = 0;
  const tool = byName(extraLxc, 'lxc_move_volume');
  const first = await tool.execute({ vmid: 300, volume: 'mp0', storage: 'local-lvm', deleteSource: true }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(first.risk, 'destroy');
  const done = await tool.execute({ vmid: 300, volume: 'mp0', storage: 'local-lvm', deleteSource: true, confirm: first.confirm }, {});
  assert.equal(done.deleted, true);
  const post = seen.find((entry) => entry.method === 'POST' && entry.path.endsWith('/lxc/300/move_volume'));
  assert.deepEqual(JSON.parse(post.body), { volume: 'mp0', storage: 'local-lvm', delete: 1 });
});

await checkAsync('lxc_template is gated and posts template', async () => {
  seen.length = 0;
  const tool = byName(extraLxc, 'lxc_template');
  const first = await tool.execute({ vmid: 300 }, {});
  assert.equal(first.status, 'confirmation-required');
  const done = await tool.execute({ vmid: 300, confirm: first.confirm }, {});
  assert.equal(done.template, true);
  assert.ok(seen.some((entry) => entry.method === 'POST' && entry.path.endsWith('/lxc/300/template')));
});

await checkAsync('lxc_feature and lxc_rrddata read their endpoints', async () => {
  seen.length = 0;
  const feat = await byName(extraLxc, 'lxc_feature').execute({ vmid: 300, feature: 'snapshot' }, {});
  assert.equal(feat.supported, true);
  const rrd = await byName(extraLxc, 'lxc_rrddata').execute({ vmid: 300, timeframe: 'hour' }, {});
  assert.equal(rrd.data.length, 1);
  assert.ok(seen.some((entry) => entry.path.endsWith('/lxc/300/feature')));
  assert.ok(seen.some((entry) => entry.path.endsWith('/lxc/300/rrddata')));
});

const clusterExtra = clusterExtraTools(toolDeps);
const nodeExtra = nodeExtraTools(toolDeps);
const accessExtra = accessExtraTools(toolDeps);
const firewallExtra = firewallExtraTools(toolDeps);
const monitorExtra = monitorExtraTools(toolDeps);

await checkAsync('cluster_ha lists resources/status and tolerates missing HA rules', async () => {
  const tool = byName(clusterExtra, 'cluster_ha');
  const list = await tool.execute({ action: 'list' }, {});
  assert.equal(list.resources[0].sid, 'vm:104');
  const status = await tool.execute({ action: 'status' }, {});
  assert.equal(status.status[0].id, 'quorum');
  const rules = await tool.execute({ action: 'rules' }, {});
  assert.equal(rules.available, false);
  assert.match(rules.note, /PVE 8/);
});

await checkAsync('cluster_ha create is gated and posts sid/state', async () => {
  const tool = byName(clusterExtra, 'cluster_ha');
  seen.length = 0;
  const first = await tool.execute({ action: 'create', sid: 'vm:105', state: 'started' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(seen.filter((entry) => entry.method === 'POST').length, 0);
  const done = await tool.execute({ action: 'create', sid: 'vm:105', state: 'started', confirm: first.confirm }, {});
  assert.equal(done.sid, 'vm:105');
  const post = seen.find((entry) => entry.method === 'POST' && entry.path === '/api2/json/cluster/ha/resources');
  assert.deepEqual(JSON.parse(post.body), { sid: 'vm:105', state: 'started' });
});

await checkAsync('cluster_ha group-create is gated and posts group/nodes', async () => {
  const tool = byName(clusterExtra, 'cluster_ha');
  seen.length = 0;
  const first = await tool.execute({ action: 'group-create', group: 'edge', nodes: 'pve-ci:1' }, {});
  assert.equal(first.status, 'confirmation-required');
  const done = await tool.execute({ action: 'group-create', group: 'edge', nodes: 'pve-ci:1', confirm: first.confirm }, {});
  assert.equal(done.group, 'edge');
  const post = seen.find((entry) => entry.method === 'POST' && entry.path === '/api2/json/cluster/ha/groups');
  assert.equal(JSON.parse(post.body).nodes, 'pve-ci:1');
});

await checkAsync('cluster_replication lists jobs, schedules one now, and gates create', async () => {
  const tool = byName(clusterExtra, 'cluster_replication');
  const list = await tool.execute({ action: 'list' }, {});
  assert.equal(list.jobs[0].id, '104-0');
  const now = await tool.execute({ action: 'schedule_now', id: '104-0' }, {});
  assert.equal(now.node, 'pve-ci');
  seen.length = 0;
  const first = await tool.execute({ action: 'create', id: '105-0', target: 'pve-2', schedule: '*/15' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(seen.filter((entry) => entry.method === 'POST').length, 0);
  const done = await tool.execute({ action: 'create', id: '105-0', target: 'pve-2', schedule: '*/15', confirm: first.confirm }, {});
  assert.equal(done.id, '105-0');
  const post = seen.find((entry) => entry.method === 'POST' && entry.path === '/api2/json/cluster/replication');
  assert.deepEqual(JSON.parse(post.body), { id: '105-0', target: 'pve-2', schedule: '*/15', type: 'local' });
});

await checkAsync('cluster_options reads and gates the PUT', async () => {
  const tool = byName(clusterExtra, 'cluster_options');
  const options = await tool.execute({ action: 'get' }, {});
  assert.equal(options.options.language, 'en');
  seen.length = 0;
  const first = await tool.execute({ action: 'set', changes: ['language=en'] }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(seen.filter((entry) => entry.method === 'PUT').length, 0);
  await tool.execute({ action: 'set', changes: ['language=en'], confirm: first.confirm }, {});
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path === '/api2/json/cluster/options');
  assert.deepEqual(JSON.parse(put.body), { language: 'en' });
});

await checkAsync('cluster_metrics lists servers, gates create and tolerates the legacy endpoint', async () => {
  const tool = byName(clusterExtra, 'cluster_metrics');
  const list = await tool.execute({ action: 'list' }, {});
  assert.equal(list.servers[0].id, 'influx');
  const legacy = await tool.execute({ action: 'influxdb' }, {});
  assert.equal(legacy.available, false);
  seen.length = 0;
  const first = await tool.execute({ action: 'create', id: 'influx2', type: 'influxdb', server: 'metrics.lab', port: 8089 }, {});
  assert.equal(first.status, 'confirmation-required');
  const done = await tool.execute({ action: 'create', id: 'influx2', type: 'influxdb', server: 'metrics.lab', port: 8089, confirm: first.confirm }, {});
  assert.equal(done.id, 'influx2');
  const post = seen.find((entry) => entry.method === 'POST' && entry.path === '/api2/json/cluster/metrics/server');
  assert.equal(JSON.parse(post.body).port, 8089);
});

await checkAsync('cluster_tasks filters client-side and sorts newest first', async () => {
  const tool = byName(clusterExtra, 'cluster_tasks');
  const out = await tool.execute({ type: 'qmstart' }, {});
  assert.equal(out.total, 1);
  assert.equal(out.tasks[0].type, 'qmstart');
  const all = await tool.execute({}, {});
  assert.equal(all.tasks[0].type, 'qmstart');
});

await checkAsync('node_dns reads and gates the set', async () => {
  const tool = byName(nodeExtra, 'node_dns');
  const dns = await tool.execute({ action: 'get' }, {});
  assert.equal(dns.dns.search, 'lab');
  seen.length = 0;
  const first = await tool.execute({ action: 'set', search: 'lab', dns1: '1.1.1.1' }, {});
  assert.equal(first.status, 'confirmation-required');
  await tool.execute({ action: 'set', search: 'lab', dns1: '1.1.1.1', confirm: first.confirm }, {});
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path.endsWith('/nodes/pve-ci/dns'));
  assert.deepEqual(JSON.parse(put.body), { search: 'lab', dns1: '1.1.1.1' });
});

await checkAsync('node_time reads and gates the timezone change', async () => {
  const tool = byName(nodeExtra, 'node_time');
  const time = await tool.execute({ action: 'get' }, {});
  assert.equal(time.time.timezone, 'UTC');
  const first = await tool.execute({ action: 'set', timezone: 'Asia/Shanghai' }, {});
  assert.equal(first.status, 'confirmation-required');
  await tool.execute({ action: 'set', timezone: 'Asia/Shanghai', confirm: first.confirm }, {});
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path.endsWith('/nodes/pve-ci/time'));
  assert.deepEqual(JSON.parse(put.body), { timezone: 'Asia/Shanghai' });
});

await checkAsync('node_disks lists, reads SMART for /dev/sda and lists ZFS pools', async () => {
  const tool = byName(nodeExtra, 'node_disks');
  const list = await tool.execute({ action: 'list' }, {});
  assert.equal(list.disks[0].devpath, '/dev/sda');
  seen.length = 0;
  const smart = await tool.execute({ action: 'smart', disk: 'sda' }, {});
  assert.equal(smart.disk, '/dev/sda');
  assert.equal(smart.smart.health, 'PASSED');
  const call = seen.find((entry) => entry.path.endsWith('/disks/smart'));
  assert.match(call.query, /disk=%2Fdev%2Fsda/);
  const zfs = await tool.execute({ action: 'zfs' }, {});
  assert.equal(zfs.entries[0].name, 'tank');
});

await checkAsync('node_apt_repos reads and gates add-standard', async () => {
  const tool = byName(nodeExtra, 'node_apt_repos');
  const repos = await tool.execute({ action: 'get' }, {});
  assert.equal(repos.repositories.files[0].path, '/etc/apt/sources.list');
  const first = await tool.execute({ action: 'add-standard', handle: 'no-subscription' }, {});
  assert.equal(first.status, 'confirmation-required');
  await tool.execute({ action: 'add-standard', handle: 'no-subscription', confirm: first.confirm }, {});
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path.endsWith('/apt/repositories'));
  assert.deepEqual(JSON.parse(put.body), { handle: 'no-subscription' });
});

await checkAsync('node_hosts writes the file and degrades replace/delete on 7.4', async () => {
  const tool = byName(nodeExtra, 'node_hosts');
  const current = await tool.execute({ action: 'get' }, {});
  assert.match(current.hosts.data, /pve-ci/);
  const first = await tool.execute({ action: 'write', data: '127.0.0.1 localhost\n' }, {});
  assert.equal(first.status, 'confirmation-required');
  await tool.execute({ action: 'write', data: '127.0.0.1 localhost\n', confirm: first.confirm }, {});
  const post = seen.find((entry) => entry.method === 'POST' && entry.path.endsWith('/hosts'));
  assert.equal(JSON.parse(post.body).data, '127.0.0.1 localhost\n');
  const replaceFirst = await tool.execute({ action: 'replace', data: '127.0.0.1 localhost\n' }, {});
  const replaced = await tool.execute({ action: 'replace', data: '127.0.0.1 localhost\n', confirm: replaceFirst.confirm }, {});
  assert.equal(replaced.available, false);
});

await checkAsync('node_wakeonlan posts to the node endpoint', async () => {
  const tool = byName(nodeExtra, 'node_wakeonlan');
  seen.length = 0;
  const out = await tool.execute({ mac: 'aa:bb:cc:dd:ee:ff' }, {});
  assert.equal(out.node, 'pve-ci');
  assert.ok(seen.some((entry) => entry.method === 'POST' && entry.path.endsWith('/wakeonlan')));
});

await checkAsync('node_execute gates the batch and posts commands as a JSON string', async () => {
  const tool = byName(nodeExtra, 'node_execute');
  seen.length = 0;
  const first = await tool.execute({ mode: 'api', commands: [{ path: '/version', method: 'GET' }] }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(seen.filter((entry) => entry.method === 'POST').length, 0);
  const out = await tool.execute({ mode: 'api', commands: [{ path: '/version', method: 'GET' }], confirm: first.confirm }, {});
  assert.equal(out.results[0].status, 200);
  const post = seen.find((entry) => entry.method === 'POST' && entry.path.endsWith('/execute'));
  assert.deepEqual(JSON.parse(JSON.parse(post.body).commands), [{ path: '/version', method: 'GET' }]);
});

await checkAsync('node_execute shell mode is destroy-gated and sends nothing before the token', async () => {
  const tool = byName(nodeExtra, 'node_execute');
  seen.length = 0;
  const first = await tool.execute({ mode: 'shell', script: 'echo hi' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(seen.filter((entry) => entry.method !== 'GET').length, 0);
});

await checkAsync('node_rrddata asks for the time frame', async () => {
  const tool = byName(nodeExtra, 'node_rrddata');
  seen.length = 0;
  const out = await tool.execute({ timeframe: 'day' }, {});
  assert.equal(out.data.length, 1);
  const call = seen.find((entry) => entry.path.endsWith('/rrddata'));
  assert.match(call.query, /timeframe=day/);
});

await checkAsync('node_diagnostics falls back to /report on 7.4', async () => {
  const tool = byName(nodeExtra, 'node_diagnostics');
  seen.length = 0;
  const out = await tool.execute({}, {});
  assert.equal(out.source, 'report');
  assert.match(out.report, /PVE REPORT/);
  assert.ok(seen.some((entry) => entry.path.endsWith('/diagnostics')));
  assert.ok(seen.some((entry) => entry.path.endsWith('/report')));
});

await checkAsync('pve_domain lists, gates create and maps sync options to hyphen names', async () => {
  const tool = byName(accessExtra, 'pve_domain');
  const list = await tool.execute({ action: 'list' }, {});
  assert.equal(list.domains[0].realm, 'pam');
  const first = await tool.execute({ action: 'create', realm: 'ad', type: 'ad', options: ['server1=ldap.lab'] }, {});
  assert.equal(first.status, 'confirmation-required');
  await tool.execute({ action: 'create', realm: 'ad', type: 'ad', options: ['server1=ldap.lab'], confirm: first.confirm }, {});
  const post = seen.find((entry) => entry.method === 'POST' && entry.path === '/api2/json/access/domains');
  assert.equal(JSON.parse(post.body).realm, 'ad');
  const syncFirst = await tool.execute({ action: 'sync', realm: 'pam', dry_run: true, scope: 'users' }, {});
  assert.equal(syncFirst.status, 'confirmation-required');
  await tool.execute({ action: 'sync', realm: 'pam', dry_run: true, scope: 'users', confirm: syncFirst.confirm }, {});
  const sync = seen.find((entry) => entry.method === 'POST' && entry.path.endsWith('/access/domains/pam/sync'));
  assert.deepEqual(JSON.parse(sync.body), { scope: 'users', 'dry-run': 1 });
});

await checkAsync('pve_tfa lists entries and gates deletion at /access/tfa', async () => {
  const tool = byName(accessExtra, 'pve_tfa');
  const list = await tool.execute({ action: 'list', userid: 'root@pam' }, {});
  assert.equal(list.entries[0].id, 'totp-1');
  seen.length = 0;
  const first = await tool.execute({ action: 'delete', userid: 'root@pam', id: 'totp-1' }, {});
  assert.equal(first.status, 'confirmation-required');
  await tool.execute({ action: 'delete', userid: 'root@pam', id: 'totp-1', confirm: first.confirm }, {});
  assert.ok(seen.some((entry) => entry.method === 'DELETE' && entry.path === `/api2/json/access/tfa/${encodeURIComponent('root@pam')}/totp-1`));
});

await checkAsync('pve_permissions reads the map and falls back for the per-user view', async () => {
  const tool = byName(accessExtra, 'pve_permissions');
  const list = await tool.execute({ action: 'list' }, {});
  assert.ok(list.permissions['/']);
  const user = await tool.execute({ action: 'user', userid: 'root@pam' }, {});
  assert.ok(user.permissions['/']);
  assert.match(user.note, /does not exist/);
});

await checkAsync('pve_password gates the change and never echoes the password', async () => {
  const tool = byName(accessExtra, 'pve_password');
  seen.length = 0;
  const first = await tool.execute({ userid: 'root@pam', password: 'new-secret-123' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(seen.length, 0);
  const out = await tool.execute({ userid: 'root@pam', password: 'new-secret-123', confirm: first.confirm }, {});
  assert.equal(out.changed, true);
  assert.equal(JSON.stringify(out).includes('new-secret-123'), false);
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path === '/api2/json/access/password');
  assert.equal(JSON.parse(put.body).password, 'new-secret-123');
});

await checkAsync('pve_token_rotate gates rotation, sends regenerate=1 and returns the new secret', async () => {
  const tool = byName(accessExtra, 'pve_token_rotate');
  seen.length = 0;
  const first = await tool.execute({ userid: 'root@pam', tokenid: 'dsh-rotate' }, {});
  assert.equal(first.status, 'confirmation-required');
  const out = await tool.execute({ userid: 'root@pam', tokenid: 'dsh-rotate', confirm: first.confirm }, {});
  assert.equal(out.secret, 'new-secret-value');
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path.endsWith('/token/dsh-rotate'));
  assert.equal(JSON.parse(put.body).regenerate, 1);
});

await checkAsync('pve_security_group lists, gates create and gates rule-add', async () => {
  const tool = byName(firewallExtra, 'pve_security_group');
  const list = await tool.execute({ action: 'list' }, {});
  assert.equal(list.groups[0].group, 'web');
  seen.length = 0;
  const first = await tool.execute({ action: 'create', group: 'web2' }, {});
  assert.equal(first.status, 'confirmation-required');
  await tool.execute({ action: 'create', group: 'web2', confirm: first.confirm }, {});
  assert.ok(seen.some((entry) => entry.method === 'POST' && entry.path === '/api2/json/cluster/firewall/groups'));
  const ruleFirst = await tool.execute({ action: 'rule-add', group: 'web', rule_action: 'ACCEPT', rule_type: 'in', proto: 'tcp', dport: '22' }, {});
  assert.equal(ruleFirst.status, 'confirmation-required');
  await tool.execute({ action: 'rule-add', group: 'web', rule_action: 'ACCEPT', rule_type: 'in', proto: 'tcp', dport: '22', confirm: ruleFirst.confirm }, {});
  const rule = seen.find((entry) => entry.method === 'POST' && entry.path === '/api2/json/cluster/firewall/groups/web');
  assert.equal(JSON.parse(rule.body).action, 'ACCEPT');
  assert.equal(JSON.parse(rule.body).type, 'in');
});

await checkAsync('pve_ipset lists, gates create and gates entry-add', async () => {
  const tool = byName(firewallExtra, 'pve_ipset');
  const list = await tool.execute({ action: 'list' }, {});
  assert.equal(list.sets[0].name, 'blocked');
  const first = await tool.execute({ action: 'create', name: 'blocked2' }, {});
  assert.equal(first.status, 'confirmation-required');
  await tool.execute({ action: 'create', name: 'blocked2', confirm: first.confirm }, {});
  const entryFirst = await tool.execute({ action: 'entry-add', name: 'blocked', cidr: '10.1.0.0/16' }, {});
  assert.equal(entryFirst.status, 'confirmation-required');
  await tool.execute({ action: 'entry-add', name: 'blocked', cidr: '10.1.0.0/16', confirm: entryFirst.confirm }, {});
  const entry = seen.find((entry) => entry.method === 'POST' && entry.path === '/api2/json/cluster/firewall/ipset/blocked');
  assert.equal(JSON.parse(entry.body).cidr, '10.1.0.0/16');
});

await checkAsync('pve_alias lists and gates create', async () => {
  const tool = byName(firewallExtra, 'pve_alias');
  const list = await tool.execute({ action: 'list' }, {});
  assert.equal(list.aliases[0].name, 'dns');
  const first = await tool.execute({ action: 'create', name: 'dns2', cidr: '9.9.9.9' }, {});
  assert.equal(first.status, 'confirmation-required');
  await tool.execute({ action: 'create', name: 'dns2', cidr: '9.9.9.9', confirm: first.confirm }, {});
  const post = seen.find((entry) => entry.method === 'POST' && entry.path === '/api2/json/cluster/firewall/aliases');
  assert.deepEqual(JSON.parse(post.body), { name: 'dns2', cidr: '9.9.9.9' });
});

await checkAsync('pve_firewall_extra reads options/log/refs and gates options-set', async () => {
  const tool = byName(firewallExtra, 'pve_firewall_extra');
  const options = await tool.execute({ action: 'options' }, {});
  assert.equal(options.options.policy_in, 'DROP');
  const log = await tool.execute({ action: 'log' }, {});
  assert.equal(log.log.length, 1);
  const refs = await tool.execute({ action: 'refs' }, {});
  assert.ok(refs.refs.alias);
  seen.length = 0;
  const first = await tool.execute({ action: 'options-set', changes: ['enable=1'] }, {});
  assert.equal(first.status, 'confirmation-required');
  await tool.execute({ action: 'options-set', changes: ['enable=1'], confirm: first.confirm }, {});
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path === '/api2/json/cluster/firewall/options');
  assert.deepEqual(JSON.parse(put.body), { enable: '1' });
});

await checkAsync('pve_certificate reads info and gates upload', async () => {
  const tool = byName(monitorExtra, 'pve_certificate');
  const info = await tool.execute({ action: 'info' }, {});
  assert.equal(info.certificates[0].filename, 'pveproxy-ssl.pem');
  const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
  seen.length = 0;
  const first = await tool.execute({ action: 'upload', certificates: pem }, {});
  assert.equal(first.status, 'confirmation-required');
  await tool.execute({ action: 'upload', certificates: pem, confirm: first.confirm }, {});
  const post = seen.find((entry) => entry.method === 'POST' && entry.path.endsWith('/certificates/custom'));
  assert.equal(JSON.parse(post.body).certificates, pem);
});

await checkAsync('pve_subscription reads, gates set and gates delete', async () => {
  const tool = byName(monitorExtra, 'pve_subscription');
  const sub = await tool.execute({ action: 'get' }, {});
  assert.equal(sub.subscription.status, 'Active');
  const first = await tool.execute({ action: 'set', key: 'pve8c-0123456789' }, {});
  assert.equal(first.status, 'confirmation-required');
  await tool.execute({ action: 'set', key: 'pve8c-0123456789', confirm: first.confirm }, {});
  const put = seen.find((entry) => entry.method === 'PUT' && entry.path.endsWith('/subscription'));
  assert.deepEqual(JSON.parse(put.body), { key: 'pve8c-0123456789' });
  const deleteFirst = await tool.execute({ action: 'delete' }, {});
  assert.equal(deleteFirst.status, 'confirmation-required');
  await tool.execute({ action: 'delete', confirm: deleteFirst.confirm }, {});
  assert.ok(seen.some((entry) => entry.method === 'DELETE' && entry.path.endsWith('/subscription')));
});

await checkAsync('pve_notifications reports the API as unavailable on 7.4 instead of failing', async () => {
  const tool = byName(monitorExtra, 'pve_notifications');
  const out = await tool.execute({}, {});
  assert.equal(out.available, false);
  assert.match(out.note, /not available on this PVE version/);
});

controller.closeAll();
server.close();

console.log(JSON.stringify({ problems }));
process.exitCode = problems.length === 0 ? 0 : 1;
