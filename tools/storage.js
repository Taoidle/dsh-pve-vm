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

/** Detached volumes PVE keeps as `unusedN` until they are unlinked. */
const UNUSED_SLOT = /^unused\d+$/;

/** Extract the configured and detached volumes from a VM config object. */
function disksOf(config) {
  if (config === null || typeof config !== 'object') return [];
  return Object.entries(config)
    .filter(([key]) => DISK_SLOT.test(key) || UNUSED_SLOT.test(key))
    .map(([slot, value]) => ({ slot, value: String(value), unused: UNUSED_SLOT.test(slot) }));
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
        'Disks of a VM and their storage: list the disk slots (including detached `unusedN` volumes), rescan for new ' +
        'volumes, resize or move a disk, trim, attach or detach a CD-ROM ISO, unlink volumes, and delete a pending ' +
        'configuration change. Resize, move, detach, unlink and pending-delete need a second confirmation; rescan and ' +
        'trim are safe.',
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'rescan', 'resize', 'move', 'trim', 'attach-iso', 'detach-iso', 'unlink', 'pending-delete'],
          required: true,
          description: 'Disk operation.',
        },
        vmid: { type: 'number', required: true, description: 'VM id.' },
        slot: {
          type: 'string',
          description: 'Disk slot for resize/move/trim/attach-iso/detach-iso, for example "scsi0" or "ide2".',
        },
        slots: {
          type: 'string',
          description: 'Comma-separated disk ids for unlink, for example "scsi1,unused0".',
        },
        key: {
          type: 'string',
          description: 'Configuration key for pending-delete, for example "scsi1".',
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
            const lines = (value.disks ?? []).map(
              (disk) => `${disk.slot}: ${disk.value}${disk.unused ? ' (unused/detached)' : ''}`,
            );
            return textOutput(`VM ${value.vmid} disks:\n${lines.join('\n') || 'no disk slots found'}`);
          }
          if (args.action === 'unlink') {
            return textOutput(`VM ${value.vmid}: unlinked ${value.slots.join(', ')}`);
          }
          if (args.action === 'pending-delete') {
            return textOutput(`VM ${value.vmid}: deleted pending change "${value.key}"`);
          }
          return textOutput(`VM ${value.vmid}: ${value.action} done${value.slot ? ` on ${value.slot}` : ''}`);
        },
      },
      timeoutMs: 900_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid);
        const node = await controller.nodeFor(vmid);
        const action = args.action;
        if (action === 'list') {
          const config = await controller.pveshGet(`/nodes/${node}/qemu/${vmid}/config`, {}, { signal: exec?.signal });
          return { vmid, instance: name, disks: disksOf(config) };
        }
        if (action === 'rescan') {
          await controller.qmOk(['rescan', '--vmid', vmid], { timeoutMs: 300_000, signal: exec?.signal });
          return { vmid, instance: name, action };
        }
        if (action === 'unlink') {
          const slots = String(args.slots ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry !== '');
          if (slots.length === 0) throw new VmError('unlink needs at least one disk id in slots', 'BAD_ARGUMENT');
          for (const entry of slots) {
            if (!DISK_SLOT.test(entry) && !UNUSED_SLOT.test(entry)) {
              throw new VmError(`invalid disk id "${entry}" for unlink`, 'BAD_ARGUMENT');
            }
          }
          const summary =
            `Delete ${slots.join(', ')} from VM ${vmid} on ${name}: the volume data is removed from storage and ` +
            'cannot be restored without a backup.';
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'vm_disk:unlink', target: `${name}:vm:${vmid}:${slots.join(',')}`, risk: 'destroy', summary },
            async () => {
              // PVE 7.4 registers `{vmid}/unlink` as PUT (pvesh set), not POST.
              await controller.pvesh('set', `/nodes/${node}/qemu/${vmid}/unlink`, {
                params: { idlist: slots.join(',') },
                signal: exec?.signal,
                timeoutMs: 900_000,
              });
              return { vmid, instance: name, action, slots };
            },
          );
        }
        if (action === 'pending-delete') {
          const key = typeof args.key === 'string' ? args.key.trim() : '';
          if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(key)) {
            throw new VmError(`invalid configuration key "${key}" for pending-delete`, 'BAD_ARGUMENT');
          }
          // PVE 7.4 has no DELETE on /pending; `qm set --delete key` is the same
          // operation and is what the API exposes (PUT /config with `delete`).
          const summary =
            `Delete the pending configuration change "${key}" of VM ${vmid} on ${name}. On a running VM PVE queues ` +
            'the deletion for the next start; on a stopped VM the value is removed immediately.';
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'vm_disk:pending-delete', target: `${name}:vm:${vmid}:${key}`, risk: 'destroy', summary },
            async () => {
              await controller.pvesh('set', `/nodes/${node}/qemu/${vmid}/config`, {
                params: { delete: key },
                signal: exec?.signal,
                timeoutMs: 300_000,
              });
              const pending = await controller.pveshGet(`/nodes/${node}/qemu/${vmid}/pending`, {}, { signal: exec?.signal });
              return { vmid, instance: name, action, key, pending };
            },
          );
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
