/**
 * Host device passthrough: PCI (hostpciN) and USB (usbN).
 *
 * The node lists come from `/nodes/{node}/hardware/{pci,usb}`; attaching and
 * detaching is a normal VM config write (`PUT /nodes/{node}/qemu/{vmid}/config`)
 * with `hostpciN`/`usbN`, or with `delete=<key>` to remove one. Detaching the
 * last passthrough device is what restores migration support, so the removal is
 * the destructive half and needs its own confirmation.
 *
 * PVE 7.4 limits: hostpci slots 0–15, usb slots 0–13. PCI changes require the
 * VM to be stopped; USB may hotplug depending on the guest.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';

const MAX_HOSTPCI = 16;
const MAX_USB = 14;

/** `[domain:]bus:slot[.function]`, as accepted by pve-qm-hostpci. */
const PCI_ID = /^(?:[0-9a-f]{4,}:)?[0-9a-f]{2}:[0-9a-f]{2}(?:\.[0-9a-f])?$/i;

/** A single host PCI id or a semicolon-separated VF list. */
function pciId(value) {
  const parts = String(value ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (parts.length === 0) throw new VmError('pci-attach needs a host PCI id such as 0000:01:00.0', 'BAD_ARGUMENT');
  for (const part of parts) {
    if (!PCI_ID.test(part)) {
      throw new VmError(`"${part}" is not a PCI address (expected bus:slot.function)`, 'BAD_ARGUMENT');
    }
  }
  return parts.join(';');
}

/** `host=<bus-port|vendor:product>` or the literal `spice`. */
function usbDevice(value) {
  const device = String(value ?? '').trim();
  if (device === 'spice') return 'spice';
  if (/^[0-9a-f]{4}:[0-9a-f]{4}$/i.test(device)) return `host=${device}`;
  if (/^\d+-\d+(?:\.\d+)*$/.test(device)) return `host=${device}`;
  throw new VmError(
    `"${device}" is not a USB device: use bus-port (1-2), vendor:product (1234:5678) or "spice"`,
    'BAD_ARGUMENT',
  );
}

/** Validate a slot number for the given kind. */
function slotNumber(value, kind) {
  const slot = Number(value);
  const max = kind === 'pci' ? MAX_HOSTPCI : MAX_USB;
  if (!Number.isInteger(slot) || slot < 0 || slot >= max) {
    throw new VmError(`${kind} slot must be an integer in 0..${max - 1}`, 'BAD_ARGUMENT');
  }
  return slot;
}

/** One PCI line for the agent. */
function describePci(entry) {
  const vendor = entry.vendor_name ?? entry.vendor ?? '';
  const device = entry.device_name ?? entry.device ?? '';
  return `${entry.id ?? '?'} — ${vendor} ${device}`.trim();
}

/** One USB line for the agent. */
function describeUsb(entry) {
  const id = entry.usbpath ? `usbpath ${entry.usbpath}` : `bus ${entry.busnum ?? '?'}`;
  const vendor = [entry.vendid, entry.prodid].filter(Boolean).join(':');
  return `${id}${vendor ? ` [${vendor}]` : ''} — ${entry.product ?? 'unknown device'}`;
}

/**
 * Build the passthrough tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function passthroughTools(deps) {
  return [
    {
      name: 'vm_passthrough',
      description:
        'Host device passthrough. `pci-list` and `usb-list` show the node hardware; `pci-attach` maps a host PCI ' +
        'device to `hostpci<N>` (options pcie, rombar, xVga) and `usb-attach` maps a USB port or vendor:product to ' +
        '`usb<N>` (or "spice"); `detach` removes the entry with `delete`. Attach and detach need a confirmation token; ' +
        'detach is treated as destructive. PCI changes require the VM to be stopped (PVE 7.4).',
      parameters: {
        action: {
          type: 'string',
          enum: ['pci-list', 'usb-list', 'pci-attach', 'usb-attach', 'detach'],
          required: true,
          description: 'What to read or change.',
        },
        vmid: { type: 'number', description: 'VM id (required for attach and detach).' },
        node: { type: 'string', description: 'Node to list hardware from (default: the instance node).' },
        slot: { type: 'number', description: 'hostpciN / usbN slot number (required for attach and detach).' },
        id: { type: 'string', description: 'Host PCI id for pci-attach, for example "0000:01:00.0".' },
        device: {
          type: 'string',
          description: 'USB device for usb-attach: bus-port ("1-2"), vendor:product ("1234:5678") or "spice".',
        },
        kind: { type: 'string', enum: ['pci', 'usb'], description: 'Device kind for detach.' },
        pcie: { type: 'boolean', description: 'pci-attach: put the device on a PCIe bus (q35 only).' },
        rombar: { type: 'boolean', description: 'pci-attach: make the device ROM visible to the guest (default true).' },
        xVga: { type: 'boolean', description: 'pci-attach: enable vfio-vga support (x-vga).' },
        usb3: { type: 'boolean', description: 'usb-attach: mark the device as USB3.' },
        confirm: { type: 'string', description: 'The token from the first call, for attach and detach.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.action === 'pci-list') {
            return textOutput(`PCI devices on ${value.node}:\n${(value.devices ?? []).map(describePci).join('\n') || 'none'}`);
          }
          if (value.action === 'usb-list') {
            return textOutput(`USB devices on ${value.node}:\n${(value.devices ?? []).map(describeUsb).join('\n') || 'none'}`);
          }
          if (value.action === 'detach') {
            return textOutput(`VM ${value.vmid}: removed ${value.key}${value.removed ? ` (${value.removed})` : ''}`);
          }
          return textOutput(`VM ${value.vmid}: ${value.key} = ${value.value}`);
        },
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = String(args.action);

        if (action === 'pci-list' || action === 'usb-list') {
          const node = args.node ? String(args.node) : await controller.nodeName();
          const devices = await controller.pveshGet(`/nodes/${node}/hardware/${action === 'pci-list' ? 'pci' : 'usb'}`, {}, {
            signal: exec?.signal,
          });
          return { instance: name, node, action, devices };
        }

        if (args.vmid === undefined) throw new VmError(`${action} needs a vmid`, 'BAD_ARGUMENT');
        const vmid = controller.assertAllowed(args.vmid);
        const node = await controller.nodeFor(vmid, { signal: exec?.signal });
        const base = `/nodes/${node}/qemu/${vmid}/config`;

        if (action === 'detach') {
          const kind = String(args.kind ?? '');
          if (kind !== 'pci' && kind !== 'usb') throw new VmError('detach needs kind=pci or kind=usb', 'BAD_ARGUMENT');
          const slot = slotNumber(args.slot, kind);
          const key = `${kind === 'pci' ? 'hostpci' : 'usb'}${slot}`;
          const config = await controller.pveshGet(base, {}, { signal: exec?.signal });
          const removed = config?.[key];
          if (removed === undefined) throw new VmError(`${key} is not configured on VM ${vmid}`, 'BAD_ARGUMENT');
          const summary =
            `Remove ${key} (${removed}) from VM ${vmid} on ${name}. The device goes back to the host; ` +
            (kind === 'pci' ? 'the VM must be stopped for PCI changes.' : 'the guest may lose the device immediately.');
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: `vm_passthrough:detach`, target: `${name}:vm:${vmid}:${key}`, risk: 'destroy', summary },
            async () => {
              await controller.pvesh('set', base, { params: { delete: key }, signal: exec?.signal, timeoutMs: 120_000 });
              return { instance: name, vmid, node, action, kind, slot, key, removed: String(removed) };
            },
          );
        }

        if (action === 'pci-attach') {
          const slot = slotNumber(args.slot, 'pci');
          const id = pciId(args.id);
          const options = [
            ...(args.pcie === true ? ['pcie=1'] : []),
            ...(args.rombar !== undefined ? [`rombar=${args.rombar === false ? 0 : 1}`] : []),
            ...(args.xVga === true ? ['x-vga=1'] : []),
          ];
          const value = [id, ...options].join(',');
          const key = `hostpci${slot}`;
          const config = await controller.pveshGet(base, {}, { signal: exec?.signal });
          const previous = config?.[key];
          const summary =
            `Attach host PCI device ${id} to VM ${vmid} on ${name} as ${key}${options.length ? ` (${options.join(', ')})` : ''}` +
            `${previous !== undefined ? `, replacing ${previous}` : ''}. The VM becomes non-migratable and PVE 7.4 ` +
            'requires it to be stopped for the change to take effect.';
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'vm_passthrough:pci-attach', target: `${name}:vm:${vmid}:${key}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('set', base, { params: { [key]: value }, signal: exec?.signal, timeoutMs: 120_000 });
              return { instance: name, vmid, node, action, kind: 'pci', slot, key, value };
            },
          );
        }

        if (action === 'usb-attach') {
          const slot = slotNumber(args.slot, 'usb');
          const device = usbDevice(args.device);
          const value = `${device}${args.usb3 === true ? ',usb3=1' : ''}`;
          const key = `usb${slot}`;
          const config = await controller.pveshGet(base, {}, { signal: exec?.signal });
          const previous = config?.[key];
          const summary =
            `Attach USB device ${device} to VM ${vmid} on ${name} as ${key}${previous !== undefined ? `, replacing ${previous}` : ''}. ` +
            'Passed-through USB devices make the VM non-migratable.';
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'vm_passthrough:usb-attach', target: `${name}:vm:${vmid}:${key}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('set', base, { params: { [key]: value }, signal: exec?.signal, timeoutMs: 120_000 });
              return { instance: name, vmid, node, action, kind: 'usb', slot, key, value };
            },
          );
        }

        throw new VmError(`unknown passthrough action "${action}"`, 'BAD_ARGUMENT');
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
