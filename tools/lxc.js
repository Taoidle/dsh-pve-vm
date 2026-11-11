/**
 * LXC containers.
 *
 * Containers are the piece the plugin was missing entirely: `qm` only knows
 * virtual machines, so every LXC call goes through the Proxmox API
 * (`/nodes/{node}/lxc/{vmid}`). Container ids share the number space with VM
 * ids and the same `allowVmids` list guards them.
 *
 * `pct exec` has no REST endpoint, so command execution runs it over the ssh
 * channel that is already configured — the API transport keeps that channel
 * around for the console and the guest agent anyway.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, parseAssignments, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';

/** Host endings the LXC status endpoints accept. */
const POWER_ACTIONS = {
  start: 'safe',
  shutdown: 'safe',
  stop: 'danger',
  reboot: 'danger',
  suspend: 'danger',
  resume: 'safe',
};

/** One container line for the agent. */
function describeContainer(entry) {
  const memory = entry.maxmem ? `, ${Math.round(entry.maxmem / 1024 ** 2)} MiB` : '';
  const tags = [];
  if (entry.node !== undefined) tags.push(`on ${entry.node}`);
  if (entry.template) tags.push('template');
  return `CT ${entry.vmid} ${entry.name ?? ''} — ${entry.status ?? 'unknown'}${memory}${tags.length ? ` (${tags.join(', ')})` : ''}`;
}

