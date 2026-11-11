/**
 * LXC operations the base container tool set does not cover: clone, migrate,
 * resize, volume move, template conversion, the feature probe and RRD history.
 *
 * All of these are REST-only; the `pct` CLI has no equivalent for the cluster
 * object half. PVE 7.4 notes (checked with `pvesh usage` on the node):
 *   • `{vmid}/feature` is GET only — it answers "can this CT be snapshotted,
 *     cloned or copied", it does not change container feature flags. Those are
 *     config keys (`features: nesting=1`) and go through `lxc_config`;
 *   • clone, migrate, resize and move_volume fork a task and answer its UPID,
 *     so the call waits for the task before reporting success.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';

const TIMEFRAMES = ['hour', 'day', 'week', 'month', 'year'];
const LXC_DISK = /^(rootfs|mp\d+)$/;
const LXC_VOLUME = /^(rootfs|mp\d+|unused\d+)$/;

/** Normalise the consolidation function to the two values PVE accepts. */
function consolidation(value) {
  const cf = String(value ?? 'AVERAGE').toUpperCase();
  if (cf !== 'AVERAGE' && cf !== 'MAX') throw new VmError(`cf must be AVERAGE or MAX, not "${value}"`, 'BAD_ARGUMENT');
  return cf;
}

/** Wait for the UPID a create call returned and pass it back for the answer. */
async function awaitTask(controller, node, result, options) {
  const upid = typeof result?.json === 'string' ? result.json : result?.stdout;
  if (typeof upid === 'string' && upid.startsWith('UPID:')) {
    await controller.waitTask(node, upid, options);
    return upid;
  }
  return undefined;
}

/** PVE booleans travel as 1/0; leave the value out when the caller did not set it. */
function flag(value) {
  return value === undefined ? undefined : value === true ? 1 : 0;
}

