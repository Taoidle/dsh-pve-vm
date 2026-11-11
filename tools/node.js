/**
 * Node-level administration: status, package updates, services, tasks, network.
 *
 * All of it is the Proxmox API through `pvesh`; a task-returning call (apt
 * update, service restart) answers with a UPID that `node_task` can follow.
 * Upgrades and service restarts are confirmed second-hand, as usual.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';

/** Pull the UPID out of a `pvesh create` answer. */
function upidOf(stdout) {
  const match = /UPID:[^\s"']+/.exec(stdout ?? '');
  return match ? match[0] : '';
}

/** Keep the overview readable: the raw status carries every CPU flag in a string. */
function summarizeStatus(status) {
  if (status === null || typeof status !== 'object') return status;
  const cpuinfo = status.cpuinfo ?? {};
  return {
    uptime: status.uptime,
    loadavg: status.loadavg,
    idle: status.idle,
    cpu: status.cpu,
    cpuinfo: { model: cpuinfo.model, cores: cpuinfo.cores, cpus: cpuinfo.cpus, mhz: cpuinfo.mhz },
    memory: status.memory ? { total: status.memory.total, used: status.memory.used, free: status.memory.free } : undefined,
    swap: status.swap ? { total: status.swap.total, used: status.swap.used } : undefined,
    rootfs: status.rootfs ? { total: status.rootfs.total, used: status.rootfs.used, free: status.rootfs.free } : undefined,
    pveversion: status.pveversion,
    kversion: status.kversion,
  };
}

/** Shorten a task list for the agent. */
function tasksOf(list, limit = 15) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, limit).map((task) => ({
    upid: task.upid,
    type: task.type,
    status: task.status,
    starttime: task.starttime ? new Date(Number(task.starttime) * 1000).toISOString() : undefined,
    exitstatus: task.exitstatus,
    user: task.user,
  }));
}

