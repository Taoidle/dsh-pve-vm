/**
 * Node administration beyond `node_status`: DNS, time, physical disks, APT
 * repositories, /etc/hosts, Wake-on-LAN, the batch executor, RRD data and
 * the diagnostic report.
 *
 * The API paths here are node-scoped (`/nodes/<node>/...`), so every tool takes
 * an optional `node` and otherwise uses the instance's node. Writes are
 * confirmed; `node_execute` is `destroy` because it can run arbitrary API
 * calls (and, in shell mode, arbitrary commands).
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';
import {
  flag,
  isUnavailable,
  matchText,
  nodeOf,
  numberParam,
  optionalText,
  requireBlock,
  requireText,
  segment,
  unavailable,
} from '../lib/admin-util.js';

/** Time frames the RRD endpoint accepts. */
const TIMEFRAMES = ['hour', 'day', 'week', 'month', 'year'];

/** Normalize a disk argument to an absolute /dev path. */
function diskDevice(value) {
  const disk = matchText(value, 'disk', /^(?:\/dev\/)?[A-Za-z0-9][A-Za-z0-9/._-]*$/, 'for example /dev/sda');
  return disk.startsWith('/dev/') ? disk : `/dev/${disk}`;
}

/** The batch entries the execute endpoint accepts. */
function commandBatch(commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new VmError('mode=api needs a non-empty commands array', 'BAD_ARGUMENT');
  }
  return commands.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') throw new VmError(`commands[${index}] must be an object`, 'BAD_ARGUMENT');
    const path = requireText(entry.path, `commands[${index}].path`);
    if (!/^\/[A-Za-z0-9/_.~:-]*$/.test(path)) throw new VmError(`commands[${index}].path "${path}" is not an API path`, 'BAD_ARGUMENT');
    const method = String(entry.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
      throw new VmError(`commands[${index}].method must be GET, POST, PUT or DELETE`, 'BAD_ARGUMENT');
    }
    const out = { path, method };
    if (entry.args !== undefined) {
      if (entry.args === null || typeof entry.args !== 'object' || Array.isArray(entry.args)) {
        throw new VmError(`commands[${index}].args must be an object`, 'BAD_ARGUMENT');
      }
      out.args = entry.args;
    }
    return out;
  });
}

