/**
 * Cluster-wide administration the base cluster tool does not cover:
 * HA resources and groups, replication jobs, cluster options, metric
 * servers and the cluster task list.
 *
 * Everything here is a cluster object (`/cluster/...`), so the same token
 * rules apply: reads run directly, every write goes through `runGuarded`.
 * HA rules and the legacy InfluxDB endpoint exist only on newer releases;
 * those actions answer `available: false` instead of failing the tool.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';
import {
  assignments,
  flag,
  isUnavailable,
  matchText,
  nodeOf,
  numberParam,
  requireText,
  segment,
  unavailable,
} from '../lib/admin-util.js';

/** HA states accepted by the API. */
const HA_STATES = ['disabled', 'enabled', 'ignored', 'started', 'stopped'];

/** The fields a HA resource may carry. */
function haResourceParams(args, { creating = false } = {}) {
  const params = {};
  if (creating) {
    params.sid = matchText(args.sid, 'sid', /^(?:vm|ct):[A-Za-z0-9._-]+$|^[0-9]{3,}$/, 'use vm:100, ct:100 or the guest id');
    if (args.type !== undefined) params.type = String(args.type);
  }
  for (const key of ['comment', 'group', 'state']) {
    if (args[key] !== undefined) params[key] = String(args[key]);
  }
  for (const key of ['max_relocate', 'max_restart']) {
    if (args[key] !== undefined) params[key] = numberParam(args[key], key, { min: 0, integer: true });
  }
  if (args.delete !== undefined) params.delete = String(args.delete);
  if (args.digest !== undefined) params.digest = String(args.digest);
  return params;
}

/** The fields a HA group may carry. */
function haGroupParams(args, { creating = false } = {}) {
  const params = {};
  if (creating) {
    params.group = matchText(args.group, 'group', /^[A-Za-z][A-Za-z0-9_-]*$/, 'letters, digits, dash and underscore');
    params.nodes = requireText(args.nodes, 'nodes');
  } else {
    if (args.nodes !== undefined) params.nodes = requireText(args.nodes, 'nodes');
    if (args.delete !== undefined) params.delete = String(args.delete);
    if (args.digest !== undefined) params.digest = String(args.digest);
  }
  if (args.comment !== undefined) params.comment = String(args.comment);
  for (const key of ['nofailback', 'restricted']) {
    if (args[key] !== undefined) params[key] = flag(args[key]);
  }
  return params;
}

/** Describe one HA resource. */
function describeResource(resource) {
  return `${resource.sid}: ${resource.state ?? 'started'}${resource.group ? ` in ${resource.group}` : ''}`;
}

