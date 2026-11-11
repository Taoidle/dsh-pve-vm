/**
 * Storage definitions and the files inside them.
 *
 * Two sides of the same thing: `pve_storage` owns the cluster records
 * (`/storage`) — a wrong definition hides a datastore or points it at the wrong
 * path, so the writes are confirmed; `storage_content` owns the volumes inside a
 * storage (ISOs, backups, disk images), including the one operation that needs
 * the bytes themselves: uploading an ISO from the machine running this plugin.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';

/** Storage types PVE accepts in a storage record. */
const TYPES = ['dir', 'nfs', 'cifs', 'lvm', 'lvmthin', 'zfspool', 'zfs', 'btrfs', 'rbd', 'cephfs', 'glusterfs', 'iscsi', 'iscsidirect', 'pbs', 'esxi'];

/** The content kinds a storage can hold. */
const CONTENT = ['images', 'rootdir', 'vztmpl', 'iso', 'backup', 'snippets'];

/** What a definition write may set. */
const STORAGE_FIELDS = ['type', 'content', 'path', 'server', 'export', 'share', 'options', 'username', 'password', 'nodes', 'disable', 'prune-backups', 'content'];

/** One ISO/backup line for the agent. */
function describeVolume(entry) {
  const size = entry.size ? ` — ${(Number(entry.size) / 1024 ** 2).toFixed(1)} MiB` : '';
  const when = entry.ctime ? ` (${new Date(Number(entry.ctime) * 1000).toISOString().slice(0, 16)})` : '';
  return `${entry.volid}${size}${when}`;
}

