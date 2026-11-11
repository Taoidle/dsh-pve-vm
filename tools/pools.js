/**
 * Resource pools and VM templates.
 *
 * A pool groups guests and storages for permissions and for the panel's "pool"
 * column; a template is a VM that can be cloned but not started. Both are
 * cluster records, so they go through the API and not through `qm`.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';

/**
 * Build the pool and template tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function poolTools(deps) {
  return [
    {
      name: 'pve_pool',
      description:
        'Resource pools: list (with members), create, update membership or delete. Deleting a pool does not delete its ' +
        'guests, but it does drop every permission granted through the pool, so it needs a second confirmation.',
      parameters: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], required: true, description: 'Pool operation.' },
        pool: { type: 'string', description: 'Pool id (for update and delete, and to list one pool in detail).' },
        comment: { type: 'string', description: 'Free-text comment (create/update).' },
        vms: { type: 'string', description: 'Guest ids to put in the pool, comma separated (update; replaces the members).' },
        storage: { type: 'string', description: 'Storage ids to put in the pool, comma separated (update).' },
        confirm: { type: 'string', description: 'The token from the first call, for delete.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.action === 'list') {
            const lines = (value.pools ?? []).map(
              (pool) => `${pool.poolid}${pool.comment ? ` — ${pool.comment}` : ''}${Array.isArray(pool.members) ? `: ${pool.members.map((member) => member.id).join(', ') || 'empty'}` : ''}`,
            );
            return textOutput(`pools:\n${lines.join('\n') || 'none'}`);
          }
          return textOutput(`pool ${value.pool}: ${value.action} done`);
        },
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        if (action === 'list') {
          const pools = await controller.pveshGet('/pools', {}, { signal: exec?.signal });
          const poolId = typeof args.pool === 'string' ? args.pool.trim() : '';
          if (poolId.length > 0) {
            const detail = await controller.pveshGet(`/pools/${encodeURIComponent(poolId)}`, {}, { signal: exec?.signal });
            return { instance: name, action, pools: [detail] };
          }
          return { instance: name, action, pools: Array.isArray(pools) ? pools : [] };
        }
        if (action === 'create') {
          const poolId = typeof args.pool === 'string' ? args.pool.trim() : '';
          if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(poolId)) throw new VmError('action=create needs a pool id', 'BAD_ARGUMENT');
          const params = { poolid: poolId };
          if (args.comment) params.comment = String(args.comment);
          await controller.pvesh('create', '/pools', { params, signal: exec?.signal });
          return { instance: name, action, pool: poolId };
        }
        const poolId = typeof args.pool === 'string' ? args.pool.trim() : '';
        if (poolId.length === 0) throw new VmError(`action=${action} needs the pool id`, 'BAD_ARGUMENT');
        if (action === 'delete') {
          const summary = `Delete pool ${poolId}. The guests stay, but every permission granted through this pool stops applying.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_pool:delete', target: `${name}:pool:${poolId}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('delete', `/pools/${encodeURIComponent(poolId)}`, { signal: exec?.signal });
              return { instance: name, action, pool: poolId };
            },
          );
        }
        const params = {};
        if (args.vms !== undefined) params.vms = String(args.vms);
        if (args.storage !== undefined) params.storage = String(args.storage);
        if (args.comment !== undefined) params.comment = String(args.comment);
        if (Object.keys(params).length === 0) throw new VmError('action=update needs vms, storage or comment', 'BAD_ARGUMENT');
        await controller.pvesh('set', `/pools/${encodeURIComponent(poolId)}`, { params, signal: exec?.signal });
        return { instance: name, action, pool: poolId };
      },
    },
    {
      name: 'vm_template',
      description:
        'List the templates in the cluster, or turn a VM into a template. A template cannot be started any more, so the ' +
        'conversion needs a second confirmation (clear the template flag in the configuration to undo it).',
      parameters: {
        action: { type: 'string', enum: ['list', 'convert'], required: true, description: 'Template operation.' },
        vmid: { type: 'number', description: 'VM id (required for convert).' },
        confirm: { type: 'string', description: 'The token from the first call, for convert.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.action === 'list') {
            const lines = (value.templates ?? []).map((entry) => `VM ${entry.vmid} ${entry.name ?? ''} — on ${entry.node}`);
            return textOutput(`templates:\n${lines.join('\n') || 'none'}`);
          }
          return textOutput(`VM ${value.vmid} on ${value.node} is now a template`);
        },
      },
      timeoutMs: 180_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        if (args.action === 'list') {
          const resources = await controller.pveshGet('/cluster/resources', { type: 'vm' }, { signal: exec?.signal });
          const templates = (Array.isArray(resources) ? resources : [])
            .filter((entry) => entry.type === 'qemu' && entry.template === 1)
            .map((entry) => ({ vmid: Number(entry.vmid), name: entry.name, node: entry.node }));
          return { instance: name, action: 'list', templates };
        }
        const vmid = controller.assertAllowed(args.vmid);
        const node = await controller.nodeFor(vmid);
        const summary = `Turn VM ${vmid} on ${name} into a template. It can be cloned from now on but not started, and the template flag must be cleared in the configuration to undo this.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'vm_template:convert', target: `${name}:vm:${vmid}`, risk: 'danger', summary },
          async () => {
            await controller.pvesh('create', `/nodes/${node}/qemu/${vmid}/template`, { signal: exec?.signal, timeoutMs: 120_000 });
            return { instance: name, vmid, node, action: 'convert' };
          },
        );
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
