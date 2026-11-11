/**
 * VM lifecycle: power state, creation, destruction.
 *
 * Everything goes through `qm` on the node over ssh — the plugin deliberately
 * has no PVE API token, so the transport is the same one the console and the
 * guest agent already use.
 *
 * Dangerous actions are guarded by lib/confirm.js: the first call performs
 * nothing and returns a token; the second call with that token performs it.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';

/** Which power actions exist, how they are spelled for `qm`, and how risky they are. */
const POWER_ACTIONS = {
  start: { risk: 'safe', args: (id) => ['start', id], note: 'power on' },
  shutdown: {
    risk: 'danger',
    args: (id, timeoutSec) => ['shutdown', id, '--timeout', String(timeoutSec)],
    note: 'graceful shutdown (ACPI); the guest is asked to power off',
  },
  stop: { risk: 'danger', args: (id) => ['stop', id], note: 'hard power off — the guest gets no chance to flush' },
  reboot: { risk: 'danger', args: (id) => ['reboot', id], note: 'graceful reboot' },
  reset: { risk: 'destroy', args: (id) => ['reset', id], note: 'hard reset — like the reset button' },
  suspend: { risk: 'danger', args: (id) => ['suspend', id], note: 'suspend to storage; the VM stops until resumed' },
  resume: { risk: 'safe', args: (id) => ['resume', id], note: 'resume a suspended VM' },
};

/** Read the state line from `qm status`. */
async function statusOf(controller, vmid, signal) {
  const { stdout } = await controller.qm(['status', vmid], { timeoutMs: 20_000, signal });
  return stdout.replace(/^status:\s*/i, '').trim() || 'unknown';
}

