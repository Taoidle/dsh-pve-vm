/**
 * Node network configuration.
 *
 * Reading is free. Writing an interface only writes the *pending* configuration
 * (`/etc/network/interfaces.new` on PVE); nothing is active until `apply`, which
 * is the step that can cut the API and ssh session used to run it. That is why
 * `apply` is the one action protected by commit-confirm: a rollback timer is
 * armed first and cancelled only when the node answers again.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';
import { armRollback, canCommitConfirm, cancelRollback, probeApi, rollbackId, runDetached } from '../lib/netguard.js';

/** Interface types the PVE API accepts. */
const IFACE_TYPES = ['eth', 'bridge', 'bond', 'vlan', 'alias', 'unknown', 'OVSBridge', 'OVSBond', 'OVSPort', 'OVSIntPort'];

/** A Linux interface name: 15 characters, no spaces. */
const IFACE_NAME = /^[A-Za-z0-9_.:-]{1,15}$/;

/** A PVE node name, as used in `/nodes/<name>/…` paths. */
const NODE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62})$/;

/** Interface properties a write may carry. */
const EDITABLE = [
  'type',
  'address',
  'cidr',
  'netmask',
  'gateway',
  'address6',
  'cidr6',
  'gateway6',
  'bridge_ports',
  'bridge_stp',
  'bridge_fd',
  'bridge_vlan_aware',
  'bond_mode',
  'bond_xmit_hash_policy',
  'slaves',
  'mtu',
  'vlan_id',
  'vlan_raw_device',
  'autostart',
  'comments',
];

/** The files `apply` protects. */
const NETWORK_FILES = ['/etc/network/interfaces', '/etc/network/interfaces.new'];

/** The reload command the rollback runs. */
const RELOAD = 'ifreload -a';

/** Collect the interface properties the caller passed. */
function interfaceFields(args) {
  const body = {};
  for (const key of EDITABLE) {
    const value = args?.[key];
    if (value === undefined || value === null || value === '') continue;
    body[key] = value;
  }
  return body;
}

/** Validate an interface name. */
function assertIface(name) {
  const text = String(name ?? '').trim();
  if (!IFACE_NAME.test(text)) {
    throw new VmError(`"${name}" is not an interface name (letters, digits, "_", ".", ":" and "-", at most 15)`, 'BAD_ARGUMENT');
  }
  return text;
}

/** Validate a node name. */
function assertNode(name) {
  const text = String(name ?? '').trim();
  if (!NODE_NAME.test(text)) throw new VmError(`"${name}" is not a node name`, 'BAD_ARGUMENT');
  return text;
}

/** The address part of a URL, without brackets or port. */
function hostOf(url) {
  try {
    const parsed = new URL(String(url ?? ''));
    return parsed.hostname;
  } catch {
    return '';
  }
}

/** Read the pending configuration over ssh, tolerating a missing ssh channel. */
async function readPending(controller, signal) {
  try {
    const result = await controller.shell(
      `if [ -e /etc/network/interfaces.new ]; then echo present; cat /etc/network/interfaces.new; else echo absent; fi`,
      { timeoutMs: 20_000, signal },
    );
    if (result.exitCode !== 0) return { available: false, reason: result.stderr || result.stdout || 'ssh failed' };
    const text = result.stdout;
    const present = text.startsWith('present');
    return { available: true, present, text: present ? text.slice('present\n'.length) : '' };
  } catch (error) {
    return { available: false, reason: error?.message ?? String(error) };
  }
}

/** Identify the interface that carries the management traffic. */
function managementIface(interfaces, settings) {
  const host = hostOf(settings?.api?.url);
  const list = Array.isArray(interfaces) ? interfaces : [];
  if (host !== '') {
    const byAddress = list.find((entry) => {
      const value = String(entry?.address ?? '');
      const cidr = String(entry?.cidr ?? '');
      return value === host || cidr.startsWith(`${host}/`);
    });
    if (byAddress) return byAddress.iface;
  }
  const byGateway = list.find((entry) => String(entry?.gateway ?? '').length > 0);
  return byGateway ? byGateway.iface : null;
}

/**
 * Build the network tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 * @returns {Array<object>} compiled tool definitions.
 */