/**
 * Build the extra node tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function nodeExtraTools(deps) {
  return [
    {
      name: 'node_dns',
      description: 'The node\'s resolver settings (`/nodes/<node>/dns`): read them, or set the search domain and up to three servers. Setting needs a confirmation token.',
      parameters: {
        action: { type: 'string', enum: ['get', 'set'], required: true, description: 'Read or change the DNS settings.' },
        node: { type: 'string', description: 'Node name (default: this instance\'s node).' },
        search: { type: 'string', description: 'Search domain (required for set).' },
        dns1: { type: 'string', description: 'First DNS server.' },
        dns2: { type: 'string', description: 'Second DNS server.' },
        dns3: { type: 'string', description: 'Third DNS server.' },
        confirm: { type: 'string', description: 'The token from the first call, for set.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (args.action === 'get') {
            const dns = value.dns ?? {};
            const servers = [dns.dns1, dns.dns2, dns.dns3].filter((entry) => entry !== undefined && entry !== '');
            return textOutput(`DNS on ${value.node}: search ${dns.search ?? '(none)'}, servers ${servers.join(', ') || '(none)'}`);
          }
          return textOutput(`DNS on ${value.node} changed.`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const node = await nodeOf(controller, args);
        if (args.action === 'get') {
          const dns = await controller.pveshGet(`/nodes/${segment(node)}/dns`, {}, { signal: exec?.signal });
          return { instance: name, node, action: 'get', dns };
        }
        const search = requireText(args.search, 'search');
        const params = { search };
        for (const key of ['dns1', 'dns2', 'dns3']) {
          if (args[key] !== undefined) params[key] = requireText(args[key], key);
        }
        const summary = `Set DNS on ${node}: search ${search}${params.dns1 ? `, servers ${[params.dns1, params.dns2, params.dns3].filter(Boolean).join(', ')}` : ''}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'node_dns:set', target: `${name}:node:${node}:dns`, risk: 'danger', summary },
          async () => {
            await controller.pvesh('set', `/nodes/${segment(node)}/dns`, { params, signal: exec?.signal });
            return { instance: name, node, action: 'set', changed: Object.keys(params) };
          },
        );
      },
    },
    {
      name: 'node_time',
      description: 'The node\'s timezone (`/nodes/<node>/time`): read it, or set the timezone. Setting needs a confirmation token.',
      parameters: {
        action: { type: 'string', enum: ['get', 'set'], required: true, description: 'Read or change the timezone.' },
        node: { type: 'string', description: 'Node name (default: this instance\'s node).' },
        timezone: { type: 'string', description: 'IANA timezone, for example "Asia/Shanghai" (required for set).' },
        confirm: { type: 'string', description: 'The token from the first call, for set.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (args.action === 'get') return textOutput(`time on ${value.node}: ${value.time?.timezone ?? '?'} (${value.time?.localtime ?? '?'})`);
          return textOutput(`timezone on ${value.node} set to ${value.timezone}.`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const node = await nodeOf(controller, args);
        if (args.action === 'get') {
          const time = await controller.pveshGet(`/nodes/${segment(node)}/time`, {}, { signal: exec?.signal });
          return { instance: name, node, action: 'get', time };
        }
        const timezone = matchText(args.timezone, 'timezone', /^[A-Za-z][A-Za-z0-9_+/-]*$/, 'an IANA name such as Asia/Shanghai');
        const summary = `Set the timezone on ${node} to ${timezone}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'node_time:set', target: `${name}:node:${node}:time`, risk: 'danger', summary },
          async () => {
            await controller.pvesh('set', `/nodes/${segment(node)}/time`, { params: { timezone }, signal: exec?.signal });
            return { instance: name, node, action: 'set', timezone };
          },
        );
      },
    },
    {
      name: 'node_disks',
      description: 'Physical disks of the node: list them, read SMART for one disk, or list ZFS pools, LVM volume groups and directory storages. Read-only.',
      parameters: {
        action: { type: 'string', enum: ['list', 'smart', 'zfs', 'lvm', 'directory'], required: true, description: 'Disk view.' },
        node: { type: 'string', description: 'Node name (default: this instance\'s node).' },
        disk: { type: 'string', description: 'Disk device for action=smart, for example /dev/sda (or "sda").' },
        healthonly: { type: 'boolean', description: 'For SMART: only return the health assessment.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (args.action === 'list') {
            const lines = (value.disks ?? []).map((disk) => `${disk.devpath}: ${disk.model ?? '?'} ${disk.size ?? ''} ${disk.health ?? ''}`.trim());
            return textOutput(`disks on ${value.node}:\n${lines.join('\n') || 'none'}`);
          }
          if (args.action === 'smart') {
            const smart = value.smart ?? {};
            return textOutput(`SMART ${value.disk} on ${value.node}: ${smart.health ?? smart.status ?? JSON.stringify(smart)}`);
          }
          return textOutput(`${args.action} on ${value.node}: ${JSON.stringify(value.entries ?? value.result ?? [])}`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const node = await nodeOf(controller, args);
        const signal = exec?.signal;
        if (args.action !== 'smart') {
          const entries = await controller.pveshGet(`/nodes/${segment(node)}/disks/${args.action}`, {}, { signal });
          const rows = Array.isArray(entries) ? entries : [];
          return args.action === 'list'
            ? { instance: name, node, action: args.action, disks: rows }
            : { instance: name, node, action: args.action, entries: rows };
        }
        const disk = diskDevice(args.disk);
        const params = { disk };
        if (args.healthonly !== undefined) params.healthonly = flag(args.healthonly);
        const smart = await controller.pveshGet(`/nodes/${segment(node)}/disks/smart`, params, { signal });
        return { instance: name, node, action: 'smart', disk, smart };
      },
    },
    {
      name: 'node_apt_repos',
      description:
        'APT repositories of the node: read the configured files, add a standard repository by handle, or enable/disable ' +
        'one entry. Writes need a confirmation token.',
      parameters: {
        action: { type: 'string', enum: ['get', 'add-standard', 'toggle'], required: true, description: 'Repository operation.' },
        node: { type: 'string', description: 'Node name (default: this instance\'s node).' },
        handle: { type: 'string', description: 'Repository handle for add-standard (as reported by get).' },
        index: { type: 'number', description: 'Entry index inside the file, starting at 0 (toggle).' },
        path: { type: 'string', description: 'Containing file path (toggle).' },
        enabled: { type: 'boolean', description: 'Whether the entry should be enabled (toggle).' },
        digest: { type: 'string', description: 'Only apply if the repository state still has this digest.' },
        confirm: { type: 'string', description: 'The token from the first call, for writes.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (args.action === 'get') {
            const files = value.repositories?.files ?? [];
            const lines = files.map((file) => `${file.path}: ${(file.repositories ?? []).length} entries`);
            return textOutput(`APT repositories on ${value.node}:\n${lines.join('\n') || 'none'}`);
          }
          return textOutput(`APT repositories on ${value.node}: ${value.action} done.`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const node = await nodeOf(controller, args);
        if (args.action === 'get') {
          const repositories = await controller.pveshGet(`/nodes/${segment(node)}/apt/repositories`, {}, { signal: exec?.signal });
          return { instance: name, node, action: 'get', repositories };
        }
        if (args.action === 'add-standard') {
          const handle = requireText(args.handle, 'handle');
          const params = { handle };
          if (args.digest !== undefined) params.digest = String(args.digest);
          const summary = `Add the standard APT repository "${handle}" on ${node}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'node_apt_repos:add-standard', target: `${name}:node:${node}:apt`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('set', `/nodes/${segment(node)}/apt/repositories`, { params, signal: exec?.signal });
              return { instance: name, node, action: 'add-standard', handle };
            },
          );
        }
        if (typeof args.enabled !== 'boolean') throw new VmError('action=toggle needs enabled (true or false)', 'BAD_ARGUMENT');
        const path = requireText(args.path, 'path');
        const index = numberParam(args.index, 'index', { min: 0, integer: true });
        const enabled = args.enabled;
        const params = { path, index, enabled: enabled ? 1 : 0 };
        if (args.digest !== undefined) params.digest = String(args.digest);
        const summary = `${enabled ? 'Enable' : 'Disable'} APT repository ${path}[${index}] on ${node}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'node_apt_repos:toggle', target: `${name}:node:${node}:apt`, risk: 'danger', summary },
          async () => {
            await controller.pvesh('create', `/nodes/${segment(node)}/apt/repositories`, { params, signal: exec?.signal });
            return { instance: name, node, action: 'toggle', path, index, enabled };
          },
        );
      },
    },
    {
      name: 'node_hosts',
      description:
        'The node\'s /etc/hosts: read it (with the digest), or write the whole file. Replacing and deleting are exposed ' +
        'for newer PVE releases; on 7.4 those endpoints do not exist and answer available:false. Writes need a token.',
      parameters: {
        action: { type: 'string', enum: ['get', 'write', 'replace', 'delete'], required: true, description: 'Hosts operation.' },
        node: { type: 'string', description: 'Node name (default: this instance\'s node).' },
        data: { type: 'string', description: 'The complete new /etc/hosts content (write/replace).' },
        digest: { type: 'string', description: 'Only apply if the file still has this digest.' },
        confirm: { type: 'string', description: 'The token from the first call, for writes.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.available === false) return textOutput(value.note);
          if (args.action === 'get') return textOutput(`/etc/hosts on ${value.node}:\n${value.hosts?.data ?? ''}`);
          return textOutput(`/etc/hosts on ${value.node}: ${value.action} done.`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const node = await nodeOf(controller, args);
        if (args.action === 'get') {
          const hosts = await controller.pveshGet(`/nodes/${segment(node)}/hosts`, {}, { signal: exec?.signal });
          return { instance: name, node, action: 'get', hosts };
        }
        const data = args.action === 'delete' ? undefined : requireBlock(args.data, 'data', 65536);
        const params = {};
        if (data !== undefined) params.data = data;
        if (args.digest !== undefined) params.digest = String(args.digest);
        const verb = args.action === 'write' ? 'create' : args.action === 'replace' ? 'set' : 'delete';
        const summary = `${args.action === 'delete' ? 'Delete' : 'Write'} /etc/hosts on ${node}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: `node_hosts:${args.action}`, target: `${name}:node:${node}:hosts`, risk: 'danger', summary },
          async () => {
            try {
              await controller.pvesh(verb, `/nodes/${segment(node)}/hosts`, { params, signal: exec?.signal });
              return { instance: name, node, action: args.action };
            } catch (error) {
              if (verb === 'create' || !isUnavailable(error)) throw error;
              return { instance: name, node, action: args.action, ...unavailable(`hosts ${args.action}`, 'This PVE release only has POST /nodes/<node>/hosts; use action=write.') };
            }
          },
        );
      },
    },
    {
      name: 'node_wakeonlan',
      description: 'Send a Wake-on-LAN packet from the node to wake a machine by MAC address. The API takes no parameters.',
      parameters: {
        node: { type: 'string', description: 'Node to send the packet from (default: this instance\'s node).' },
        mac: { type: 'string', description: 'MAC address to wake, for example aa:bb:cc:dd:ee:ff (used in the answer only).' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => textOutput(`Wake-on-LAN packet sent from ${value.node}${value.mac ? ` for ${value.mac}` : ''}.`),
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const node = await nodeOf(controller, args);
        const mac = optionalText(args.mac);
        if (mac !== undefined && !/^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$/.test(mac)) {
          throw new VmError(`mac "${mac}" is not a MAC address`, 'BAD_ARGUMENT');
        }
        await controller.pvesh('create', `/nodes/${segment(node)}/wakeonlan`, { signal: exec?.signal });
        return { instance: name, node, mac };
      },
    },
    {
      name: 'node_execute',
      description:
        'Run a batch of API calls on the node through POST /nodes/<node>/execute. Despite the name, PVE 7.x accepts an ' +
        'array of {path, method, args} API requests, not shell commands. mode=shell is a plugin-only extension that runs ' +
        'the script over ssh. Both modes can change anything, so both need a destroy-level confirmation token.',
      parameters: {
        mode: { type: 'string', enum: ['api', 'shell'], description: 'api (default) uses the execute endpoint; shell runs over ssh.' },
        node: { type: 'string', description: 'Node name (default: this instance\'s node).' },
        commands: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              path: { type: 'string', required: true, description: 'API path, for example /version.' },
              method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP verb (default GET).' },
              args: { type: 'object', additionalProperties: true, description: 'Request parameters.' },
            },
          },
          description: 'API batch for mode=api.',
        },
        script: { type: 'string', description: 'Shell script for mode=shell (runs as root on the node).' },
        confirm: { type: 'string', description: 'The token from the first call.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.mode === 'shell') return textOutput(`shell on ${value.node} exited ${value.exitCode}:\n${value.stdout}${value.stderr ? `\n[stderr]\n${value.stderr}` : ''}`);
          const lines = (value.results ?? []).map((entry) => `${entry.status}: ${JSON.stringify(entry.data)}`);
          return textOutput(`batch on ${value.node}:\n${lines.join('\n') || '(no results)'}`);
        },
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const node = await nodeOf(controller, args);
        const mode = args.mode ?? 'api';
        const summary = mode === 'shell'
          ? `Run a shell script as root on ${node} (arbitrary commands).`
          : `Run ${Array.isArray(args.commands) ? args.commands.length : 0} arbitrary API call(s) on ${node}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: `node_execute:${mode}`, target: `${name}:node:${node}:execute`, risk: 'destroy', summary },
          async () => {
            if (mode === 'shell') {
              const script = requireBlock(args.script, 'script', 65536);
              const result = await controller.shell(script, { signal: exec?.signal });
              return { instance: name, node, mode, ...result };
            }
            const batch = commandBatch(args.commands);
            const result = await controller.pvesh('create', `/nodes/${segment(node)}/execute`, {
              params: { commands: JSON.stringify(batch) },
              signal: exec?.signal,
              timeoutMs: 120_000,
            });
            return { instance: name, node, mode, results: result.json ?? [] };
          },
        );
      },
    },
    {
      name: 'node_rrddata',
      description: 'Round-robin performance data for the node (`/nodes/<node>/rrddata`) over a fixed time frame. Read-only.',
      parameters: {
        node: { type: 'string', description: 'Node name (default: this instance\'s node).' },
        timeframe: { type: 'string', enum: TIMEFRAMES, required: true, description: 'Time frame to read.' },
        cf: { type: 'string', enum: ['AVERAGE', 'MAX'], description: 'Consolidation function.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => textOutput(`RRD on ${value.node} (${value.timeframe}): ${(value.data ?? []).length} samples`) ,
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const node = await nodeOf(controller, args);
        if (!TIMEFRAMES.includes(args.timeframe)) throw new VmError('timeframe must be hour, day, week, month or year', 'BAD_ARGUMENT');
        const params = { timeframe: args.timeframe };
        if (args.cf !== undefined) params.cf = String(args.cf);
        const data = await controller.pveshGet(`/nodes/${segment(node)}/rrddata`, params, { signal: exec?.signal });
        return { instance: name, node, timeframe: args.timeframe, data: Array.isArray(data) ? data : [] };
      },
    },
    {
      name: 'node_diagnostics',
      description:
        'A diagnostic report for the node. PVE 7.4 has no /nodes/<node>/diagnostics endpoint, so this falls back to ' +
        '/nodes/<node>/report (pveversion, hosts, APT, CPU, storage) and labels the source in the answer.',
      parameters: {
        node: { type: 'string', description: 'Node name (default: this instance\'s node).' },
        maxChars: { type: 'number', description: 'Truncate the report to this many characters (default 20000).' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => textOutput(`${value.source} for ${value.node}${value.truncated ? ' (truncated)' : ''}:\n${value.report}`),
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const node = await nodeOf(controller, args);
        let source = 'diagnostics';
        let report;
        try {
          report = await controller.pveshGet(`/nodes/${segment(node)}/diagnostics`, {}, { signal: exec?.signal, timeoutMs: 120_000 });
        } catch (error) {
          if (!isUnavailable(error)) throw error;
          source = 'report';
          report = await controller.pveshGet(`/nodes/${segment(node)}/report`, {}, { signal: exec?.signal, timeoutMs: 120_000 });
        }
        const text = typeof report === 'string' ? report : JSON.stringify(report, null, 2);
        const maxChars = Math.min(Math.max(Number(args.maxChars ?? 20000), 1000), 200000);
        return {
          instance: name,
          node,
          source,
          note: source === 'report' ? 'The API has no /diagnostics endpoint on this PVE release; this is /nodes/<node>/report.' : undefined,
          truncated: text.length > maxChars,
          report: text.slice(0, maxChars),
        };
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
