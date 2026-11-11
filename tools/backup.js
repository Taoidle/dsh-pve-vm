/**
 * Backups, clones and migration.
 *
 * `vzdump` (backup) is the PVE binary behind the "Backup" button and the API;
 * it answers with a node task, so the follow-up is `node_task`. `qmrestore`
 * writes over an existing VM, so it is one of the few "destroy" actions here.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';

/** Pull the UPID out of a command answer. */
function upidOf(text) {
  const match = /UPID:[^\s"']+/.exec(text ?? '');
  return match ? match[0] : '';
}

/** Shorten a vzdump task for the answer. */
function tasksOf(list, limit = 20) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, limit).map((task) => ({
    upid: task.upid,
    status: task.status,
    exitstatus: task.exitstatus,
    starttime: task.starttime ? new Date(Number(task.starttime) * 1000).toISOString() : undefined,
    id: task.id,
  }));
}

/**
 * Build the backup, clone and migration tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function backupTools(deps) {
  return [
    {
      name: 'vm_backup',
      description:
        'Backups of a VM: list the recent vzdump tasks, start a backup to a storage, or restore an archive over a VM. ' +
        'Listing is safe; starting with mode=stop or mode=suspend interrupts the guest and needs a second confirmation, ' +
        'and restoring overwrites the target VM — that also needs one.',
      parameters: {
        action: { type: 'string', enum: ['list', 'start', 'restore'], required: true, description: 'Backup operation.' },
        vmid: { type: 'number', description: 'VM id (required for start and restore).' },
        storage: { type: 'string', description: 'Backup storage for action=start (default local).' },
        mode: {
          type: 'string',
          enum: ['snapshot', 'suspend', 'stop'],
          description: 'vzdump mode for action=start (default snapshot).',
        },
        archive: {
          type: 'string',
          description: 'Absolute archive path on the node for action=restore, for example /var/lib/vz/dump/vzdump-qemu-100-….vma.zst',
        },
        confirm: {
          type: 'string',
          description: 'The token from the first call, for action=restore and for action=start with mode=stop or mode=suspend.',
        },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.action === 'list') {
            const lines = (value.tasks ?? []).map(
              (task) => `${task.starttime ?? 'unknown time'} ${task.status ?? ''}${task.exitstatus ? ` (${task.exitstatus})` : ''} ${task.upid}`,
            );
            return textOutput(`recent backup tasks on ${value.instance}:\n${lines.join('\n') || 'none'}`);
          }
          return textOutput(
            value.action === 'start'
              ? `backup of VM ${value.vmid} started on ${value.instance}${value.upid ? `, task ${value.upid}` : ''}`
              : `VM ${value.vmid} restored on ${value.instance} from ${value.archive}`,
          );
        },
      },
      timeoutMs: 1_800_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        if (action === 'list') {
          const node = await controller.nodeName();
          const tasks = await controller.pveshGet(
            `/nodes/${node}/tasks`,
            { typefilter: 'vzdump', limit: 200 },
            { signal: exec?.signal },
          );
          return { instance: name, action, tasks: tasksOf(tasks) };
        }
        const vmid = controller.assertAllowed(args.vmid);
        if (action === 'start') {
          const node = await controller.nodeFor(vmid);
          const mode = args.mode ?? 'snapshot';
          const risk = mode === 'stop' || mode === 'suspend' ? 'danger' : 'safe';
          const effect =
            mode === 'stop'
              ? 'the guest is stopped for the whole backup, interrupting it until the backup finishes'
              : mode === 'suspend'
                ? 'the guest is suspended for the whole backup, interrupting it until the backup finishes'
                : 'the guest keeps running (QEMU snapshot)';
          const summary = `Back up VM ${vmid} on ${name} with vzdump mode "${mode}": ${effect}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'vm_backup:start', target: `${name}:vm:${vmid}`, risk, summary },
            async () => {
              const result = await controller.pvesh('create', `/nodes/${node}/vzdump`, {
                params: {
                  vmid,
                  storage: args.storage ?? 'local',
                  mode,
                  compress: 'zstd',
                },
                signal: exec?.signal,
                timeoutMs: 120_000,
              });
              if (result.exitCode !== 0) {
                throw new VmError(`starting the backup failed: ${result.stderr || result.stdout}`, 'NODE_COMMAND_FAILED');
              }
              return { instance: name, action, vmid, upid: upidOf(result.stdout) || result.stdout };
            },
          );
        }
        if (action === 'restore') {
          const archive = typeof args.archive === 'string' ? args.archive.trim() : '';
          if (!archive.startsWith('/') || /[\n\r\0]/.test(archive)) {
            throw new VmError('restore needs an absolute archive path on the node', 'BAD_ARGUMENT');
          }
          const summary =
            `Restore VM ${vmid} on ${name} from ${archive}. This OVERWRITES the existing VM ${vmid}; ` +
            'its current disks are replaced by the ones in the archive.';
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'vm_backup:restore', target: `${name}:vm:${vmid}`, risk: 'destroy', summary },
            async () => {
              const result = await controller.command('qmrestore', [archive, vmid, '--force'], {
                timeoutMs: 1_800_000,
                signal: exec?.signal,
              });
              if (result.exitCode !== 0) {
                throw new VmError(`qmrestore failed: ${result.stderr || result.stdout}`, 'NODE_COMMAND_FAILED');
              }
              return { instance: name, action, vmid, archive, stdout: result.stdout };
            },
          );
        }
        throw new VmError(`unknown backup action "${action}"`, 'BAD_ARGUMENT');
      },
    },
    {
      name: 'vm_clone',
      description:
        'Clone a VM (a new VM, its own disks). Nothing existing is changed, so it runs directly; a full clone copies every ' +
        'disk and can be large. Omit newid to take the cluster next free id.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'Source VM id.' },
        newid: { type: 'number', description: 'Id for the clone. Omit for the cluster next free id.' },
        name: { type: 'string', description: 'Name for the clone.' },
        full: { type: 'boolean', description: 'Copy every disk (default true). A linked clone shares the base image instead.' },
        target: { type: 'string', description: 'Target node for a cross-node clone.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => textOutput(`VM ${value.source} cloned to VM ${value.vmid} on ${value.instance}${value.name ? ` (${value.name})` : ''}`),
      },
      timeoutMs: 1_800_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const source = controller.assertAllowed(args.vmid);
        const newid = args.newid ?? Number(await controller.pveshGet('/cluster/nextid'));
        if (!Number.isInteger(newid) || newid <= 0) throw new VmError(`the cluster next id is not usable: ${newid}`, 'BAD_ARGUMENT');
        const argv = ['clone', source, newid];
        if (args.name) argv.push('--name', args.name);
        if (args.full !== false) argv.push('--full', '1');
        if (args.target) argv.push('--target', args.target);
        await controller.qmOk(argv, { timeoutMs: 1_800_000, signal: exec?.signal });
        return { instance: name, source, vmid: newid, name: args.name };
      },
    },
    {
      name: 'vm_migrate',
      description:
        'Migrate a VM to another node of the cluster. The VM stops on this node and continues on the target; this needs a ' +
        'second confirmation because a failed migration leaves the VM down.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        target: { type: 'string', required: true, description: 'Target node name.' },
        online: { type: 'boolean', description: 'Live migration without stopping the guest (default true).' },
        withLocalDisks: { type: 'boolean', description: 'Also move disks that live on local storage (default false).' },
        confirm: { type: 'string', description: 'The token from the first call.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) =>
          value?.status === 'confirmation-required'
            ? textOutput(value.summary)
            : textOutput(`VM ${value.vmid} moved from ${value.instance} to ${value.target}${value.online ? ' (live)' : ''}`),
      },
      timeoutMs: 1_800_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const target = typeof args.target === 'string' ? args.target.trim() : '';
        if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(target)) throw new VmError(`invalid target node "${target}"`, 'BAD_ARGUMENT');
        const online = args.online !== false;
        const summary =
          `Migrate VM ${vmid} from ${name} to node ${target}${online ? ' with a live migration' : ''}. ` +
          'If the migration fails the VM stays down until it is started somewhere.';
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'vm_migrate', target: `${name}:vm:${vmid}:${target}`, risk: 'danger', summary },
          async () => {
            const argv = ['migrate', vmid, target];
            if (online) argv.push('--online', '1');
            if (args.withLocalDisks) argv.push('--with-local-disks', '1');
            await controller.qmOk(argv, { timeoutMs: 1_800_000, signal: exec?.signal });
            return { instance: name, vmid, target, online };
          },
        );
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