/**
 * Build the extra container tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function lxcExtraTools(deps) {
  return [
    {
      name: 'lxc_clone',
      description:
        'Clone a container (POST /nodes/{node}/lxc/{vmid}/clone). `newid` is required; a normal container is copied ' +
        'fully, a template becomes a linked clone unless full=true. The new id is not checked against allowVmids ' +
        '(the container does not exist yet) — add it to the list before managing it.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'Source container id.' },
        newid: { type: 'number', required: true, description: 'Id for the clone.' },
        hostname: { type: 'string', description: 'Hostname for the new container.' },
        description: { type: 'string', description: 'Description for the new container.' },
        storage: { type: 'string', description: 'Target storage for a full clone.' },
        full: { type: 'boolean', description: 'Create a full copy (default: linked clone for a template).' },
        target: { type: 'string', description: 'Target node (only with shared storage).' },
        pool: { type: 'string', description: 'Pool to add the new container to.' },
        snapname: { type: 'string', description: 'Snapshot to clone from.' },
        bwlimit: { type: 'number', description: 'I/O bandwidth limit in KiB/s.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => textOutput(`CT ${value.vmid} cloned to CT ${value.newid} on ${value.node}${value.upid ? `, task ${value.upid}` : ''}`),
      },
      timeoutMs: 1_800_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const newid = Number(args.newid);
        if (!Number.isInteger(newid) || newid <= 0) throw new VmError('clone needs a positive newid', 'BAD_ARGUMENT');
        if (newid === vmid) throw new VmError('newid must differ from the source container id', 'BAD_ARGUMENT');
        const node = await controller.nodeFor(vmid, { signal: exec?.signal });
        const params = { newid };
        if (args.hostname) params.hostname = String(args.hostname);
        if (args.description) params.description = String(args.description);
        if (args.storage) params.storage = String(args.storage);
        if (args.target) params.target = String(args.target);
        if (args.pool) params.pool = String(args.pool);
        if (args.snapname) params.snapname = String(args.snapname);
        if (args.full !== undefined) params.full = flag(args.full);
        if (args.bwlimit !== undefined) params.bwlimit = Number(args.bwlimit);
        const result = await controller.pvesh('create', `/nodes/${node}/lxc/${vmid}/clone`, {
          params,
          signal: exec?.signal,
          timeoutMs: 1_800_000,
        });
        const upid = await awaitTask(controller, node, result, { signal: exec?.signal, timeoutMs: 1_800_000 });
        return { instance: name, vmid, newid, node, upid };
      },
    },
    {
      name: 'lxc_migrate',
      description:
        'Migrate a container to another cluster node (POST /nodes/{node}/lxc/{vmid}/migrate). The task is awaited. ' +
        'Needs a confirmation token: a failed migration can leave the container stopped on the source.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'Container id.' },
        target: { type: 'string', required: true, description: 'Target node name.' },
        targetStorage: { type: 'string', description: 'Target storage (target-storage).' },
        online: { type: 'boolean', description: 'Use online/live migration.' },
        restart: { type: 'boolean', description: 'Use restart migration.' },
        timeout: { type: 'number', description: 'Shutdown timeout in seconds for a restart migration.' },
        bwlimit: { type: 'number', description: 'I/O bandwidth limit in KiB/s.' },
        confirm: { type: 'string', description: 'The token from the first call.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) =>
          value?.status === 'confirmation-required'
            ? textOutput(value.summary)
            : textOutput(`CT ${value.vmid} migrated from ${value.node} to ${value.target}${value.upid ? `, task ${value.upid}` : ''}`),
      },
      timeoutMs: 3_600_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const target = String(args.target ?? '').trim();
        if (target === '') throw new VmError('migrate needs a target node', 'BAD_ARGUMENT');
        const node = await controller.nodeFor(vmid, { signal: exec?.signal });
        if (target === node) throw new VmError(`target "${target}" is already the container's node`, 'BAD_ARGUMENT');
        const summary = `Migrate container ${vmid} from ${node} to ${target} on ${name}${args.online === true ? ' (live)' : ''}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'lxc_migrate', target: `${name}:lxc:${vmid}`, risk: 'danger', summary },
          async () => {
            const params = { target };
            if (args.targetStorage) params['target-storage'] = String(args.targetStorage);
            if (args.online !== undefined) params.online = flag(args.online);
            if (args.restart !== undefined) params.restart = flag(args.restart);
            if (args.timeout !== undefined) params.timeout = Number(args.timeout);
            if (args.bwlimit !== undefined) params.bwlimit = Number(args.bwlimit);
            const result = await controller.pvesh('create', `/nodes/${node}/lxc/${vmid}/migrate`, {
              params,
              signal: exec?.signal,
              timeoutMs: 3_600_000,
            });
            const upid = await awaitTask(controller, node, result, { signal: exec?.signal, timeoutMs: 3_600_000 });
            return { instance: name, vmid, node, target, upid };
          },
        );
      },
    },
    {
      name: 'lxc_resize',
      description:
        'Resize a container mount point (PUT /nodes/{node}/lxc/{vmid}/resize). `size` is absolute ("32G") or relative ' +
        '("+8G"); PVE refuses shrinking. The task is awaited.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'Container id.' },
        disk: { type: 'string', required: true, description: 'Volume key: rootfs or mpN.' },
        size: { type: 'string', required: true, description: 'New size, for example "+8G" or "32G".' },
        digest: { type: 'string', description: 'Expected config digest (concurrency guard).' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => textOutput(`CT ${value.vmid}: ${value.disk} resized to ${value.size}${value.upid ? `, task ${value.upid}` : ''}`),
      },
      timeoutMs: 900_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const disk = String(args.disk ?? '').trim();
        if (!LXC_DISK.test(disk)) throw new VmError(`disk must be rootfs or mpN, not "${disk}"`, 'BAD_ARGUMENT');
        const size = String(args.size ?? '').trim();
        if (!/^\+?\d+(?:\.\d+)?[KMGT]?$/i.test(size)) throw new VmError(`invalid size "${size}"`, 'BAD_ARGUMENT');
        const node = await controller.nodeFor(vmid, { signal: exec?.signal });
        const params = { disk, size };
        if (args.digest) params.digest = String(args.digest);
        const result = await controller.pvesh('set', `/nodes/${node}/lxc/${vmid}/resize`, {
          params,
          signal: exec?.signal,
          timeoutMs: 900_000,
        });
        const upid = await awaitTask(controller, node, result, { signal: exec?.signal, timeoutMs: 900_000 });
        return { instance: name, vmid, node, disk, size, upid };
      },
    },
    {
      name: 'lxc_move_volume',
      description:
        'Move a rootfs/mp volume to another storage or another container (POST /nodes/{node}/lxc/{vmid}/move_volume). ' +
        '`deleteSource` removes the original (destructive); otherwise it stays as an `unusedN` entry. Needs a ' +
        'confirmation token; the task is awaited.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'Container id.' },
        volume: { type: 'string', required: true, description: 'Volume key to move: rootfs, mpN or unusedN.' },
        storage: { type: 'string', description: 'Target storage (use alone).' },
        targetVmid: { type: 'number', description: 'Target container id (use alone instead of storage).' },
        targetVolume: { type: 'string', description: 'Target volume key (target-volume).' },
        deleteSource: { type: 'boolean', description: 'Delete the original volume after the copy.' },
        digest: { type: 'string', description: 'Expected source config digest.' },
        targetDigest: { type: 'string', description: 'Expected target config digest.' },
        bwlimit: { type: 'number', description: 'I/O bandwidth limit in KiB/s.' },
        confirm: { type: 'string', description: 'The token from the first call.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) =>
          value?.status === 'confirmation-required'
            ? textOutput(value.summary)
            : textOutput(`CT ${value.vmid}: moved ${value.volume}${value.storage ? ` to ${value.storage}` : ''}${value.targetVmid ? ` to CT ${value.targetVmid}` : ''}${value.deleted ? ' (source deleted)' : ''}`),
      },
      timeoutMs: 3_600_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const volume = String(args.volume ?? '').trim();
        if (!LXC_VOLUME.test(volume)) throw new VmError(`volume must be rootfs, mpN or unusedN, not "${volume}"`, 'BAD_ARGUMENT');
        const storage = args.storage ? String(args.storage) : undefined;
        const targetVmid = args.targetVmid === undefined ? undefined : Number(args.targetVmid);
        if (storage === undefined && targetVmid === undefined) {
          throw new VmError('move_volume needs a target storage or a target container id', 'BAD_ARGUMENT');
        }
        if (storage !== undefined && targetVmid !== undefined) {
          throw new VmError('storage and targetVmid are mutually exclusive', 'BAD_ARGUMENT');
        }
        if (targetVmid !== undefined && (!Number.isInteger(targetVmid) || targetVmid <= 0)) {
          throw new VmError('targetVmid must be a positive container id', 'BAD_ARGUMENT');
        }
        if (args.targetVolume !== undefined && !LXC_VOLUME.test(String(args.targetVolume))) {
          throw new VmError('targetVolume must be rootfs, mpN or unusedN', 'BAD_ARGUMENT');
        }
        const node = await controller.nodeFor(vmid, { signal: exec?.signal });
        const destination = storage !== undefined ? `storage "${storage}"` : `container ${targetVmid}`;
        const summary =
          `Move ${volume} of container ${vmid} on ${name} to ${destination}` +
          `${args.deleteSource === true ? ' and delete the source volume' : ''}.`;
        return runGuarded(
          deps.confirms,
          {
            args,
            instance: name,
            action: 'lxc_move_volume',
            target: `${name}:lxc:${vmid}:${volume}`,
            risk: args.deleteSource === true ? 'destroy' : 'danger',
            summary,
          },
          async () => {
            const params = { volume };
            if (storage !== undefined) params.storage = storage;
            if (targetVmid !== undefined) params['target-vmid'] = targetVmid;
            if (args.targetVolume !== undefined) params['target-volume'] = String(args.targetVolume);
            if (args.deleteSource !== undefined) params.delete = flag(args.deleteSource);
            if (args.digest) params.digest = String(args.digest);
            if (args.targetDigest) params['target-digest'] = String(args.targetDigest);
            if (args.bwlimit !== undefined) params.bwlimit = Number(args.bwlimit);
            const result = await controller.pvesh('create', `/nodes/${node}/lxc/${vmid}/move_volume`, {
              params,
              signal: exec?.signal,
              timeoutMs: 3_600_000,
            });
            const upid = await awaitTask(controller, node, result, { signal: exec?.signal, timeoutMs: 3_600_000 });
            return { instance: name, vmid, node, volume, storage, targetVmid, deleted: args.deleteSource === true, upid };
          },
        );
      },
    },
    {
      name: 'lxc_template',
      description:
        'Convert a container into a template (POST /nodes/{node}/lxc/{vmid}/template). A template cannot be started ' +
        'again and there is no API call to undo it; needs a confirmation token.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'Container id.' },
        confirm: { type: 'string', description: 'The token from the first call.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) =>
          value?.status === 'confirmation-required'
            ? textOutput(value.summary)
            : textOutput(`CT ${value.vmid} on ${value.node} is now a template`),
      },
      timeoutMs: 300_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const node = await controller.nodeFor(vmid, { signal: exec?.signal });
        const summary =
          `Convert container ${vmid} on ${name} into a template. It can no longer be started, and PVE 7.4 has no API ` +
          'call to convert it back.';
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'lxc_template', target: `${name}:lxc:${vmid}`, risk: 'destroy', summary },
          async () => {
            await controller.pvesh('create', `/nodes/${node}/lxc/${vmid}/template`, { signal: exec?.signal, timeoutMs: 300_000 });
            return { instance: name, vmid, node, template: true };
          },
        );
      },
    },
    {
      name: 'lxc_feature',
      description:
        'Ask PVE whether a container supports snapshot, clone or copy (GET /nodes/{node}/lxc/{vmid}/feature). PVE 7.4 ' +
        'exposes this check only; container feature flags such as nesting/keyctl are config keys, so set them with ' +
        'lxc_config.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'Container id.' },
        feature: { type: 'string', enum: ['snapshot', 'clone', 'copy'], required: true, description: 'Feature to check.' },
        snapname: { type: 'string', description: 'Snapshot name (optional).' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          const nodes = value.nodes.length > 0 ? ` on ${value.nodes.join(', ')}` : '';
          return textOutput(`CT ${value.vmid} feature "${value.feature}": ${value.supported ? 'supported' : 'NOT supported'}${nodes}`);
        },
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const feature = String(args.feature ?? '');
        if (!['snapshot', 'clone', 'copy'].includes(feature)) throw new VmError(`unknown feature "${feature}"`, 'BAD_ARGUMENT');
        const node = await controller.nodeFor(vmid, { signal: exec?.signal });
        const query = { feature, ...(args.snapname ? { snapname: String(args.snapname) } : {}) };
        const result = await controller.pveshGet(`/nodes/${node}/lxc/${vmid}/feature`, query, { signal: exec?.signal });
        return {
          instance: name,
          vmid,
          node,
          feature,
          supported: Number(result?.hasFeature ?? 0) === 1,
          nodes: Array.isArray(result?.nodes) ? result.nodes : [],
        };
      },
    },
    {
      name: 'lxc_rrddata',
      description:
        'Read container RRD statistics (GET /nodes/{node}/lxc/{vmid}/rrddata): timeframe hour/day/week/month/year and ' +
        'consolidation AVERAGE (default) or MAX.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'Container id.' },
        timeframe: { type: 'string', enum: TIMEFRAMES, description: 'Time frame (default hour).' },
        cf: { type: 'string', description: 'Consolidation function: AVERAGE (default) or MAX.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          const samples = Array.isArray(value.data) ? value.data : [];
          const last = samples.at(-1);
          return textOutput(
            `CT ${value.vmid} RRD ${value.timeframe}/${value.cf}: ${samples.length} samples` +
              (last ? `; last at ${last.time ?? '?'}: ${JSON.stringify(last)}` : ''),
          );
        },
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const timeframe = String(args.timeframe ?? 'hour');
        if (!TIMEFRAMES.includes(timeframe)) throw new VmError(`unknown timeframe "${timeframe}"`, 'BAD_ARGUMENT');
        const cf = consolidation(args.cf);
        const node = await controller.nodeFor(vmid, { signal: exec?.signal });
        const data = await controller.pveshGet(
          `/nodes/${node}/lxc/${vmid}/rrddata`,
          { timeframe, cf },
          { signal: exec?.signal },
        );
        return { instance: name, vmid, node, timeframe, cf, data };
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