/**
 * Build the container tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function lxcTools(deps) {
  return [
    {
      name: 'lxc_list',
      description:
        'List LXC containers on every node of the cluster (or one node), with status and the node each one lives on. ' +
        'Container ids are checked against the same allow list as VM ids.',
      parameters: {
        node: { type: 'string', description: 'Only containers on this node (optional).' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          const lines = (value.containers ?? []).map((entry) => describeContainer(entry));
          return textOutput(`containers${args.node ? ` on ${args.node}` : ''}:\n${lines.join('\n') || 'none'}`);
        },
      },
      timeoutMs: 60_000,
      async execute(args, exec) {
        const { controller, name, settings } = instanceOf(deps, args);
        const resources = await controller.pveshGet('/cluster/resources', { type: 'vm' }, { signal: exec?.signal });
        const allowed = new Set(settings.allowVmids ?? []);
        const containers = (Array.isArray(resources) ? resources : [])
          .filter((entry) => entry.type === 'lxc' && (args.node === undefined || entry.node === args.node))
          .filter((entry) => allowed.size === 0 || allowed.has(Number(entry.vmid)))
          .map((entry) => ({
            vmid: Number(entry.vmid),
            name: entry.name,
            node: entry.node,
            status: entry.status,
            template: entry.template === 1,
            maxmem: entry.maxmem,
            maxdisk: entry.maxdisk,
          }))
          .sort((left, right) => left.vmid - right.vmid);
        return { instance: name, containers };
      },
    },
    {
      name: 'lxc_status',
      description: 'Read one container: runtime status and the full configuration.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'Container id.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) =>
          value?.error
            ? textOutput(`CT ${args.vmid}: ${value.error}`)
            : textOutput(`CT ${value.vmid} on ${value.node}:\nstatus: ${JSON.stringify(value.status, null, 2)}\nconfig: ${JSON.stringify(value.config, null, 2)}`),
      },
      timeoutMs: 60_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid, 'guest');
        const node = await controller.nodeFor(vmid);
        const [status, config] = await Promise.all([
          controller.pveshGet(`/nodes/${node}/lxc/${vmid}/status/current`, {}, { signal: exec?.signal }),
          controller.pveshGet(`/nodes/${node}/lxc/${vmid}/config`, {}, { signal: exec?.signal }),
        ]);
        return { instance: name, vmid, node, status, config };
      },
    },
    {
      name: 'lxc_power',
      description:
        'Start, shut down, stop, reboot, suspend or resume a container. `stop`, `reboot` and `suspend` need a second ' +
        'confirmation (the first call returns a token, the second call with confirm="<token>" performs it).',
      parameters: {
        vmid: { type: 'number', required: true, description: 'Container id.' },
        action: {
          type: 'string',
          enum: Object.keys(POWER_ACTIONS),
          required: true,
          description: 'Lifecycle action.',
        },
        confirm: { type: 'string', description: 'The token from the first call, for stop, reboot and suspend.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) =>
          value?.status === 'confirmation-required'
            ? textOutput(value.summary)
            : textOutput(`CT ${value.vmid}: ${value.action} done (now ${value.state ?? 'unknown'})`),
      },
      timeoutMs: 300_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const action = String(args.action);
        const risk = POWER_ACTIONS[action];
        if (risk === undefined) throw new VmError(`unknown container action "${action}"`, 'BAD_ARGUMENT');
        const node = await controller.nodeFor(vmid);
        const run = async () => {
          await controller.pvesh('create', `/nodes/${node}/lxc/${vmid}/status/${action}`, {
            signal: exec?.signal,
            timeoutMs: 120_000,
          });
          const state = await controller.pveshGet(`/nodes/${node}/lxc/${vmid}/status/current`, {}, { signal: exec?.signal });
          return { instance: name, vmid, action, state: state?.status ?? 'unknown' };
        };
        if (risk === 'safe') return run();
        const summary = `Container ${vmid} on ${name}: ${action}. ${
          action === 'stop' ? 'This is an immediate stop, not a shutdown.' : 'Any unsaved state in the container is lost.'
        }`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: `lxc_power:${action}`, target: `${name}:lxc:${vmid}`, risk, summary },
          run,
        );
      },
    },
    {
      name: 'lxc_create',
      description:
        'Create a container from a template. Needs an ostemplate path that exists on the node (for example ' +
        'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst); sudo/local-lvm is PVE default storage.',
      parameters: {
        ostemplate: { type: 'string', required: true, description: 'Template volume id, for example local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst.' },
        vmid: { type: 'number', description: 'Container id (default: the cluster next id).' },
        hostname: { type: 'string', description: 'Container hostname.' },
        storage: { type: 'string', description: 'Storage for the root filesystem (default local-lvm).' },
        memory: { type: 'number', description: 'Memory in MiB (default 512).' },
        cores: { type: 'number', description: 'CPU cores (default 1).' },
        password: { type: 'string', description: 'Root password inside the container (optional).' },
        start: { type: 'boolean', description: 'Start the container after creation (default false).' },
        unprivileged: { type: 'boolean', description: 'Create an unprivileged container (default true).' },
        node: { type: 'string', description: 'Node to create it on (default: the instance node).' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) =>
          textOutput(`CT ${value.vmid} created on ${value.node}${value.upid ? `, task ${value.upid}` : ''}${value.started ? ' (started)' : ''}`),
      },
      timeoutMs: 900_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const node = args.node ?? (await controller.nodeName());
        const vmid = args.vmid ?? Number(await controller.pveshGet('/cluster/nextid', {}, { signal: exec?.signal }));
        if (!Number.isInteger(vmid) || vmid <= 0) throw new VmError(`the cluster next id is not usable: ${vmid}`, 'BAD_ARGUMENT');
        // Creation is not governed by allowVmids (the id does not exist yet), but
        // the new container has to be added to the list before it can be managed.
        const ostemplate = String(args.ostemplate ?? '').trim();
        if (!ostemplate.includes(':')) throw new VmError('ostemplate must be a PVE volume id such as local:vztmpl/….tar.zst', 'BAD_ARGUMENT');
        const params = {
          vmid,
          ostemplate,
          storage: args.storage ?? 'local-lvm',
          memory: args.memory ?? 512,
          cores: args.cores ?? 1,
          unprivileged: args.unprivileged !== false ? 1 : 0,
        };
        if (args.hostname) params.hostname = String(args.hostname);
        if (args.password) params.password = String(args.password);
        if (args.start === true) params.start = 1;
        const result = await controller.pvesh('create', `/nodes/${node}/lxc`, {
          params,
          signal: exec?.signal,
          timeoutMs: 600_000,
        });
        return { instance: name, vmid, node, upid: result.stdout, started: args.start === true };
      },
    },
    {
      name: 'lxc_config',
      description:
        'Read or change a container configuration. Writes use `key=value` strings and need a second confirmation ' +
        '(a value without "=" deletes the key).',
      parameters: {
        vmid: { type: 'number', required: true, description: 'Container id.' },
        action: { type: 'string', enum: ['get', 'set'], required: true, description: 'Configuration operation.' },
        settings: {
          type: 'array',
          items: { type: 'string' },
          description: 'Changes as "key=value" strings for action=set (for example ["memory=2048", "cores=2"]).',
        },
        confirm: { type: 'string', description: 'The token from the first call, for action=set.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) =>
          value?.status === 'confirmation-required'
            ? textOutput(value.summary)
            : textOutput(`CT ${value.vmid} configuration (${args.action}):\n${JSON.stringify(value.config, null, 2)}`),
      },
      timeoutMs: 180_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid, 'guest');
        const node = await controller.nodeFor(vmid);
        if (args.action === 'get') {
          const config = await controller.pveshGet(`/nodes/${node}/lxc/${vmid}/config`, {}, { signal: exec?.signal });
          return { instance: name, vmid, config };
        }
        const pairs = parseAssignments(args.settings ?? []);
        if (pairs.length === 0) throw new VmError('action=set needs at least one "key=value" entry', 'BAD_ARGUMENT');
        const summary = `Change container ${vmid} on ${name}: ${pairs.map((pair) => pair.value === '' ? `delete ${pair.key}` : `${pair.key}=${pair.value}`).join(', ')}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'lxc_config:set', target: `${name}:lxc:${vmid}`, risk: 'danger', summary },
          async () => {
            for (const pair of pairs) {
              await controller.pvesh('set', `/nodes/${node}/lxc/${vmid}/config`, {
                params: { [pair.key]: pair.value },
                signal: exec?.signal,
              });
            }
            const config = await controller.pveshGet(`/nodes/${node}/lxc/${vmid}/config`, {}, { signal: exec?.signal });
            return { instance: name, vmid, config };
          },
        );
      },
    },
    {
      name: 'lxc_snapshot',
      description:
        'Container snapshots: list, create, delete or roll back. Delete and rollback discard newer state and need a ' +
        'second confirmation; create and list are safe.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'Container id.' },
        action: { type: 'string', enum: ['list', 'create', 'delete', 'rollback'], required: true, description: 'Snapshot operation.' },
        name: { type: 'string', description: 'Snapshot name (required for create, delete and rollback).' },
        description: { type: 'string', description: 'Snapshot description (create only).' },
        confirm: { type: 'string', description: 'The token from the first call, for delete and rollback.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.action === 'list') {
            const lines = (value.snapshots ?? []).map((entry) => `${entry.name}${entry.parent ? ` (parent ${entry.parent})` : ''}`);
            return textOutput(`CT ${value.vmid} snapshots:\n${lines.join('\n') || 'none'}`);
          }
          return textOutput(`CT ${value.vmid}: snapshot "${value.name}" ${value.action} done`);
        },
      },
      timeoutMs: 600_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const node = await controller.nodeFor(vmid);
        const base = `/nodes/${node}/lxc/${vmid}/snapshot`;
        if (args.action === 'list') {
          const snapshots = await controller.pveshGet(base, {}, { signal: exec?.signal });
          return { instance: name, vmid, action: 'list', snapshots };
        }
        const snapshot = typeof args.name === 'string' ? args.name.trim() : '';
        if (snapshot.length === 0) throw new VmError(`snapshot name is required for ${args.action}`, 'BAD_ARGUMENT');
        if (args.action === 'create') {
          await controller.pvesh('create', base, {
            params: { snapname: snapshot, ...(args.description ? { description: String(args.description) } : {}) },
            signal: exec?.signal,
            timeoutMs: 600_000,
          });
          return { instance: name, vmid, action: 'create', name: snapshot };
        }
        const rollback = args.action === 'rollback';
        const summary = rollback
          ? `Roll back container ${vmid} on ${name} to snapshot "${snapshot}": everything written after that snapshot is lost.`
          : `Delete snapshot "${snapshot}" of container ${vmid} on ${name}: that state can no longer be restored.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: `lxc_snapshot:${args.action}`, target: `${name}:lxc:${vmid}:${snapshot}`, risk: rollback ? 'destroy' : 'danger', summary },
          async () => {
            if (rollback) await controller.pvesh('create', `${base}/${encodeURIComponent(snapshot)}/rollback`, { signal: exec?.signal, timeoutMs: 600_000 });
            else await controller.pvesh('delete', `${base}/${encodeURIComponent(snapshot)}`, { signal: exec?.signal, timeoutMs: 600_000 });
            return { instance: name, vmid, action: args.action, name: snapshot };
          },
        );
      },
    },
    {
      name: 'lxc_exec',
      description:
        'Run a command inside a container with `pct exec` over ssh (the REST API has no exec endpoint). The first ' +
        'argument is the program, the rest are its arguments — no shell is involved unless you use one explicitly.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'Container id.' },
        argv: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: 'Program and arguments, for example ["uname", "-a"] or ["sh", "-lc", "cat /etc/os-release"].',
        },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => textOutput(value.stdout || `(no output, exit ${value.exitCode})`),
      },
      timeoutMs: 180_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid, 'guest');
        const argv = Array.isArray(args.argv) ? args.argv.map(String) : [];
        if (argv.length === 0) throw new VmError('argv needs at least the program name', 'BAD_ARGUMENT');
        const result = await controller.command('pct', ['exec', String(vmid), '--', ...argv], {
          timeoutMs: 120_000,
          signal: exec?.signal,
        });
        if (result.exitCode !== 0) {
          throw new VmError(`pct exec exited with ${result.exitCode}: ${result.stderr || result.stdout}`, 'NODE_COMMAND_FAILED');
        }
        return { instance: name, vmid, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      },
    },
    {
      name: 'lxc_delete',
      description:
        'Destroy a container and its disks. Needs a second confirmation; nothing on the host can bring it back ' +
        'without a backup.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'Container id.' },
        purge: { type: 'boolean', description: 'Also remove the container from backup jobs and replication (default true).' },
        force: { type: 'boolean', description: 'Destroy even if the container is running (default false).' },
        confirm: { type: 'string', description: 'The token from the first call.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) =>
          value?.status === 'confirmation-required' ? textOutput(value.summary) : textOutput(`CT ${value.vmid} destroyed on ${value.node}`),
      },
      timeoutMs: 600_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const node = await controller.nodeFor(vmid);
        const summary = `Destroy container ${vmid} on ${name} (node ${node}) and delete its disks. This cannot be undone without a backup.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'lxc_delete', target: `${name}:lxc:${vmid}`, risk: 'destroy', summary },
          async () => {
            const params = {};
            if (args.purge !== false) params.purge = 1;
            if (args.force === true) params.force = 1;
            await controller.pvesh('delete', `/nodes/${node}/lxc/${vmid}`, {
              params,
              signal: exec?.signal,
              timeoutMs: 600_000,
            });
            return { instance: name, vmid, node };
          },
        );
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
