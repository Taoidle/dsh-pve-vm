/**
 * Cluster view and the generic API escape hatch.
 *
 * The typed tools cover the operations an agent needs every day; Proxmox has
 * hundreds of endpoints more (SDN, HA, Ceph, firewall, access control). `pve_api`
 * reaches them through `pvesh` with the same confirmation rule: reads are free,
 * writes need the token from a first call.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, parseAssignments, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';

/** API paths the generic tool accepts: absolute, no spaces, no control characters. */
const API_PATH = /^\/[A-Za-z0-9/_.~-]+$/;

/**
 * Build the cluster and generic-API tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function clusterTools(deps) {
  return [
    {
      name: 'cluster_status',
      description:
        'Cluster view: quorum and members, resources (VMs, storage, nodes), the node list, the next free VM id, and HA ' +
        'resources. Read-only — it works the same on a standalone node.',
      parameters: {
        action: {
          type: 'string',
          enum: ['status', 'resources', 'nodes', 'nextid', 'ha'],
          description: 'What to read (default status).',
        },
        type: {
          type: 'string',
          enum: ['vm', 'storage', 'node', 'sdn'],
          description: 'Resource type filter for action=resources.',
        },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => textOutput(`${value.action} of the cluster around ${value.instance}:\n${JSON.stringify(value.data, null, 2)}`),
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action ?? 'status';
        const signal = exec?.signal;
        let data;
        if (action === 'status') data = await controller.pveshGet('/cluster/status', {}, { signal });
        else if (action === 'resources') {
          data = await controller.pveshGet('/cluster/resources', args.type ? { type: args.type } : {}, { signal });
        } else if (action === 'nodes') data = await controller.pveshGet('/nodes', {}, { signal });
        else if (action === 'nextid') data = await controller.pveshGet('/cluster/nextid', {}, { signal });
        else if (action === 'ha') data = await controller.pveshGet('/cluster/ha/resources', {}, { signal });
        else throw new VmError(`unknown cluster action "${action}"`, 'BAD_ARGUMENT');
        return { instance: name, action, data };
      },
    },
    {
      name: 'pve_api',
      description:
        'Call any Proxmox API endpoint through pvesh — the escape hatch for what the typed tools do not cover (access ' +
        'control, HA, Ceph, SDN, firewall, replication). GET is read-only and runs directly; create/set/delete are dangerous ' +
        'and need a second confirmation. Example: path "/cluster/resources" or "/nodes/pve1/qemu/100/firewall/options".',
      parameters: {
        method: { type: 'string', enum: ['get', 'create', 'set', 'delete'], required: true, description: 'API verb.' },
        path: { type: 'string', required: true, description: 'API path starting with "/", without the host name.' },
        params: {
          type: 'array',
          items: { type: 'string' },
          description: 'Parameters as "key=value" (for example ["vmid=100", "force=1"]).',
        },
        confirm: { type: 'string', description: 'The token from the first call, for create/set/delete.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) =>
          value?.status === 'confirmation-required'
            ? textOutput(value.summary)
            : textOutput(`${value.method.toUpperCase()} ${value.path} on ${value.instance}:\n${JSON.stringify(value.body ?? value.stdout, null, 2)}`),
      },
      timeoutMs: 300_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const method = String(args.method).toLowerCase();
        const path = String(args.path ?? '').trim();
        if (!API_PATH.test(path)) throw new VmError(`invalid API path "${path}"`, 'BAD_ARGUMENT');
        const params = Object.fromEntries(parseAssignments(args.params).map((pair) => [pair.key, pair.value]));
        if (method === 'get') {
          const body = await controller.pveshGet(path, params, { signal: exec?.signal });
          return { instance: name, method, path, body };
        }
        const summary =
          `Call ${method.toUpperCase()} ${path} on ${name} with ` +
          `${Object.keys(params).length ? JSON.stringify(params) : 'no parameters'}. ` +
          'This endpoint is not covered by a typed tool, so review what it changes before confirming.';
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: `pve_api:${method}`, target: `${name}:api:${path}`, risk: 'danger', summary },
          async () => {
            const result = await controller.pvesh(method, path, { params, signal: exec?.signal });
            if (result.exitCode !== 0) {
              throw new VmError(`${method} ${path} failed: ${result.stderr || result.stdout}`, 'NODE_COMMAND_FAILED');
            }
            return { instance: name, method, path, stdout: result.stdout, json: result.json };
          },
        );
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