export function networkTools(deps) {
  return [
    {
      name: 'node_network',
      description:
        'Node network configuration: list the interfaces and the pending configuration, create/update/delete an interface (written to the pending configuration only), and apply the pending configuration. `apply` reloads the interfaces — if the management address changes, the API and ssh session drop — so it arms a rollback timer that restores /etc/network/interfaces{,.new} and runs `ifreload -a` after the timeout unless the API answers again and the timer is cancelled.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'create', 'update', 'delete', 'apply'],
          description: 'What to read or change.',
        },
        iface: { type: 'string', description: 'Interface name, for example vmbr0 (create, update, delete).' },
        type: { type: 'string', enum: IFACE_TYPES, description: 'Interface type (create).' },
        address: { type: 'string', description: 'IPv4 address.' },
        cidr: { type: 'string', description: 'IPv4 address with prefix, for example 192.168.2.10/24.' },
        netmask: { type: 'string', description: 'IPv4 netmask.' },
        gateway: { type: 'string', description: 'IPv4 default gateway.' },
        address6: { type: 'string', description: 'IPv6 address.' },
        cidr6: { type: 'string', description: 'IPv6 address with prefix.' },
        gateway6: { type: 'string', description: 'IPv6 default gateway.' },
        bridge_ports: { type: 'string', description: 'Bridge member interfaces, for example enp5s0.' },
        bridge_stp: { type: 'string', description: 'Spanning tree: on, off or no.' },
        bridge_fd: { type: 'string', description: 'Bridge forward delay, for example 0.' },
        bond_mode: { type: 'string', description: 'Bond mode, for example 802.3ad.' },
        slaves: { type: 'string', description: 'Bond member interfaces, comma separated.' },
        mtu: { type: 'number', description: 'MTU.' },
        vlan_id: { type: 'number', description: 'VLAN id.' },
        vlan_raw_device: { type: 'string', description: 'VLAN parent interface.' },
        autostart: { type: 'boolean', description: 'Bring the interface up at boot.' },
        comments: { type: 'string', description: 'Comment.' },
        timeout_sec: { type: 'number', description: 'Rollback delay for apply, 30–900 seconds (default 180).' },
        confirm: { type: 'string', description: 'The token from the first call, for delete and apply.' },
      },
      output: { schema: PLAIN_SCHEMA, render: textOutput },
      async execute(args, exec) {
        const { controller, settings, name } = instanceOf(deps, args);
        const signal = exec?.signal;
        const action = String(args.action ?? '');
        const node = assertNode(await controller.nodeName());

        if (action === 'list') {
          const interfaces = await controller.pveshGet(`/nodes/${node}/network`, {}, { signal });
          return {
            instance: name,
            node,
            interfaces: Array.isArray(interfaces) ? interfaces : [],
            pending: await readPending(controller, signal),
            management: managementIface(interfaces, settings),
          };
        }

        if (action === 'create') {
          const iface = assertIface(args.iface);
          const body = interfaceFields(args);
          if (body.type === undefined) throw new VmError('create needs a type (bridge, eth, bond, vlan …)', 'BAD_ARGUMENT');
          await controller.pvesh('create', `/nodes/${node}/network`, { params: { iface, ...body }, signal });
          return {
            instance: name,
            node,
            iface,
            written: true,
            note: 'written to the pending configuration — call node_network with action "apply" to make it active',
          };
        }

        if (action === 'update') {
          const iface = assertIface(args.iface);
          const body = interfaceFields(args);
          if (Object.keys(body).length === 0) {
            throw new VmError('update needs at least one property to change', 'BAD_ARGUMENT');
          }
          await controller.pvesh('set', `/nodes/${node}/network/${iface}`, { params: body, signal });
          return {
            instance: name,
            node,
            iface,
            written: true,
            note: 'written to the pending configuration — call node_network with action "apply" to make it active',
          };
        }

        if (action === 'delete') {
          const iface = assertIface(args.iface);
          const summary =
            `Remove interface ${iface} from the pending network configuration on ${node}. ` +
            'Nothing changes until apply; if that interface carries the management address, applying afterwards will cut the API and ssh session.';
          return await runGuarded(
            deps.confirms,
            { args, instance: name, action: 'node_network:delete', target: `${name}:net:${node}:${iface}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('delete', `/nodes/${node}/network/${iface}`, { signal });
              return { instance: name, node, iface, removed: true, note: 'removed from the pending configuration' };
            },
          );
        }

        if (action === 'apply') {
          if (!canCommitConfirm(settings)) {
            throw new VmError(
              'applying network changes needs the API transport (to probe reachability) and the ssh channel (to arm the rollback) — set apiUrl/apiToken and sshHost on this instance',
              'BAD_ARGUMENT',
            );
          }
          const pending = await readPending(controller, signal);
          if (pending.available && pending.present === false) {
            throw new VmError('there is no pending network configuration to apply', 'BAD_ARGUMENT');
          }
          const seconds = Math.max(30, Math.min(900, Math.trunc(Number(args.timeout_sec) || 180)));
          const management = managementIface(
            await controller.pveshGet(`/nodes/${node}/network`, {}, { signal }),
            settings,
          );
          const summary =
            `Apply the pending network configuration on ${node}${management ? ` (the management interface looks like ${management})` : ''}. ` +
            'This runs `pvesh set /nodes/' + node + '/network`, which reloads the interfaces; if the address or gateway changes, the API and ssh session drop. ' +
            `Before that, a rollback timer is armed: in ${seconds} seconds it restores /etc/network/interfaces and /etc/network/interfaces.new and runs "${RELOAD}". ` +
            'It is cancelled only when the node answers over the API again.';
          return await runGuarded(
            deps.confirms,
            { args, instance: name, action: 'node_network:apply', target: `${name}:net:${node}`, risk: 'destroy', summary },
            async () => {
              const id = rollbackId();
              const armed = await armRollback(controller, { id, files: NETWORK_FILES, restoreCommand: RELOAD, seconds, signal });
              const applyUnit = rollbackId('dsh-apply');
              try {
                await runDetached(controller, {
                  id: applyUnit,
                  script: `pvesh set /nodes/${node}/network`,
                  description: `dsh-pve-vm apply ${node}`,
                  signal,
                });
              } catch (error) {
                await cancelRollback(controller, id, { signal }).catch(() => {});
                throw error;
              }
              const probe = await probeApi(controller, { attempts: 8, delayMs: 1500, signal });
              if (probe.reachable) {
                await cancelRollback(controller, id, { signal });
                return {
                  instance: name,
                  node,
                  applied: true,
                  reachable: true,
                  probe,
                  rollback: { unit: armed.unit, seconds: armed.seconds, cancelled: true },
                };
              }
              return {
                instance: name,
                node,
                applied: true,
                reachable: false,
                probe,
                rollback: { unit: armed.unit, seconds: armed.seconds, cancelled: false },
                warning:
                  `the node did not answer over the API within ${probe.ms} ms after the change. ` +
                  `The rollback timer ${armed.unit} will restore the previous configuration in ${armed.seconds} seconds and run "${RELOAD}", ` +
                  'so the node should come back by itself. Do not repeat the change before that happens.',
              };
            },
          );
        }

        throw new VmError(`unknown action "${args.action}" — use list, create, update, delete or apply`, 'BAD_ARGUMENT');
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
