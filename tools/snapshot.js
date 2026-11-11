/**
 * Snapshots and VM configuration.
 *
 * Reads go through `pvesh` (structured JSON), writes through `qm`, which is the
 * same binary the PVE web UI drives. Configuration writes are dangerous: a
 * wrong `qm set` can detach a disk or change the boot order of a running VM,
 * so they pass the confirmation store.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, parseAssignments, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';

/** Describe one snapshot line for the agent. */
function describeSnapshot(entry) {
  const when = entry.snaptime ? new Date(Number(entry.snaptime) * 1000).toISOString() : 'no date';
  return `${entry.name}${entry.parent ? ` (parent ${entry.parent})` : ''} — ${when}${entry.description ? `: ${entry.description}` : ''}`;
}

/**
 * Build the snapshot and configuration tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function snapshotTools(deps) {
  return [
    {
      name: 'vm_snapshot',
      description:
        'VM snapshots: list, create, delete, roll back. Deleting and rolling back discard newer state, so they need a second ' +
        'confirmation (the first call returns a token, the second call with confirm="<token>" performs it). Creating is safe.',
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'delete', 'rollback'],
          required: true,
          description: 'Snapshot operation.',
        },
        vmid: { type: 'number', required: true, description: 'VM id.' },
        name: { type: 'string', description: 'Snapshot name (required for create, delete and rollback).' },
        description: { type: 'string', description: 'Snapshot description (create only).' },
        confirm: { type: 'string', description: 'The token from the first call, for delete and rollback.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (args.action === 'list') {
            const lines = (value.snapshots ?? []).map((entry) => describeSnapshot(entry));
            return textOutput(`VM ${value.vmid} snapshots:\n${lines.join('\n') || 'none'}`);
          }
          return textOutput(`VM ${value.vmid}: snapshot "${value.name}" ${value.action} done`);
        },
      },
      timeoutMs: 600_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const node = await controller.nodeFor(vmid);
        if (args.action === 'list') {
          const snapshots = await controller.pveshGet(`/nodes/${node}/qemu/${vmid}/snapshot`, {}, { signal: exec?.signal });
          return { vmid, instance: name, snapshots };
        }
        const snapshot = typeof args.name === 'string' ? args.name.trim() : '';
        if (snapshot.length === 0) throw new VmError(`snapshot name is required for ${args.action}`, 'BAD_ARGUMENT');
        if (args.action === 'create') {
          await controller.qmOk(
            ['snapshot', vmid, snapshot, ...(args.description ? ['--description', args.description] : [])],
            { timeoutMs: 600_000, signal: exec?.signal },
          );
          return { vmid, instance: name, name: snapshot, action: 'create' };
        }
        const rollback = args.action === 'rollback';
        const summary = rollback
          ? `Roll back VM ${vmid} on ${name} to snapshot "${snapshot}": everything written after that snapshot is lost.`
          : `Delete snapshot "${snapshot}" of VM ${vmid} on ${name}: that state can no longer be restored.`;
        return runGuarded(
          deps.confirms,
          {
            args,
            instance: name,
            action: `vm_snapshot:${args.action}`,
            target: `${name}:vm:${vmid}:${snapshot}`,
            risk: 'destroy',
            summary,
          },
          async () => {
            await controller.qmOk([rollback ? 'rollback' : 'delsnapshot', vmid, snapshot], {
              timeoutMs: 600_000,
              signal: exec?.signal,
            });
            return { vmid, instance: name, name: snapshot, action: args.action };
          },
        );
      },
    },
    {
      name: 'vm_config',
      description:
        'VM configuration: read the full config or the pending changes, or transfer a set of changes with `qm set` semantics ' +
        '(for example "memory=4096"). A write needs a second confirmation; a value without "=" means delete that property.',
      parameters: {
        action: { type: 'string', enum: ['get', 'pending', 'set'], required: true, description: 'Configuration operation.' },
        vmid: { type: 'number', required: true, description: 'VM id.' },
        settings: {
          type: 'array',
          items: { type: 'string' },
          description: 'Changes as "key=value" strings for action=set (for example ["memory=4096", "cores=4"]).',
        },
        confirm: { type: 'string', description: 'The token from the first call, for action=set.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) =>
          value?.status === 'confirmation-required'
            ? textOutput(value.summary)
            : textOutput(`VM ${value.vmid} configuration (${args.action}):\n${JSON.stringify(value.config ?? value.changes, null, 2)}`),
      },
      timeoutMs: 180_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const node = await controller.nodeFor(vmid);
        if (args.action === 'get') {
          const config = await controller.pveshGet(`/nodes/${node}/qemu/${vmid}/config`, {}, { signal: exec?.signal });
          return { vmid, instance: name, config };
        }
        if (args.action === 'pending') {
          const config = await controller.pveshGet(`/nodes/${node}/qemu/${vmid}/pending`, {}, { signal: exec?.signal });
          return { vmid, instance: name, config };
        }
        const pairs = parseAssignments(args.settings);
        if (pairs.length === 0) throw new VmError('action=set needs at least one "key=value" entry in settings', 'BAD_ARGUMENT');
        const flags = [];
        for (const pair of pairs) {
          if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(pair.key)) {
            throw new VmError(`invalid configuration key "${pair.key}"`, 'BAD_ARGUMENT');
          }
          if (pair.value === '') flags.push('--delete', pair.key);
          else flags.push(`--${pair.key}`, pair.value);
        }
        const changes = pairs.map((pair) => (pair.value === '' ? `${pair.key} (deleted)` : `${pair.key}=${pair.value}`));
        const summary = `Change VM ${vmid} on ${name}: ${changes.join(', ')}. A wrong value can detach a disk or break the boot.`;
        return runGuarded(
          deps.confirms,
          {
            args,
            instance: name,
            action: 'vm_config:set',
            target: `${name}:vm:${vmid}`,
            risk: 'danger',
            summary,
          },
          async () => {
            await controller.qmOk(['set', vmid, ...flags], { timeoutMs: 120_000, signal: exec?.signal });
            return { vmid, instance: name, changes };
          },
        );
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