/** Read the task id out of an upload answer. */
function upidOf(stdout) {
  const match = /UPID:[^\s"']+/.exec(String(stdout ?? ''));
  return match ? match[0] : String(stdout ?? '');
}

/**
 * Run one pvesh write and fail loudly when it exits non-zero. The API transport
 * throws by itself; the ssh transport returns {exitCode, stdout, stderr}, and
 * ignoring that code would report a failed write as if it had happened.
 */
async function pveshWrite(controller, method, path, options) {
  const result = await controller.pvesh(method, path, options);
  if (result?.exitCode !== 0) {
    const detail = result?.stderr || result?.stdout || 'no error output';
    throw new VmError(
      `pvesh ${method} ${path} exited with ${result?.exitCode ?? 'no exit code'}: ${detail}`,
      'NODE_COMMAND_FAILED',
    );
  }
  return result;
}

/**
 * Build the storage tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function storageAdminTools(deps) {
  return [
    {
      name: 'pve_storage',
      description:
        'Storage definitions of the cluster: list them with their content kinds, or create, update and delete one. ' +
        'A wrong definition hides a datastore (or points it at the wrong path), so the writes need a second confirmation. ' +
        'This does not delete data on disk.',
      parameters: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], required: true, description: 'Storage record operation.' },
        storage: { type: 'string', description: 'Storage id (for update and delete, and to show one record).' },
        type: { type: 'string', enum: TYPES, description: 'Storage type (create only).' },
        content: { type: 'string', description: 'Content kinds, comma separated: images,vztmpl,iso,backup,snippets (create/update).' },
        path: { type: 'string', description: 'Directory path for type=dir (create).' },
        server: { type: 'string', description: 'Server for nfs/cifs/iscsi/pbs (create).' },
        export: { type: 'string', description: 'Export path for nfs (create).' },
        nodes: { type: 'string', description: 'Restrict the storage to these nodes, comma separated (create/update).' },
        disable: { type: 'boolean', description: 'Disable the storage (update).' },
        confirm: { type: 'string', description: 'The token from the first call, for create, update and delete.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.action === 'list') {
            const lines = (value.storages ?? []).map(
              (entry) => `${entry.storage} — ${entry.type}${entry.content ? `, ${entry.content}` : ''}${entry.path ? `, ${entry.path}` : ''}${entry.disable ? ' (disabled)' : ''}`,
            );
            return textOutput(`storage records:\n${lines.join('\n') || 'none'}`);
          }
          return textOutput(`storage ${value.storage}: ${value.action} done`);
        },
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        if (action === 'list') {
          const storages = await controller.pveshGet('/storage', {}, { signal: exec?.signal });
          const list = Array.isArray(storages) ? storages : [];
          const storageId = typeof args.storage === 'string' ? args.storage.trim() : '';
          return { instance: name, action, storages: storageId ? list.filter((entry) => entry.storage === storageId) : list };
        }
        const build = () => {
          const params = {};
          for (const key of STORAGE_FIELDS) {
            if (args[key] === undefined) continue;
            params[key] = typeof args[key] === 'boolean' ? (args[key] ? 1 : 0) : String(args[key]);
          }
          return params;
        };
        if (action === 'create') {
          const storageId = typeof args.storage === 'string' ? args.storage.trim() : '';
          if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(storageId)) throw new VmError('action=create needs a storage id', 'BAD_ARGUMENT');
          if (args.type === undefined) throw new VmError('action=create needs a type', 'BAD_ARGUMENT');
          const params = { storage: storageId, ...build() };
          if (params.content === undefined) params.content = 'images,iso,backup';
          const summary = `Create storage "${storageId}" (${params.type})${params.path ? ` at ${params.path}` : ''}${params.server ? ` on ${params.server}` : ''}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_storage:create', target: `${name}:storage:${storageId}`, risk: 'danger', summary },
            async () => {
              await pveshWrite(controller, 'create', '/storage', { params, signal: exec?.signal });
              return { instance: name, action, storage: storageId };
            },
          );
        }
        const storageId = typeof args.storage === 'string' ? args.storage.trim() : '';
        if (storageId.length === 0) throw new VmError(`action=${action} needs the storage id`, 'BAD_ARGUMENT');
        if (action === 'delete') {
          const summary = `Delete the storage record "${storageId}". The files on the underlying storage stay; PVE just stops using it, and guests that live there become unusable until it is re-added.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_storage:delete', target: `${name}:storage:${storageId}`, risk: 'destroy', summary },
            async () => {
              await pveshWrite(controller, 'delete', `/storage/${encodeURIComponent(storageId)}`, { signal: exec?.signal });
              return { instance: name, action, storage: storageId };
            },
          );
        }
        const params = build();
        if (Object.keys(params).length === 0) throw new VmError('action=update needs at least one field', 'BAD_ARGUMENT');
        const summary = `Change storage "${storageId}": ${Object.entries(params).map(([key, value]) => `${key}=${value}`).join(', ')}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'pve_storage:update', target: `${name}:storage:${storageId}`, risk: 'danger', summary },
          async () => {
            await pveshWrite(controller, 'set', `/storage/${encodeURIComponent(storageId)}`, { params, signal: exec?.signal });
            return { instance: name, action, storage: storageId };
          },
        );
      },
    },
    {
      name: 'storage_content',
      description:
        'Files inside a storage: list ISOs/backups/images, upload an ISO from this machine, delete a volume, download a ' +
        'file from a URL onto the node, or import a disk into a VM. Deleting a volume and importing a disk are ' +
        'destructive and need a second confirmation.',
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'upload-iso', 'delete-volume', 'download-url', 'import-disk'],
          required: true,
          description: 'File operation.',
        },
        storage: { type: 'string', description: 'Storage id (required for every action).' },
        node: { type: 'string', description: 'Node whose storage view to use (default: this instance\'s node).' },
        content: { type: 'string', enum: CONTENT, description: 'Content filter for list (default iso).' },
        volume: { type: 'string', description: 'Full volume id for delete-volume, for example local:iso/debian.iso; also accepted as the source for import-disk.' },
        source: { type: 'string', description: 'import-disk source: an absolute path on the node or a volume id.' },
        file: { type: 'string', description: 'Local file path on the machine running this plugin (upload-iso).' },
        filename: { type: 'string', description: 'Name to store it as (default: the local file name).' },
        url: { type: 'string', description: 'HTTP(S) URL to download (download-url).' },
        vmid: { type: 'number', description: 'VM id (import-disk).' },
        format: { type: 'string', enum: ['raw', 'qcow2', 'vmdk'], description: 'Format for import-disk.' },
        confirm: { type: 'string', description: 'The token from the first call, for delete-volume and import-disk.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.action === 'list') {
            const lines = (value.volumes ?? []).map((entry) => describeVolume(entry));
            return textOutput(`${value.storage}${value.content ? ` (${value.content})` : ''} on ${value.node}:\n${lines.join('\n') || 'empty'}`);
          }
          if (value.action === 'upload-iso') return textOutput(`uploaded ${value.filename} to ${value.storage}${value.upid ? `, task ${value.upid}` : ''}`);
          if (value.action === 'download-url') return textOutput(`download of ${value.url} started on ${value.node}${value.upid ? `, task ${value.upid}` : ''}`);
          if (value.action === 'import-disk') return textOutput(`imported ${value.source} into VM ${value.vmid} on ${value.node}: ${value.stdout || 'done'}`);
          return textOutput(`deleted volume ${value.volume}`);
        },
      },
      timeoutMs: 3_600_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const storage = typeof args.storage === 'string' ? args.storage.trim() : '';
        if (storage.length === 0) throw new VmError('storage is required', 'BAD_ARGUMENT');
        const node = args.node ?? (await controller.nodeName());
        const action = args.action;
        if (action === 'list') {
          const volumes = await controller.pveshGet(
            `/nodes/${node}/storage/${encodeURIComponent(storage)}/content`,
            { content: args.content ?? 'iso' },
            { signal: exec?.signal },
          );
          return { instance: name, action, storage, node, content: args.content ?? 'iso', volumes: Array.isArray(volumes) ? volumes : [] };
        }
        if (action === 'upload-iso') {
          const file = typeof args.file === 'string' ? args.file.trim() : '';
          if (!file.startsWith('/')) throw new VmError('upload-iso needs an absolute path on this machine', 'BAD_ARGUMENT');
          if (typeof controller.upload !== 'function') {
            throw new VmError('uploading needs the API transport — add an apiToken to this instance', 'BAD_ARGUMENT');
          }
          const answer = await controller.upload(`/nodes/${node}/storage/${encodeURIComponent(storage)}/upload`, {
            fields: { content: 'iso' },
            filePath: file,
            fileName: args.filename,
            signal: exec?.signal,
            timeoutMs: 3_600_000,
          });
          const upid = upidOf(answer);
          if (upid.startsWith('UPID:')) await controller.waitTask(node, upid, { signal: exec?.signal, timeoutMs: 3_600_000 });
          return { instance: name, action, storage, node, filename: args.filename ?? file.split('/').pop(), upid };
        }
        if (action === 'download-url') {
          const url = String(args.url ?? '').trim();
          if (!/^https?:\/\//.test(url)) throw new VmError('download-url needs an http(s) URL', 'BAD_ARGUMENT');
          const answer = await pveshWrite(controller, 'create', `/nodes/${node}/storage/${encodeURIComponent(storage)}/download-url`, {
            params: { url, content: 'iso', ...(args.filename ? { filename: String(args.filename) } : {}) },
            signal: exec?.signal,
            timeoutMs: 120_000,
          });
          return { instance: name, action, storage, node, url, upid: upidOf(answer.stdout) };
        }
        const volume = typeof args.volume === 'string' ? args.volume.trim() : '';
        if (action === 'delete-volume') {
          if (!/^[^:]+:[^\s]+$/.test(volume)) throw new VmError('delete-volume needs a full volume id such as local:iso/debian.iso', 'BAD_ARGUMENT');
          const summary = `Delete ${volume} from storage ${storage} on ${node}. The file is removed, not moved to a trash.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'storage_content:delete-volume', target: `${name}:volume:${volume}`, risk: 'destroy', summary },
            async () => {
              await pveshWrite(controller, 'delete', `/nodes/${node}/storage/${encodeURIComponent(storage)}/content/${encodeURIComponent(volume)}`, {
                signal: exec?.signal,
                timeoutMs: 600_000,
              });
              return { instance: name, action, storage, node, volume };
            },
          );
        }
        const vmid = controller.assertAllowed(args.vmid);
        const source = typeof args.volume === 'string' && args.volume.trim().length > 0
          ? args.volume.trim()
          : (typeof args.source === 'string' ? args.source.trim() : '');
        if (source.length === 0) throw new VmError('import-disk needs the source image (a path on the node or a volume id)', 'BAD_ARGUMENT');
        const importNode = await controller.nodeFor(vmid);
        const summary = `Import ${source} into VM ${vmid} on ${importNode} as a new disk on ${storage}. The disk is added unattached (assign it to scsiN/virtioN afterwards).`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'storage_content:import-disk', target: `${name}:vm:${vmid}:import`, risk: 'danger', summary },
          async () => {
            const argv = ['importdisk', vmid, source, storage];
            if (args.format) argv.push('--format', String(args.format));
            const result = await controller.command('qm', argv, {
              timeoutMs: 3_600_000,
              signal: exec?.signal,
            });
            if (result.exitCode !== 0) {
              throw new VmError(`qm importdisk exited with ${result.exitCode}: ${result.stderr || result.stdout}`, 'NODE_COMMAND_FAILED');
            }
            return { instance: name, action, storage, node: importNode, vmid, source, stdout: result.stdout };
          },
        );
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
