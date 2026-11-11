/**
 * Checks the commit-confirm path without a Proxmox node.
 *
 * What is pinned here is the promise the tools make: nothing happens before the
 * token comes back, a rollback timer is armed before a lockout-prone change, the
 * apply step runs detached, a reachable node cancels the timer, an unreachable
 * one leaves it armed, and firewall writes warn when no ACCEPT rule covers
 * tcp/8006. A real node is only needed for the last mile.
 */
import assert from 'node:assert/strict';
import { ConfirmationStore } from '../lib/confirm.js';
import { armRollback, cancelRollback, probeApi } from '../lib/netguard.js';
import { networkTools } from './network.js';
import { firewallTools } from './firewall.js';

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

const settings = {
  api: { url: 'https://192.168.2.220:8006', token: 'root@pam!dsh=0123456789abcdef0123456789abcdef0123' },
  allowVmids: [100, 104],
};

/** A controller whose answers are scripted; every call is recorded. */
function makeController({ reachable = true, rules = [] , network = undefined } = {}) {
  const calls = { shell: [], get: [], api: [] };
  let probes = 0;
  const controller = {
    shell: async (script) => {
      calls.shell.push(String(script));
      const text = String(script);
      if (text.includes('interfaces.new') && text.includes('cat ')) {
        return { exitCode: 0, stdout: 'present\niface vmbr0\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    pveshGet: async (path, params = {}) => {
      calls.get.push({ path, params });
      if (path === '/version') {
        probes += 1;
        if (!reachable) throw new Error('connect ECONNREFUSED 192.168.2.220:8006');
        return { version: '7.4-3', release: '7.4' };
      }
      if (path.endsWith('/network')) {
        return network ?? [
          { iface: 'vmbr0', type: 'bridge', address: '192.168.2.220', gateway: '192.168.2.1', bridge_ports: 'enp5s0' },
          { iface: 'enp5s0', type: 'eth' },
        ];
      }
      if (path.endsWith('/firewall/rules')) return rules;
      if (path.endsWith('/firewall/options')) return {};
      return {};
    },
    pvesh: async (method, path, options = {}) => {
      calls.api.push({ method, path, params: options.params ?? {} });
      return { exitCode: 0, stdout: '', json: {} };
    },
    nodeName: async () => 'pve-ci',
    nodeFor: async () => 'pve-ci',
    stdout: () => ({ probes }),
  };
  return { controller, calls };
}

function makeDeps(controller, overrides = settings) {
  return {
    pool: { target: () => ({ name: 'x99i', controller, settings: overrides }) },
    settings: () => overrides,
    confirms: new ConfirmationStore(),
  };
}
const byName = (list, name) => {
  const found = list.find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`tool ${name} is not registered`);
  return found;
};

await checkAsync('pve_firewall status answers lossless JSON (no undefined members)', async () => {
  const { controller } = makeController();
  const tool = byName(firewallTools(makeDeps(controller)), 'pve_firewall');
  const out = await tool.execute({ scope: 'cluster', action: 'status' }, {});
  assert.equal('guest' in out, false);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

await checkAsync('the new tools render their answers as text, not [object Object]', async () => {
  const { controller } = makeController();
  for (const tool of [byName(networkTools(makeDeps(controller)), 'node_network'), byName(firewallTools(makeDeps(controller)), 'pve_firewall')]) {
    const blocks = tool.output.render({ action: 'list' }, { action: 'list', node: 'pve-ci' });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
    assert.match(blocks[0].text, /"node": "pve-ci"/);
    assert.ok(!blocks[0].text.includes('[object Object]'), `${tool.name} rendered an object as [object Object]`);
  }
});

await checkAsync('node_network list reports interfaces, the pending file and the management interface', async () => {
  const { controller } = makeController();
  const tool = byName(networkTools(makeDeps(controller)), 'node_network');
  const out = await tool.execute({ action: 'list' }, {});
  assert.equal(out.instance, 'x99i');
  assert.equal(out.node, 'pve-ci');
  assert.equal(out.interfaces.length, 2);
  assert.equal(out.management, 'vmbr0');
  assert.equal(out.pending.present, true);
});

await checkAsync('node_network create writes the pending configuration', async () => {
  const { controller, calls } = makeController();
  const tool = byName(networkTools(makeDeps(controller)), 'node_network');
  const out = await tool.execute({ action: 'create', iface: 'vmbr1', type: 'bridge', bridge_ports: 'enp6s0', address: '192.168.2.30/24' }, {});
  assert.equal(out.written, true);
  assert.match(out.note, /pending configuration/);
  const call = calls.api.find((entry) => entry.path === '/nodes/pve-ci/network');
  assert.equal(call.method, 'create');
  assert.equal(call.params.iface, 'vmbr1');
  assert.equal(call.params.bridge_ports, 'enp6s0');
});

await checkAsync('node_network delete changes nothing before the token comes back', async () => {
  const { controller, calls } = makeController();
  const tool = byName(networkTools(makeDeps(controller)), 'node_network');
  const first = await tool.execute({ action: 'delete', iface: 'vmbr1' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(first.performed, false);
  assert.equal(calls.api.filter((entry) => entry.method === 'delete').length, 0);
  const done = await tool.execute({ action: 'delete', iface: 'vmbr1', confirm: first.confirm }, {});
  assert.equal(done.removed, true);
  assert.equal(calls.api.filter((entry) => entry.method === 'delete').length, 1);
});

await checkAsync('node_network apply is gated and arms the rollback before reloading', async () => {
  const { controller, calls } = makeController();
  const tool = byName(networkTools(makeDeps(controller)), 'node_network');
  const first = await tool.execute({ action: 'apply' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(first.risk, 'destroy');
  assert.match(first.summary, /rollback timer/);
  assert.equal(calls.shell.filter((script) => script.includes('systemd-run')).length, 0);

  const done = await tool.execute({ action: 'apply', confirm: first.confirm }, {});
  assert.equal(done.applied, true);
  assert.equal(done.reachable, true);
  assert.equal(done.rollback.cancelled, true);
  const arm = calls.shell.find((script) => script.includes('--on-active=180s'));
  assert.ok(arm, 'expected an armed rollback timer');
  assert.match(arm, /_etc_network_interfaces/);
  assert.match(arm, /ifreload -a/);
  const apply = calls.shell.find((script) => script.includes('pvesh set /nodes/pve-ci/network'));
  assert.ok(apply, 'expected the apply step to run detached');
  const cancel = calls.shell.find((script) => script.includes('systemctl stop'));
  assert.ok(cancel, 'expected the timer to be cancelled after a reachable probe');
});

await checkAsync('node_network apply leaves the timer armed when the node stops answering', async () => {
  const { controller, calls } = makeController({ reachable: false });
  const tool = byName(networkTools(makeDeps(controller)), 'node_network');
  const first = await tool.execute({ action: 'apply' }, {});
  const done = await tool.execute({ action: 'apply', confirm: first.confirm }, {});
  assert.equal(done.reachable, false);
  assert.equal(done.rollback.cancelled, false);
  assert.match(done.warning, /rollback timer dsh-rollback-/);
  assert.equal(calls.shell.filter((script) => script.includes('systemctl stop')).length, 0);
});

await checkAsync('node_network apply refuses without the API transport', async () => {
  const { controller } = makeController();
  const tool = byName(networkTools(makeDeps(controller, { allowVmids: [] })), 'node_network');
  await assert.rejects(
    () => tool.execute({ action: 'apply' }, {}),
    /needs the API transport .* ssh channel/,
  );
});

await checkAsync('pve_firewall status exposes the missing management ACCEPT rules', async () => {
  const { controller } = makeController();
  const tool = byName(firewallTools(makeDeps(controller)), 'pve_firewall');
  const out = await tool.execute({ scope: 'cluster', action: 'status' }, {});
  assert.deepEqual(out.missingManagementAccept, ['8006', '22']);
  assert.deepEqual(out.rules, []);
});

await checkAsync('pve_firewall enable warns about tcp/8006 and only runs after the token', async () => {
  const { controller, calls } = makeController();
  const tool = byName(firewallTools(makeDeps(controller)), 'pve_firewall');
  const first = await tool.execute({ scope: 'cluster', action: 'enable' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.match(first.summary, /8006/);
  assert.equal(calls.api.length, 0);

  const done = await tool.execute({ scope: 'cluster', action: 'enable', confirm: first.confirm }, {});
  assert.equal(done.written, true);
  assert.equal(done.rollback.cancelled, true);
  const set = calls.api.find((entry) => entry.path === '/cluster/firewall/options');
  assert.equal(set.method, 'set');
  assert.equal(set.params.enable, 1);
  assert.ok(calls.shell.some((script) => script.includes('pve-firewall restart')));
});

await checkAsync('pve_firewall rule-add drops nothing before confirmation and names the risk', async () => {
  const { controller, calls } = makeController();
  const tool = byName(firewallTools(makeDeps(controller)), 'pve_firewall');
  const first = await tool.execute({ scope: 'node', action: 'rule-add', rule_type: 'in', rule_action: 'DROP', proto: 'tcp', dport: '8006' }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.match(first.summary, /management port/);
  assert.equal(calls.api.length, 0);
  const done = await tool.execute({ scope: 'node', action: 'rule-add', rule_type: 'in', rule_action: 'DROP', proto: 'tcp', dport: '8006', confirm: first.confirm }, {});
  assert.equal(done.written, true);
  const add = calls.api.find((entry) => entry.path === '/nodes/pve-ci/firewall/rules' && entry.method === 'create');
  assert.equal(add.params.action, 'DROP');
  assert.equal(add.params.dport, '8006');
});

await checkAsync('pve_firewall rule-delete is destroy-risky and shows the rule it removes', async () => {
  const { controller, calls } = makeController({ rules: [{ pos: 1, type: 'in', action: 'ACCEPT', dport: '8006' }] });
  const tool = byName(firewallTools(makeDeps(controller)), 'pve_firewall');
  const first = await tool.execute({ scope: 'cluster', action: 'rule-delete', pos: 1 }, {});
  assert.equal(first.status, 'confirmation-required');
  assert.equal(first.risk, 'destroy');
  assert.match(first.summary, /ACCEPT/);
  assert.equal(calls.api.length, 0);
  const done = await tool.execute({ scope: 'cluster', action: 'rule-delete', pos: 1, confirm: first.confirm }, {});
  assert.equal(done.written, true);
  assert.ok(calls.api.some((entry) => entry.method === 'delete' && entry.path === '/cluster/firewall/rules/1'));
});

await checkAsync('armRollback validates names, paths and the delay', async () => {
  const { controller } = makeController();
  await assert.rejects(() => armRollback(controller, { id: 'nope', files: ['/etc/network/interfaces'], restoreCommand: 'true' }), /invalid rollback unit/);
  await assert.rejects(
    () => armRollback(controller, { id: 'dsh-rollback-0123456789', files: ['/etc/passwd; rm -rf /'], restoreCommand: 'true' }),
    /invalid configuration path/,
  );
  await assert.rejects(
    () => armRollback(controller, { id: 'dsh-rollback-0123456789', files: ['/etc/network/interfaces'], restoreCommand: 'true', seconds: 5 }),
    /between 30 and 900/,
  );
});

await checkAsync('cancelRollback stops timer and service and removes the copies', async () => {
  const { controller, calls } = makeController();
  const out = await cancelRollback(controller, 'dsh-rollback-0123456789');
  assert.equal(out.cancelled, true);
  const script = calls.shell.at(-1);
  assert.match(script, /systemctl stop 'dsh-rollback-0123456789\.timer'/);
  assert.match(script, /rm -rf '\/var\/lib\/dsh-pve-vm\/rollback\/dsh-rollback-0123456789'/);
});

await checkAsync('probeApi retries and reports an unreachable node', async () => {
  const { controller } = makeController({ reachable: false });
  const out = await probeApi(controller, { attempts: 2, delayMs: 1 });
  assert.equal(out.reachable, false);
  assert.equal(out.attempts, 2);
});

if (problems.length > 0) {
  console.log(JSON.stringify({ problems }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ problems: [] }));
