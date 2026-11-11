/**
 * Scheduled backup jobs (Datacenter → Backup).
 *
 * A job is a cluster-wide record (`/cluster/backup`); running one calls
 * `vzdump` on the node that holds the guests, which is why the job is read
 * first: the node, the guest set and the storage all live in that record.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';

/** The pieces of a job a caller may set. */
const EDITABLE = ['storage', 'schedule', 'vmid', 'mode', 'compress', 'enabled', 'node', 'notes-template', 'mailnotification'];

/** Describe one job line. */
function describeJob(job) {
  const guests = job.all ? 'all guests' : String(job.vmid ?? 'no guests');
  return `${job.id}: ${guests} → ${job.storage ?? 'local'} (${job.mode ?? 'snapshot'}, ${job.compress ?? '0'})${job.schedule ? `, schedule ${job.schedule}` : ', run manually'}${job.enabled ? '' : ', disabled'}`;
}

/** Read the job id out of a create answer (the API answers a bare id). */
function jobIdOf(stdout) {
  const text = String(stdout ?? '').trim();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') return parsed.id;
  } catch {
    // A bare id is not JSON; fall through.
  }
  return text.replace(/^"|"$/g, '');
}

/**
 * Build the scheduled-backup tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function backupJobTools(deps) {
  return [
    {
      name: 'backup_job',
      description:
        'Scheduled backup jobs: list, create, update, delete, or run one now. Create/update/delete change what will be ' +
        'backed up later, so they need a second confirmation; listing is safe, and so is running a job whose stored ' +
        'mode is snapshot. A job stored with mode=stop or mode=suspend interrupts the guest, so running it needs a ' +
        'confirmation too.',
      parameters: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'run'], required: true, description: 'Job operation.' },
        id: { type: 'string', description: 'Job id (for update, delete and run).' },
        storage: { type: 'string', description: 'Backup storage for create/update.' },
        schedule: { type: 'string', description: 'Systemd calendar schedule, for example "02:30" or "sun 03:00".' },
        vmid: { type: 'string', description: 'Guest ids for create/update, comma separated (for example "100,101").' },
        mode: { type: 'string', enum: ['snapshot', 'suspend', 'stop'], description: 'vzdump mode for create/update.' },
        compress: { type: 'string', enum: ['0', 'zstd', 'gzip', 'lzo'], description: 'Compression for create/update.' },
        enabled: { type: 'boolean', description: 'Whether the job is armed (create/update).' },
        node: { type: 'string', description: 'Node to run on for action=run (default: the job node, else this instance\'s node).' },
        confirm: { type: 'string', description: 'The token from the first call, for create, update, delete and a run whose stored mode is stop or suspend.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.action === 'list') {
            const lines = (value.jobs ?? []).map((job) => describeJob(job));
            return textOutput(`scheduled backup jobs:\n${lines.join('\n') || 'none'}`);
          }
          if (value.action === 'run') return textOutput(`backup job ${value.id} started on ${value.node}${value.upid ? `, task ${value.upid}` : ''}`);
          return textOutput(`backup job ${value.id}: ${value.action} done`);
        },
      },
      timeoutMs: 1_800_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        if (action === 'list') {
          const jobs = await controller.pveshGet('/cluster/backup', {}, { signal: exec?.signal });
          return { instance: name, action, jobs: Array.isArray(jobs) ? jobs : [] };
        }
        if (action === 'run') {
          const id = String(args.id ?? '').trim();
          if (id.length === 0) throw new VmError('action=run needs the job id', 'BAD_ARGUMENT');
          const job = await controller.pveshGet(`/cluster/backup/${encodeURIComponent(id)}`, {}, { signal: exec?.signal });
          const node = args.node ?? job.node ?? (await controller.nodeName());
          const params = {};
          for (const key of ['storage', 'mode', 'compress', 'notes-template', 'mailnotification', 'prune-backups', 'bwlimit']) {
            if (job[key] !== undefined && job[key] !== '') params[key] = job[key];
          }
          if (job.all) params.all = 1;
          else if (job.vmid) params.vmid = String(job.vmid);
          const mode = params.mode ?? 'snapshot';
          const risk = mode === 'stop' || mode === 'suspend' ? 'danger' : 'safe';
          const effect =
            mode === 'stop'
              ? 'the guests are stopped for the whole backup, interrupting them until the backup finishes'
              : mode === 'suspend'
                ? 'the guests are suspended for the whole backup, interrupting them until the backup finishes'
                : 'the guests keep running (QEMU snapshot)';
          const summary = `Run backup job ${id} on ${node} with stored mode "${mode}": ${effect}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: `backup_job:run:${id}`, target: `${name}:backup-job:${id}`, risk, summary },
            async () => {
              const result = await controller.pvesh('create', `/nodes/${node}/vzdump`, {
                params,
                signal: exec?.signal,
                timeoutMs: 120_000,
              });
              const upid = /UPID:[^\s"']+/.exec(result.stdout ?? '');
              return { instance: name, action, id, node, upid: upid ? upid[0] : result.stdout };
            },
          );
        }
        const build = () => {
          const params = {};
          for (const key of EDITABLE) if (args[key] !== undefined) params[key] = typeof args[key] === 'boolean' ? (args[key] ? 1 : 0) : String(args[key]);
          return params;
        };
        if (action === 'create') {
          const params = build();
          if (params.storage === undefined) throw new VmError('action=create needs a storage', 'BAD_ARGUMENT');
          const summary = `Create a backup job: ${args.vmid ? `guests ${args.vmid}` : 'all guests'} → ${params.storage}${args.schedule ? `, schedule ${args.schedule}` : ''}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'backup_job:create', target: `${name}:backup-job:new`, risk: 'danger', summary },
            async () => {
              const result = await controller.pvesh('create', '/cluster/backup', { params, signal: exec?.signal });
              return { instance: name, action, id: jobIdOf(result.stdout) };
            },
          );
        }
        const id = String(args.id ?? '').trim();
        if (id.length === 0) throw new VmError(`action=${action} needs the job id`, 'BAD_ARGUMENT');
        if (action === 'delete') {
          const summary = `Delete backup job ${id}: the schedule disappears, existing archives stay on the storage.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'backup_job:delete', target: `${name}:backup-job:${id}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('delete', `/cluster/backup/${encodeURIComponent(id)}`, { signal: exec?.signal });
              return { instance: name, action, id };
            },
          );
        }
        const params = build();
        if (Object.keys(params).length === 0) throw new VmError('action=update needs at least one field', 'BAD_ARGUMENT');
        const summary = `Change backup job ${id}: ${Object.entries(params).map(([key, value]) => `${key}=${value}`).join(', ')}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'backup_job:update', target: `${name}:backup-job:${id}`, risk: 'danger', summary },
          async () => {
            await controller.pvesh('set', `/cluster/backup/${encodeURIComponent(id)}`, { params, signal: exec?.signal });
            return { instance: name, action, id };
          },
        );
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