/**
 * Build the extra cluster tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function clusterExtraTools(deps) {
  return [
    {
      name: 'cluster_ha',
      description:
        'High availability: list/get/create/update/delete resources, list/get/create/update/delete groups, read the ' +
        'current CRM status, and list HA rules. Rules exist only on newer PVE releases; the action then answers ' +
        'available:false. Writes need a confirmation token.',
      parameters: {
        action: {
          type: 'string',
          enum: [
            'list',
            'get',
            'create',
            'update',
            'delete',
            'status',
            'groups',
            'group-get',
            'group-create',
            'group-update',
            'group-delete',
            'rules',
          ],
          required: true,
          description: 'HA operation.',
        },
        sid: { type: 'string', description: 'HA resource id, for example "vm:100" or "100" (resource actions).' },
        type: { type: 'string', enum: ['ct', 'vm'], description: 'Resource type (list filter, or create when the sid is ambiguous).' },
        group: { type: 'string', description: 'HA group id (group actions).' },
        nodes: { type: 'string', description: 'HA group nodes with optional priority, for example "pve1:1,pve2".' },
        comment: { type: 'string', description: 'Description for a resource or group.' },
        state: { type: 'string', enum: HA_STATES, description: 'Requested resource state.' },
        max_relocate: { type: 'number', description: 'How often a failed service is relocated.' },
        max_restart: { type: 'number', description: 'How often a failed service is restarted on the same node.' },
        nofailback: { type: 'boolean', description: 'Do not migrate back to a higher-priority node.' },
        restricted: { type: 'boolean', description: 'Only run members on the group\'s nodes.' },
        delete: { type: 'string', description: 'Comma-separated settings to delete (update actions).' },
        digest: { type: 'string', description: 'Only apply if the current configuration still has this digest.' },
        confirm: { type: 'string', description: 'The token from the first call, for create, update and delete.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.available === false) return textOutput(value.note);
          if (args.action === 'status') {
            const lines = (value.status ?? []).map((entry) => `${entry.id ?? entry.type}: ${entry.status ?? entry.state ?? '?'}`);
            return textOutput(`HA status:\n${lines.join('\n') || 'no HA state'}`);
          }
          if (args.action === 'groups') {
            const lines = (value.groups ?? []).map((group) => `${group.group}: ${group.nodes ?? 'no nodes'}${group.restricted ? ' (restricted)' : ''}`);
            return textOutput(`HA groups:\n${lines.join('\n') || 'none'}`);
          }
          if (args.action === 'list') {
            const lines = (value.resources ?? []).map(describeResource);
            return textOutput(`HA resources:\n${lines.join('\n') || 'none'}`);
          }
          if (args.action === 'rules') {
            const lines = (value.rules ?? []).map((rule) => `${rule.rule ?? rule.id ?? '?'}: ${rule.type ?? ''} ${rule.resources ?? ''}`.trim());
            return textOutput(`HA rules:\n${lines.join('\n') || 'none'}`);
          }
          if (value.resource) return textOutput(describeResource(value.resource));
          if (value.group_config) return textOutput(`HA group ${value.group_config.group}: ${value.group_config.nodes ?? 'no nodes'}`);
          return textOutput(`HA ${value.action} done${value.sid ? ` for ${value.sid}` : ''}${value.group ? ` for group ${value.group}` : ''}`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        const signal = exec?.signal;
        if (action === 'list') {
          const params = args.type !== undefined ? { type: String(args.type) } : {};
          const resources = await controller.pveshGet('/cluster/ha/resources', params, { signal });
          return { instance: name, action, resources: Array.isArray(resources) ? resources : [] };
        }
        if (action === 'status') {
          const status = await controller.pveshGet('/cluster/ha/status/current', {}, { signal });
          return { instance: name, action, status: Array.isArray(status) ? status : [] };
        }
        if (action === 'groups') {
          const groups = await controller.pveshGet('/cluster/ha/groups', {}, { signal });
          return { instance: name, action, groups: Array.isArray(groups) ? groups : [] };
        }
        if (action === 'rules') {
          try {
            const rules = await controller.pveshGet('/cluster/ha/rules', {}, { signal });
            return { instance: name, action, available: true, rules: Array.isArray(rules) ? rules : [] };
          } catch (error) {
            if (!isUnavailable(error)) throw error;
            return { instance: name, action, ...unavailable('HA rules', 'HA rules exist only on PVE 8.x; this node is older.') };
          }
        }
        if (action.startsWith('group-')) {
          if (action === 'group-create') {
            const params = haGroupParams(args, { creating: true });
            const summary = `Create HA group ${params.group} with nodes ${params.nodes}.`;
            return runGuarded(
              deps.confirms,
              { args, instance: name, action: 'cluster_ha:group-create', target: `${name}:ha-group:${params.group}`, risk: 'danger', summary },
              async () => {
                await controller.pvesh('create', '/cluster/ha/groups', { params, signal });
                return { instance: name, action, group: params.group };
              },
            );
          }
          const group = matchText(args.group, 'group', /^[A-Za-z][A-Za-z0-9_-]*$/, 'letters, digits, dash and underscore');
          if (action === 'group-get') {
            const config = await controller.pveshGet(`/cluster/ha/groups/${segment(group)}`, {}, { signal });
            return { instance: name, action, group, group_config: config };
          }
          if (action === 'group-delete') {
            const summary = `Delete HA group ${group}: resources bound to it lose their placement rule.`;
            return runGuarded(
              deps.confirms,
              { args, instance: name, action: 'cluster_ha:group-delete', target: `${name}:ha-group:${group}`, risk: 'destroy', summary },
              async () => {
                await controller.pvesh('delete', `/cluster/ha/groups/${segment(group)}`, { signal });
                return { instance: name, action, group };
              },
            );
          }
          const params = haGroupParams(args);
          if (Object.keys(params).length === 0) throw new VmError('action=group-update needs at least one field', 'BAD_ARGUMENT');
          const summary = `Change HA group ${group}: ${Object.entries(params).map(([key, value]) => `${key}=${value}`).join(', ')}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'cluster_ha:group-update', target: `${name}:ha-group:${group}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('set', `/cluster/ha/groups/${segment(group)}`, { params, signal });
              return { instance: name, action, group };
            },
          );
        }
        if (action === 'create') {
          const params = haResourceParams(args, { creating: true });
          const summary = `Create HA resource ${params.sid}${params.state ? ` in state ${params.state}` : ''}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'cluster_ha:create', target: `${name}:ha-resource:${params.sid}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('create', '/cluster/ha/resources', { params, signal });
              return { instance: name, action, sid: params.sid };
            },
          );
        }
        const sid = matchText(args.sid, 'sid', /^(?:vm|ct):[A-Za-z0-9._-]+$|^[0-9]{3,}$/, 'use vm:100, ct:100 or the guest id');
        if (action === 'get') {
          const resource = await controller.pveshGet(`/cluster/ha/resources/${segment(sid)}`, {}, { signal });
          return { instance: name, action, sid, resource };
        }
        if (action === 'delete') {
          const summary = `Delete HA resource ${sid}: the guest keeps running, but it is no longer managed by HA.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'cluster_ha:delete', target: `${name}:ha-resource:${sid}`, risk: 'destroy', summary },
            async () => {
              await controller.pvesh('delete', `/cluster/ha/resources/${segment(sid)}`, { signal });
              return { instance: name, action, sid };
            },
          );
        }
        const params = haResourceParams(args);
        if (Object.keys(params).length === 0) throw new VmError('action=update needs at least one field', 'BAD_ARGUMENT');
        const summary = `Change HA resource ${sid}: ${Object.entries(params).map(([key, value]) => `${key}=${value}`).join(', ')}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'cluster_ha:update', target: `${name}:ha-resource:${sid}`, risk: 'danger', summary },
          async () => {
            await controller.pvesh('set', `/cluster/ha/resources/${segment(sid)}`, { params, signal });
            return { instance: name, action, sid };
          },
        );
      },
    },
    {
      name: 'cluster_replication',
      description:
        'Storage replication jobs: list/get/create/update/delete them, or trigger one now. A job needs an id, a target ' +
        'node and a schedule; creating, changing and deleting are cluster-level writes and need a confirmation token.',
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update', 'delete', 'schedule_now'],
          required: true,
          description: 'Replication operation.',
        },
        id: { type: 'string', description: 'Job id, "<guest>-<jobnum>", for example "104-0".' },
        target: { type: 'string', description: 'Target node for create.' },
        schedule: { type: 'string', description: 'Systemd calendar schedule, for example "*/15".' },
        type: { type: 'string', enum: ['local'], description: 'Replication plugin type (only "local" on PVE 7.x).' },
        comment: { type: 'string', description: 'Description.' },
        disable: { type: 'boolean', description: 'Disable the job.' },
        rate: { type: 'number', description: 'Rate limit in MB/s.' },
        source: { type: 'string', description: 'Source node (usually detected from the guest).' },
        remove_job: { type: 'string', enum: ['local', 'full'], description: 'Mark the job for removal.' },
        delete: { type: 'string', description: 'Comma-separated settings to delete (update only).' },
        digest: { type: 'string', description: 'Only apply if the configuration still has this digest.' },
        force: { type: 'boolean', description: 'Remove the job record without cleanup (delete only).' },
        keep: { type: 'boolean', description: 'Keep replicated data at the target (delete only).' },
        node: { type: 'string', description: 'Node to run schedule_now on (default: this instance\'s node).' },
        confirm: { type: 'string', description: 'The token from the first call, for create, update and delete.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (args.action === 'list') {
            const lines = (value.jobs ?? []).map((job) => `${job.id}: ${job.source ?? '?'} → ${job.target ?? '?'}${job.schedule ? `, ${job.schedule}` : ''}${job.disable ? ', disabled' : ''}`);
            return textOutput(`replication jobs:\n${lines.join('\n') || 'none'}`);
          }
          if (value.job) {
            return textOutput(`replication ${value.job.id ?? value.id}: ${value.job.source ?? '?'} → ${value.job.target ?? '?'}, ${value.job.schedule ?? 'manual'}${value.job.disable ? ', disabled' : ''}`);
          }
          if (args.action === 'schedule_now') return textOutput(`replication ${value.id} started now on ${value.node}`);
          return textOutput(`replication ${value.action} done${value.id ? `: ${value.id}` : ''}`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        const signal = exec?.signal;
        if (action === 'list') {
          const jobs = await controller.pveshGet('/cluster/replication', {}, { signal });
          return { instance: name, action, jobs: Array.isArray(jobs) ? jobs : [] };
        }
        const id = matchText(args.id, 'id', /^[1-9][0-9]{2,8}-[0-9]{1,9}$/, 'the format is <guest>-<jobnum>, for example 104-0');
        if (action === 'get') {
          const job = await controller.pveshGet(`/cluster/replication/${segment(id)}`, {}, { signal });
          return { instance: name, action, id, job };
        }
        if (action === 'schedule_now') {
          const node = await nodeOf(controller, args);
          await controller.pvesh('create', `/nodes/${segment(node)}/replication/${segment(id)}/schedule_now`, { signal });
          return { instance: name, action, id, node };
        }
        if (action === 'create') {
          const target = matchText(args.target, 'target', /^[A-Za-z0-9][A-Za-z0-9.-]*$/, 'a node name');
          const schedule = requireText(args.schedule, 'schedule');
          const params = { id, target, schedule, type: args.type ?? 'local' };
          for (const key of ['comment', 'source']) if (args[key] !== undefined) params[key] = String(args[key]);
          if (args.disable !== undefined) params.disable = flag(args.disable);
          if (args.rate !== undefined) params.rate = numberParam(args.rate, 'rate', { min: 1 });
          const summary = `Create replication job ${id}: ${params.source ?? 'the guest\'s node'} → ${target} every "${schedule}".`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'cluster_replication:create', target: `${name}:replication:${id}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('create', '/cluster/replication', { params, signal });
              return { instance: name, action, id, target };
            },
          );
        }
        if (action === 'delete') {
          const params = {};
          if (args.force !== undefined) params.force = flag(args.force);
          if (args.keep !== undefined) params.keep = flag(args.keep);
          const summary = `Delete replication job ${id}: its snapshots are cleaned up on the next run (force skips that cleanup).`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'cluster_replication:delete', target: `${name}:replication:${id}`, risk: 'destroy', summary },
            async () => {
              await controller.pvesh('delete', `/cluster/replication/${segment(id)}`, { params, signal });
              return { instance: name, action, id };
            },
          );
        }
        const params = {};
        for (const key of ['comment', 'schedule', 'source', 'delete', 'digest', 'remove_job']) {
          if (args[key] !== undefined) params[key] = String(args[key]);
        }
        if (args.disable !== undefined) params.disable = flag(args.disable);
        if (args.rate !== undefined) params.rate = numberParam(args.rate, 'rate', { min: 1 });
        if (Object.keys(params).length === 0) throw new VmError('action=update needs at least one field', 'BAD_ARGUMENT');
        const summary = `Change replication job ${id}: ${Object.entries(params).map(([key, value]) => `${key}=${value}`).join(', ')}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'cluster_replication:update', target: `${name}:replication:${id}`, risk: 'danger', summary },
          async () => {
            await controller.pvesh('set', `/cluster/replication/${segment(id)}`, { params, signal });
            return { instance: name, action, id };
          },
        );
      },
    },
    {
      name: 'cluster_options',
      description:
        'Datacenter options (`/cluster/options`): read them, or change them with "key=value" assignments. Changes affect ' +
        'the whole cluster and need a confirmation token.',
      parameters: {
        action: { type: 'string', enum: ['get', 'set'], required: true, description: 'Read or change the options.' },
        changes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Assignments for set, for example ["language=en", "console=xtermjs"].',
        },
        delete: { type: 'string', description: 'Comma-separated option names to reset (set only).' },
        confirm: { type: 'string', description: 'The token from the first call, for set.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (args.action === 'get') {
            const lines = Object.entries(value.options ?? {}).map(([key, entry]) => `${key}=${entry}`);
            return textOutput(`cluster options:\n${lines.join('\n') || 'none'}`);
          }
          return textOutput(`cluster options changed: ${(value.changed ?? []).join(', ')}`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        if (args.action === 'get') {
          const options = await controller.pveshGet('/cluster/options', {}, { signal: exec?.signal });
          return { instance: name, action: 'get', options };
        }
        const params = assignments(args.changes);
        if (args.delete !== undefined) params.delete = String(args.delete);
        if (Object.keys(params).length === 0) throw new VmError('action=set needs changes or delete', 'BAD_ARGUMENT');
        const summary = `Change cluster options: ${Object.entries(params).map(([key, value]) => `${key}=${value || '(reset)'}`).join(', ')}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'cluster_options:set', target: `${name}:cluster-options`, risk: 'danger', summary },
          async () => {
            await controller.pvesh('set', '/cluster/options', { params, signal: exec?.signal });
            return { instance: name, action: 'set', changed: Object.keys(params) };
          },
        );
      },
    },
    {
      name: 'cluster_metrics',
      description:
        'External metric servers (`/cluster/metrics/server`): list/get/create/update/delete them, or read/write the ' +
        'legacy InfluxDB endpoint. The legacy endpoint does not exist on PVE 7.x and answers available:false. Writes ' +
        'need a confirmation token.',
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update', 'delete', 'influxdb', 'influxdb-set'],
          required: true,
          description: 'Metric server operation.',
        },
        id: { type: 'string', description: 'Metric server id.' },
        type: { type: 'string', enum: ['influxdb', 'graphite'], description: 'Plugin type for create.' },
        server: { type: 'string', description: 'Server DNS name or IP.' },
        port: { type: 'number', description: 'Server port.' },
        changes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra settings for create/update/influxdb-set, for example ["token=abc", "organization=lab"].',
        },
        delete: { type: 'string', description: 'Comma-separated settings to delete (update/influxdb-set).' },
        confirm: { type: 'string', description: 'The token from the first call, for create, update, delete and influxdb-set.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.available === false) return textOutput(value.note);
          if (args.action === 'list') {
            const lines = (value.servers ?? []).map((entry) => `${entry.id}: ${entry.type ?? '?'} → ${entry.server ?? '?'}:${entry.port ?? '?'}${entry.disable ? ', disabled' : ''}`);
            return textOutput(`metric servers:\n${lines.join('\n') || 'none'}`);
          }
          if (args.action === 'influxdb') {
            const lines = Object.entries(value.config ?? {}).map(([key, entry]) => `${key}=${entry}`);
            return textOutput(`legacy InfluxDB settings:\n${lines.join('\n') || 'none'}`);
          }
          if (value.config) return textOutput(`metric server ${value.id}: ${value.config.type ?? '?'} → ${value.config.server ?? '?'}:${value.config.port ?? '?'}`);
          return textOutput(`metric server ${value.action} done${value.id ? `: ${value.id}` : ''}`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        const signal = exec?.signal;
        if (action === 'list') {
          const servers = await controller.pveshGet('/cluster/metrics/server', {}, { signal });
          return { instance: name, action, servers: Array.isArray(servers) ? servers : [] };
        }
        if (action === 'influxdb' || action === 'influxdb-set') {
          try {
            const config = await controller.pveshGet('/cluster/metrics/influxdb', {}, { signal });
            if (action === 'influxdb') return { instance: name, action, available: true, config };
          } catch (error) {
            if (!isUnavailable(error)) throw error;
            return {
              instance: name,
              action,
              ...unavailable('the legacy InfluxDB metrics endpoint', 'PVE 7.x only has /cluster/metrics/server; use cluster_metrics with a server entry instead.'),
            };
          }
          const params = assignments(args.changes);
          if (args.delete !== undefined) params.delete = String(args.delete);
          if (Object.keys(params).length === 0) throw new VmError('action=influxdb-set needs changes or delete', 'BAD_ARGUMENT');
          const summary = `Change the legacy InfluxDB metrics settings: ${Object.keys(params).join(', ')}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'cluster_metrics:influxdb-set', target: `${name}:metrics:influxdb`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('set', '/cluster/metrics/influxdb', { params, signal });
              return { instance: name, action, available: true, changed: Object.keys(params) };
            },
          );
        }
        const id = matchText(args.id, 'id', /^[A-Za-z][A-Za-z0-9_-]*$/, 'letters, digits, dash and underscore');
        if (action === 'get') {
          const config = await controller.pveshGet(`/cluster/metrics/server/${segment(id)}`, {}, { signal });
          return { instance: name, action, id, config };
        }
        if (action === 'delete') {
          const summary = `Delete metric server ${id}: monitoring data stops being exported.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'cluster_metrics:delete', target: `${name}:metrics:${id}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('delete', `/cluster/metrics/server/${segment(id)}`, { signal });
              return { instance: name, action, id };
            },
          );
        }
        const extra = assignments(args.changes);
        if (action === 'create') {
          const type = requireText(args.type, 'type');
          const server = requireText(args.server, 'server');
          const port = numberParam(args.port, 'port', { min: 1, max: 65535, integer: true });
          const params = { id, type, server, port, ...extra };
          const summary = `Create ${type} metric server ${id} → ${server}:${port}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'cluster_metrics:create', target: `${name}:metrics:${id}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('create', '/cluster/metrics/server', { params, signal });
              return { instance: name, action, id };
            },
          );
        }
        const current = await controller.pveshGet(`/cluster/metrics/server/${segment(id)}`, {}, { signal });
        const params = {
          server: requireText(args.server ?? current.server, 'server'),
          port: numberParam(args.port ?? current.port, 'port', { min: 1, max: 65535, integer: true }),
          ...extra,
        };
        if (args.delete !== undefined) params.delete = String(args.delete);
        const summary = `Change metric server ${id}: ${Object.entries(params).map(([key, value]) => `${key}=${value}`).join(', ')}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'cluster_metrics:update', target: `${name}:metrics:${id}`, risk: 'danger', summary },
          async () => {
            await controller.pvesh('set', `/cluster/metrics/server/${segment(id)}`, { params, signal });
            return { instance: name, action, id };
          },
        );
      },
    },
    {
      name: 'cluster_tasks',
      description:
        'The cluster-wide task list (`/cluster/tasks`), read-only. PVE 7.4 accepts no filter parameters, so the ' +
        'filters are applied to the returned list; newest tasks come first.',
      parameters: {
        type: { type: 'string', description: 'Only tasks of this type (qmstart, vzdump, …).' },
        status: { type: 'string', description: 'Only tasks with this status (running, OK, …).' },
        user: { type: 'string', description: 'Only tasks started by this user.' },
        node: { type: 'string', description: 'Only tasks on this node.' },
        vmid: { type: 'string', description: 'Only tasks whose guest id matches.' },
        limit: { type: 'number', description: 'Maximum tasks to return (default 50, max 500).' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          const lines = (value.tasks ?? []).map((task) => `${task.upid}: ${task.type ?? '?'} ${task.id ?? ''} ${task.status ?? '?'} on ${task.node ?? '?'} by ${task.user ?? '?'}`);
          return textOutput(`cluster tasks (${value.tasks?.length ?? 0} of ${value.total ?? 0}):\n${lines.join('\n') || 'none'}`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const all = await controller.pveshGet('/cluster/tasks', {}, { signal: exec?.signal });
        let tasks = Array.isArray(all) ? all : [];
        const matches = (value, filter) => filter === undefined || String(value ?? '') === String(filter);
        tasks = tasks.filter((task) =>
          matches(task.type, args.type) &&
          matches(task.status, args.status) &&
          matches(task.user, args.user) &&
          matches(task.node, args.node) &&
          matches(task.id, args.vmid),
        );
        const total = tasks.length;
        tasks.sort((left, right) => Number(right.starttime ?? 0) - Number(left.starttime ?? 0));
        const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 500);
        return { instance: name, total, tasks: tasks.slice(0, limit) };
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