/**
 * Build the node tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function nodeTools(deps) {
  return [
    {
      name: 'node_status',
      description:
        'Node overview (uptime, load, memory, PVE/kernel version), pending package updates, services, recent tasks, syslog ' +
        'and network interfaces. Everything here is read-only.',
      parameters: {
        action: {
          type: 'string',
          enum: ['overview', 'apt', 'services', 'tasks', 'syslog', 'network'],
          description: 'What to read (default overview).',
        },
        limit: { type: 'number', description: 'How many tasks or log lines to return (default 15, max 200).' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => textOutput(`${value.action} of ${value.node}:\n${JSON.stringify(value.data, null, 2)}`),
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const node = await controller.nodeName();
        const action = args.action ?? 'overview';
        const limit = Math.min(Math.max(Number(args.limit ?? 15) || 15, 1), 200);
        const signal = exec?.signal;
        let data;
        if (action === 'overview') data = summarizeStatus(await controller.pveshGet(`/nodes/${node}/status`, {}, { signal }));
        else if (action === 'apt') data = await controller.pveshGet(`/nodes/${node}/apt/update`, {}, { signal });
        else if (action === 'services') data = await controller.pveshGet(`/nodes/${node}/services`, {}, { signal });
        else if (action === 'tasks') data = tasksOf(await controller.pveshGet(`/nodes/${node}/tasks`, { limit: 200 }, { signal }), limit);
        else if (action === 'syslog') {
          const entries = await controller.pveshGet(`/nodes/${node}/syslog`, { limit }, { signal });
          data = Array.isArray(entries) ? entries.slice(-limit).map((entry) => entry.t ?? entry) : entries;
        } else if (action === 'network') data = await controller.pveshGet(`/nodes/${node}/network`, {}, { signal });
        else throw new VmError(`unknown node_status action "${action}"`, 'BAD_ARGUMENT');
        return { instance: name, node, action, data };
      },
    },
    {
      name: 'node_apt',
      description:
        'Refresh the package lists or install the pending upgrades on the node. The upgrade is a dangerous operation ' +
        '(a reboot or a PVE restart may follow), so it needs a second confirmation; both answers carry the task UPID.',
      parameters: {
        action: { type: 'string', enum: ['update', 'upgrade'], required: true, description: 'Refresh lists or install updates.' },
        reboot: {
          type: 'boolean',
          description: 'For upgrade: allow PVE to reboot the node afterwards when the upgrade requires it (default false).',
        },
        confirm: { type: 'string', description: 'The token from the first call, for action=upgrade.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) =>
          value?.status === 'confirmation-required'
            ? textOutput(value.summary)
            : textOutput(`node ${value.node}: ${value.action} started${value.upid ? `, task ${value.upid}` : ''}`),
      },
      timeoutMs: 300_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const node = await controller.nodeName();
        const action = args.action;
        if (action === 'update') {
          const result = await controller.pvesh('create', `/nodes/${node}/apt/update`, { signal: exec?.signal });
          if (result.exitCode !== 0) throw new VmError(`apt update failed: ${result.stderr || result.stdout}`, 'NODE_COMMAND_FAILED');
          return { instance: name, node, action, upid: upidOf(result.stdout) };
        }
        const summary =
          `Run the pending package upgrades on node ${node} (${name}). ` +
          'A PVE major upgrade can restart services or require a reboot; running VMs normally stay up, but the node may miss a maintenance window.';
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'node_apt:upgrade', target: `${name}:node:${node}`, risk: 'danger', summary },
          async () => {
            const result = await controller.pvesh('create', `/nodes/${node}/apt/upgrade`, {
              params: { reboot: args.reboot ? 1 : 0 },
              signal: exec?.signal,
              timeoutMs: 600_000,
            });
            if (result.exitCode !== 0) throw new VmError(`apt upgrade failed: ${result.stderr || result.stdout}`, 'NODE_COMMAND_FAILED');
            return { instance: name, node, action, upid: upidOf(result.stdout) };
          },
        );
      },
    },
    {
      name: 'node_service',
      description:
        'Node services (pveproxy, pvedaemon, pve-cluster, ssh, …): list them or start/stop/restart/reload one. ' +
        'Stop, restart and reload are dangerous — pveproxy is how the web UI is reached — and need a second confirmation.',
      parameters: {
        action: { type: 'string', enum: ['list', 'start', 'stop', 'restart', 'reload'], required: true, description: 'Service action.' },
        name: { type: 'string', description: 'Service name for everything except list, for example "pveproxy".' },
        confirm: { type: 'string', description: 'The token from the first call, for stop/restart/reload.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.action === 'list') {
            const lines = (value.services ?? []).map(
              (service) => `${service.name}: ${service.state ?? service.status ?? 'unknown'}${service.enabled ? ', enabled' : ''}`,
            );
            return textOutput(`services on ${value.node}:\n${lines.join('\n') || 'none'}`);
          }
          return textOutput(`node ${value.node}: service ${value.name} ${value.action} requested${value.upid ? `, task ${value.upid}` : ''}`);
        },
      },
      timeoutMs: 300_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const node = await controller.nodeName();
        if (args.action === 'list') {
          const services = await controller.pveshGet(`/nodes/${node}/services`, {}, { signal: exec?.signal });
          return { instance: name, node, action: 'list', services };
        }
        const service = typeof args.name === 'string' ? args.name.trim() : '';
        if (!/^[A-Za-z0-9@._-]+$/.test(service)) throw new VmError(`invalid service name "${service}"`, 'BAD_ARGUMENT');
        const safe = args.action === 'start';
        const summary = `${args.action} the service ${service} on node ${node} (${name}).`;
        return runGuarded(
          deps.confirms,
          {
            args,
            instance: name,
            action: `node_service:${args.action}`,
            target: `${name}:node:${node}:${service}`,
            risk: safe ? 'safe' : 'danger',
            summary,
          },
          async () => {
            const result = await controller.pvesh('create', `/nodes/${node}/services/${service}/${args.action}`, {
              signal: exec?.signal,
              timeoutMs: 120_000,
            });
            if (result.exitCode !== 0) {
              throw new VmError(
                `${args.action} ${service} failed: ${result.stderr || result.stdout}`,
                'NODE_COMMAND_FAILED',
              );
            }
            return { instance: name, node, name: service, action: args.action, upid: upidOf(result.stdout) };
          },
        );
      },
    },
    {
      name: 'node_task',
      description:
        'Follow an asynchronous node task by its UPID: status, log, or stop it. Stopping a task is dangerous and needs a second confirmation.',
      parameters: {
        upid: { type: 'string', required: true, description: 'The task UPID, for example UPID:pve1:000A1B2C:…' },
        action: { type: 'string', enum: ['status', 'log', 'stop'], description: 'What to do with the task (default status).' },
        confirm: { type: 'string', description: 'The token from the first call, for action=stop.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) =>
          value?.status === 'confirmation-required'
            ? textOutput(value.summary)
            : textOutput(`${value.action} of ${value.upid}:\n${JSON.stringify(value.data ?? value.result, null, 2)}`),
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const node = await controller.nodeName();
        const upid = typeof args.upid === 'string' ? args.upid.trim() : '';
        if (!upid.startsWith('UPID:')) throw new VmError('a task is addressed by its UPID, which starts with "UPID:"', 'BAD_ARGUMENT');
        const action = args.action ?? 'status';
        const path = `/nodes/${node}/tasks/${upid}`;
        if (action === 'status') {
          const data = await controller.pveshGet(`${path}/status`, {}, { signal: exec?.signal });
          return { instance: name, upid, action, data };
        }
        if (action === 'log') {
          const data = await controller.pveshGet(`${path}/log`, { limit: 500 }, { signal: exec?.signal });
          return { instance: name, upid, action, data };
        }
        const summary = `Stop the node task ${upid} on ${node} (${name}). The action it performs may be left half-done.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'node_task:stop', target: `${name}:task:${upid}`, risk: 'danger', summary },
          async () => {
            const result = await controller.pvesh('delete', `${path}/stop`, { signal: exec?.signal });
            if (result.exitCode !== 0) throw new VmError(`stopping the task failed: ${result.stderr || result.stdout}`, 'NODE_COMMAND_FAILED');
            return { instance: name, upid, action, result: 'stop requested' };
          },
        );
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