/**
 * Build the lifecycle tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function lifecycleTools(deps) {
  return [
    {
      name: 'vm_power',
      description:
        'Power state of a VM: start, shutdown (graceful), stop (hard), reboot, reset (hard), suspend, resume. ' +
        'Actions that interrupt a running guest (shutdown, stop, reboot, reset, suspend) are dangerous and need a second confirmation: ' +
        'the first call changes nothing and returns a token; call again with confirm="<token>".',
      parameters: {
        action: {
          type: 'string',
          enum: ['start', 'shutdown', 'stop', 'reboot', 'reset', 'suspend', 'resume'],
          required: true,
          description: 'What to do with the VM power state.',
        },
        vmid: { type: 'number', required: true, description: 'VM id.' },
        timeoutSec: {
          type: 'number',
          description: 'How long the guest gets for a graceful shutdown, seconds (default 60).',
        },
        confirm: {
          type: 'string',
          description: 'The token returned by the first call. Only pass it when the human asked for this exact operation.',
        },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          return textOutput(`VM ${value.vmid}: ${value.action} done, state ${value.state}`);
        },
      },
      timeoutMs: 600_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = args.vmid;
        const action = POWER_ACTIONS[args.action];
        if (!action) throw new VmError(`unknown power action "${args.action}"`, 'BAD_ARGUMENT');
        const timeoutSec = Math.min(Math.max(Number(args.timeoutSec ?? 60) || 60, 5), 900);
        // The allow list is the plugin's contract: a VM outside it is not ours to
        // power off, exactly like it is not ours to read.
        controller.assertAllowed(vmid);
        const target = `${name}:vm:${vmid}`;
        const summary =
          `Power "${args.action}" on VM ${vmid} of ${name}: ${action.note}.` +
          (args.action === 'shutdown' ? ` The guest gets ${timeoutSec} s before QEMU gives up.` : '');
        const result = await runGuarded(
          deps.confirms,
          { args, instance: name, action: `vm_power:${args.action}`, target, risk: action.risk, summary },
          async () => {
            await controller.qmOk(action.args(vmid, timeoutSec), {
              timeoutMs: (timeoutSec + 60) * 1000,
              signal: exec?.signal,
            });
            const state = await statusOf(controller, vmid, exec?.signal);
            return { vmid, instance: name, action: args.action, state, summary };
          },
        );
        if (result?.status === 'confirmation-required') result.summary = summary;
        return result;
      },
    },
    {
      name: 'vm_create',
      description:
        'Create a new VM on the node: id (defaults to the cluster next id), name, memory, cores, disk, network and an optional ISO. ' +
        'Creating does not destroy anything, so it runs directly; the answer carries the new id.',
      parameters: {
        vmid: { type: 'number', description: 'VM id to use. Omit to take the cluster next free id.' },
        name: { type: 'string', required: true, description: 'VM name (hostname of the guest).' },
        memory: { type: 'number', description: 'RAM in MiB (default 2048).' },
        cores: { type: 'number', description: 'CPU cores (default 2).' },
        ostype: { type: 'string', description: 'PVE ostype (default l26 for Linux, use win11 for Windows).' },
        disk: { type: 'string', description: 'First disk, for example "local-lvm:8" (default).' },
        net: { type: 'string', description: 'First NIC, for example "virtio,bridge=vmbr0" (default).' },
        iso: { type: 'string', description: 'Volume id to attach as a CD-ROM, for example "local:iso/debian.iso".' },
        start: { type: 'boolean', description: 'Start the VM right after creating it (default false).' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) =>
          textOutput(
            `VM ${value.vmid} (${value.name}) created on ${value.instance}` +
              (value.started ? ' and started' : '') +
              `.\n${value.command}`,
          ),
      },
      timeoutMs: 300_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = args.vmid ?? Number(await controller.pveshGet('/cluster/nextid'));
        if (!Number.isInteger(vmid) || vmid <= 0) {
          throw new VmError(`the cluster next id is not usable: ${vmid}`, 'BAD_ARGUMENT');
        }
        const argv = [
          'create',
          vmid,
          '--name',
          args.name,
          '--memory',
          String(args.memory ?? 2048),
          '--cores',
          String(args.cores ?? 2),
          '--ostype',
          args.ostype ?? 'l26',
          '--scsihw',
          'virtio-scsi-pci',
          '--scsi0',
          args.disk ?? 'local-lvm:8',
          '--net0',
          args.net ?? 'virtio,bridge=vmbr0',
        ];
        if (args.iso) argv.push('--ide2', `${args.iso},media=cdrom`);
        await controller.qmOk(argv, { timeoutMs: 120_000, signal: exec?.signal });
        let started = false;
        if (args.start) {
          await controller.qmOk(['start', vmid], { timeoutMs: 120_000, signal: exec?.signal });
          started = true;
        }
        return {
          vmid,
          instance: name,
          name: args.name,
          started,
          command: `qm ${argv.map((part) => (/[\s,]/.test(part) ? `"${part}"` : part)).join(' ')}`,
        };
      },
    },
    {
      name: 'vm_destroy',
      description:
        'Destroy a VM and its disks. This cannot be undone: the first call only returns a confirmation token, ' +
        'the second call with confirm="<token>" performs it. Set purge=true to delete the disks as well.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        purge: { type: 'boolean', description: 'Also delete the VM disks and unused volumes (default true).' },
        confirm: {
          type: 'string',
          description: 'The token from the first call. Only pass it after the human confirmed the destruction.',
        },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) =>
          textOutput(value?.status === 'confirmation-required' ? value.summary : `VM ${value.vmid} destroyed on ${value.instance}`),
      },
      timeoutMs: 600_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const purge = args.purge !== false;
        const summary =
          `Destroy VM ${vmid} on ${name} (its disks are ${purge ? 'DELETED' : 'kept'}). ` +
          'This cannot be undone — a backup or a snapshot must exist if the data matters.';
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'vm_destroy', target: `${name}:vm:${vmid}`, risk: 'destroy', summary },
          async () => {
            await controller.qmOk(['destroy', vmid, ...(purge ? ['--purge'] : [])], {
              timeoutMs: 300_000,
              signal: exec?.signal,
            });
            return { vmid, instance: name, destroyed: true, purged: purge };
          },
        );
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}

export { statusOf };
