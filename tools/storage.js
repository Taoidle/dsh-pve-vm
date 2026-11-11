/**
 * Disks, ISO images and storage.
 *
 * `qm` covers the per-VM operations (rescan, resize, move, trim, attach/detach a
 * CD-ROM); `pvesh` lists the node's storages. Resizing, moving and detaching are
 * destructive in the sense that a mistake loses data, so they are confirmed.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';

/** Disk slot names in a VM config. */
const DISK_SLOT = /^(ide|sata|scsi|virtio)\d+$/;

/** Extract the disk slots from a VM config object. */
function disksOf(config) {
  if (config === null || typeof config !== 'object') return [];
  return Object.entries(config)
    .filter(([key]) => DISK_SLOT.test(key))
    .map(([slot, value]) => ({ slot, value: String(value) }));
}

/**
 * Build the storage tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function storageTools(deps) {
  return [
    {
      name: 'vm_disk',
      description:
        'Disks of a VM and their storage: list the disk slots, rescan for new volumes, resize or move a disk, trim, and ' +
        'attach or detach a CD-ROM ISO. Resize, move and detach need a second confirmation; rescan and trim are safe.',
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'rescan', 'resize', 'move', 'trim', 'attach-iso', 'detach-iso'],
          required: true,
          description: 'Disk operation.',
        },
        vmid: { type: 'number', required: true, description: 'VM id.' },
        slot: {
          type: 'string',
          description: 'Disk slot for resize/move/trim/attach-iso/detach-iso, for example "scsi0" or "ide2".',
        },
        size: { type: 'string', description: 'New size for resize, for example "+8G" or "32G".' },
        storage: { type: 'string', description: 'Target storage for move, for example "local-lvm".' },
        iso: {
          type: 'string',
          description: 'Volume id for attach-iso, for example "local:iso/debian-13.iso".',
        },
        deleteSource: { type: 'boolean', description: 'Remove the source volume after a move (default false).' },
        confirm: { type: 'string', description: 'The token from the first call, for the destructive actions.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (args.action === 'list') {
            const lines = (value.disks ?? []).map((disk) => `${disk.slot}: ${disk.value}`);
            return textOutput(`VM ${value.vmid} disks:\n${lines.join('\n') || 'no disk slots found'}`);
          }
          return textOutput(`VM ${value.vmid}: ${value.action} done${value.slot ? ` on ${value.slot}` : ''}`);
        },
      },
      timeoutMs: 900_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const node = await controller.nodeName();
        const action = args.action;
        if (action === 'list') {
          const config = await controller.pveshGet(`/nodes/${node}/qemu/${vmid}/config`, {}, { signal: exec?.signal });
          return { vmid, instance: name, disks: disksOf(config) };
        }
        if (action === 'rescan') {
          await controller.qmOk(['rescan', '--vmid', vmid], { timeoutMs: 300_000, signal: exec?.signal });
          return { vmid, instance: name, action };
        }
        const slot = typeof args.slot === 'string' ? args.slot.trim() : '';
        if (!DISK_SLOT.test(slot)) throw new VmError(`invalid disk slot "${slot}"`, 'BAD_ARGUMENT');
        if (action === 'trim') {
          await controller.qmOk(['trim', vmid, slot], { timeoutMs: 900_000, signal: exec?.signal });
          return { vmid, instance: name, action, slot };
        }
        if (action === 'resize' && !args.size) throw new VmError('resize needs a size, for example "+8G"', 'BAD_ARGUMENT');
        if (action === 'move' && !args.storage) throw new VmError('move needs a target storage', 'BAD_ARGUMENT');
        if (action === 'attach-iso' && !args.iso) throw new VmError('attach-iso needs an iso volume id', 'BAD_ARGUMENT');
        const summaries = {
          resize: () => `Resize ${slot} of VM ${vmid} on ${name} to ${args.size}. Shrinking is refused by PVE, growing is final for the guest until it resizes its filesystem.`,
          move: () => `Move ${slot} of VM ${vmid} on ${name} to storage "${args.storage}"${args.deleteSource ? ' and delete the source volume' : ''}.`,
          'attach-iso': () => `Attach ${args.iso} as ${slot} (CD-ROM) to VM ${vmid} on ${name}.`,
          'detach-iso': () => `Detach ${slot} from VM ${vmid} on ${name}; the ISO itself stays in storage.`,
        };
        return runGuarded(
          deps.confirms,
          {
            args,
            instance: name,
            action: `vm_disk:${action}`,
            target: `${name}:vm:${vmid}:${slot}`,
            risk: action === 'move' ? 'destroy' : 'danger',
            summary: summaries[action]?.() ?? `${action} on ${slot}`,
          },
          async () => {
            if (action === 'resize') {
              await controller.qmOk(['resize', vmid, slot, args.size], { timeoutMs: 300_000, signal: exec?.signal });
            } else if (action === 'move') {
              await controller.qmOk(
                ['move-disk', vmid, slot, args.storage, ...(args.deleteSource ? ['--delete', '1'] : [])],
                { timeoutMs: 900_000, signal: exec?.signal },
              );
            } else if (action === 'attach-iso') {
              await controller.qmOk(['set', vmid, `--${slot}`, `${args.iso},media=cdrom`], {
                timeoutMs: 120_000,
                signal: exec?.signal,
              });
            } else if (action === 'detach-iso') {
              await controller.qmOk(['set', vmid, '--delete', slot], { timeoutMs: 120_000, signal: exec?.signal });
            }
            return { vmid, instance: name, action, slot };
          },
        );
      },
    },
    {
      name: 'node_storage',
      description: 'Storages visible to the node: id, type, content types, whether it is active, and used/total space.',
      parameters: {},
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          const lines = (value.storages ?? []).map(
            (store) =>
              `${store.storage} (${store.type}): ${store.content ?? ''}; ` +
              `${store.active ? 'active' : 'inactive'}; ` +
              `${store.used !== undefined ? `${Math.round(Number(store.used) / 2 ** 30)} GiB used` : 'no usage'}` +
              `${store.total ? ` of ${Math.round(Number(store.total) / 2 ** 30)} GiB` : ''}`,
          );
          return textOutput(`Storages on ${value.instance} (${value.node}):\n${lines.join('\n') || 'none'}`);
        },
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const node = await controller.nodeName();
        const storages = await controller.pveshGet(`/nodes/${node}/storage`, {}, { signal: exec?.signal });
        return { instance: name, node, storages };
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
