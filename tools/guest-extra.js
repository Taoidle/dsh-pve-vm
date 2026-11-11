/**
 * Guest-agent extras that the `qm guest` wrapper does not expose: cloud-init
 * inspection and regeneration, filesystem freeze, guest user passwords, raw
 * exec, and the read-only OS/filesystem/interface probes.
 *
 * PVE 7.4 differences that shape this file (checked with `pvesh usage` on the
 * node):
 *   • there is no `{vmid}/fsfreeze`; the agent commands are dedicated POSTs
 *     (`agent/fsfreeze-freeze`, `agent/fsfreeze-thaw`);
 *   • there is no `{vmid}/password`; the endpoint is
 *     `agent/set-user-password` (POST, username + password);
 *   • `PUT {vmid}/cloudinit` takes no fields and only regenerates the drive, so
 *     fields and deletions go through `PUT {vmid}/config` and are followed by
 *     the regeneration call;
 *   • the interface probe is `agent/network-get-interfaces`, not
 *     `agent/get-network-interfaces`.
 */
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, parseAssignments, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';

/** Cloud-init fields PVE 7.4 stores in the VM config. */
const CLOUDINIT_KEY = /^(ciuser|cipassword|citype|ciupgrade|cicustom|nameserver|searchdomain|sshkeys|ipconfig\d+)$/;

/** Directories a guest command may start from. */
const EXEC_PREFIXES = [
  '/bin/',
  '/sbin/',
  '/usr/bin/',
  '/usr/sbin/',
  '/usr/local/bin/',
  '/usr/local/sbin/',
  '/opt/',
];

/** Validate and normalise an absolute guest executable path. */
function executablePath(value) {
  const candidate = String(value ?? '').trim();
  if (!candidate.startsWith('/')) throw new VmError('exec needs an absolute path', 'BAD_ARGUMENT');
  if (candidate.includes('\u0000')) throw new VmError('the executable path contains a NUL byte', 'BAD_ARGUMENT');
  const normalised = path.posix.normalize(candidate);
  if (normalised !== candidate || normalised.includes('..')) {
    throw new VmError(`the executable path must be normalised, not "${candidate}"`, 'BAD_ARGUMENT');
  }
  if (!EXEC_PREFIXES.some((prefix) => normalised.startsWith(prefix))) {
    throw new VmError(
      `exec is limited to ${EXEC_PREFIXES.join(', ')}; "${normalised}" is not in the allow list`,
      'BAD_ARGUMENT',
    );
  }
  return normalised;
}

/** Parse and validate `key=value` cloud-init assignments without exposing values. */
function cloudinitFields(settings) {
  const pairs = parseAssignments(Array.isArray(settings) ? settings : []);
  if (pairs.length === 0) throw new VmError('cloudinit-set needs at least one "key=value" entry in settings', 'BAD_ARGUMENT');
  for (const pair of pairs) {
    if (!CLOUDINIT_KEY.test(pair.key)) {
      throw new VmError(`"${pair.key}" is not a cloud-init field on PVE 7.4`, 'BAD_ARGUMENT');
    }
    if (pair.value === '') {
      throw new VmError(`use action=cloudinit-pending to delete "${pair.key}"`, 'BAD_ARGUMENT');
    }
  }
  return pairs;
}

/**
 * Build the extra guest-agent tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function guestExtraTools(deps) {
  return [
    {
      name: 'vm_guest',
      description:
        'Guest-agent extras. `cloudinit`/`cloudinit-dump` read the cloud-init drive; `cloudinit-set` writes cloud-init ' +
        'fields and regenerates the drive; `cloudinit-pending` deletes cloud-init fields; `fsfreeze` freezes or thaws ' +
        'the guest filesystem (freeze leaves it quiesced until freeze=false); `password` sets a guest user password ' +
        'through the agent and never echoes it; `exec`/`exec-status` run and poll a command in the guest; ' +
        '`osinfo`/`fsinfo`/`interfaces` are read-only probes. Writes need a second confirmation.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        action: {
          type: 'string',
          enum: [
            'cloudinit',
            'cloudinit-dump',
            'cloudinit-set',
            'cloudinit-pending',
            'fsfreeze',
            'password',
            'exec',
            'exec-status',
            'osinfo',
            'fsinfo',
            'interfaces',
          ],
          required: true,
          description: 'What to read or change.',
        },
        type: {
          type: 'string',
          enum: ['user', 'network', 'meta'],
          description: 'Config type for cloudinit-dump (default user).',
        },
        settings: {
          type: 'array',
          items: { type: 'string' },
          description: 'Cloud-init fields for cloudinit-set as "key=value" strings, for example ["ciuser=debian"].',
        },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Cloud-init fields to delete for cloudinit-pending, for example ["cipassword"].',
        },
        freeze: { type: 'boolean', description: 'fsfreeze: true freezes the guest filesystem, false thaws it.' },
        user: { type: 'string', description: 'Guest user for action=password.' },
        password: { type: 'string', description: 'New password for action=password (never echoed back).' },
        crypted: { type: 'boolean', description: 'The password is already crypt()ed (action=password).' },
        path: { type: 'string', description: 'Absolute executable for action=exec, for example "/bin/df".' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments for action=exec (no shell expansion).',
        },
        inputData: { type: 'string', description: 'Data passed as stdin to action=exec (max 64 KiB).' },
        pid: { type: 'number', description: 'Process id for action=exec-status, as returned by exec.' },
        confirm: { type: 'string', description: 'The token from the first call, for the destructive actions.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          switch (value.action) {
            case 'cloudinit-dump':
              return textOutput(String(value.text ?? ''));
            case 'cloudinit-set':
              return textOutput(`VM ${value.vmid}: cloud-init fields set (${value.fields.join(', ')}); drive regenerated`);
            case 'cloudinit-pending':
              return textOutput(`VM ${value.vmid}: cloud-init fields deleted (${value.fields.join(', ')}); drive regenerated`);
            case 'fsfreeze':
              return textOutput(
                value.frozen
                  ? `VM ${value.vmid}: guest filesystem frozen — I/O is blocked until fsfreeze with freeze=false`
                  : `VM ${value.vmid}: guest filesystem thawed`,
              );
            case 'password':
              return textOutput(`VM ${value.vmid}: password of guest user "${value.user}" changed`);
            case 'exec':
              return textOutput(`VM ${value.vmid}: pid ${value.pid} started (${value.path})`);
            case 'exec-status':
              return textOutput(`VM ${value.vmid} pid ${value.pid}: ${JSON.stringify(value.data)}`);
            default:
              return textOutput(`VM ${value.vmid} ${value.action}:\n${JSON.stringify(value.data, null, 2)}`);
          }
        },
      },
      timeoutMs: 180_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const vmid = controller.assertAllowed(args.vmid, 'guest');
        const node = await controller.nodeFor(vmid, { signal: exec?.signal });
        const base = `/nodes/${node}/qemu/${vmid}`;
        const action = String(args.action);

        if (action === 'cloudinit') {
          const data = await controller.pveshGet(`${base}/cloudinit`, {}, { signal: exec?.signal });
          return { instance: name, vmid, node, action, data };
        }
        if (action === 'cloudinit-dump') {
          const type = String(args.type ?? 'user');
          if (!['user', 'network', 'meta'].includes(type)) throw new VmError(`unknown cloud-init type "${type}"`, 'BAD_ARGUMENT');
          const text = await controller.pveshGet(`${base}/cloudinit/dump`, { type }, { signal: exec?.signal });
          return { instance: name, vmid, node, action, type, text: String(text ?? '') };
        }
        if (action === 'cloudinit-set') {
          const pairs = cloudinitFields(args.settings);
          const params = Object.fromEntries(pairs.map((pair) => [pair.key, pair.value]));
          const fields = pairs.map((pair) => pair.key);
          const password = fields.includes('cipassword') ? ' (includes a cloud-init password)' : '';
          const summary =
            `Set cloud-init fields on VM ${vmid} on ${name}: ${fields.join(', ')}${password}, then regenerate its ` +
            'cloud-init drive.';
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'vm_guest:cloudinit-set', target: `${name}:vm:${vmid}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('set', `${base}/config`, { params, signal: exec?.signal, timeoutMs: 300_000 });
              // PVE 7.4's PUT cloudinit has no fields; it only regenerates the drive.
              await controller.pvesh('set', `${base}/cloudinit`, { signal: exec?.signal, timeoutMs: 300_000 });
              return { instance: name, vmid, action, fields, regenerated: true };
            },
          );
        }
        if (action === 'cloudinit-pending') {
          const keys = Array.isArray(args.keys) ? args.keys.map((key) => String(key).trim()).filter(Boolean) : [];
          if (keys.length === 0) throw new VmError('cloudinit-pending needs at least one key', 'BAD_ARGUMENT');
          for (const key of keys) {
            if (!CLOUDINIT_KEY.test(key)) throw new VmError(`"${key}" is not a cloud-init field on PVE 7.4`, 'BAD_ARGUMENT');
          }
          const summary =
            `Delete cloud-init fields ${keys.join(', ')} from VM ${vmid} on ${name} and regenerate its cloud-init drive.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'vm_guest:cloudinit-pending', target: `${name}:vm:${vmid}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('set', `${base}/config`, {
                params: { delete: keys.join(',') },
                signal: exec?.signal,
                timeoutMs: 300_000,
              });
              await controller.pvesh('set', `${base}/cloudinit`, { signal: exec?.signal, timeoutMs: 300_000 });
              return { instance: name, vmid, action, fields: keys, regenerated: true };
            },
          );
        }
        if (action === 'fsfreeze') {
          if (typeof args.freeze !== 'boolean') throw new VmError('fsfreeze needs freeze=true or freeze=false', 'BAD_ARGUMENT');
          if (args.freeze) {
            const summary =
              `Freeze the filesystem of VM ${vmid} on ${name} through the guest agent. The guest stays frozen ` +
              '(I/O blocked, the agent keeps answering) until this tool is called with freeze=false; a reset also thaws it.';
            return runGuarded(
              deps.confirms,
              { args, instance: name, action: 'vm_guest:fsfreeze', target: `${name}:vm:${vmid}`, risk: 'danger', summary },
              async () => {
                await controller.pvesh('create', `${base}/agent/fsfreeze-freeze`, { signal: exec?.signal });
                return { instance: name, vmid, action, frozen: true };
              },
            );
          }
          // Thawing has to stay available without a token: a frozen guest must
          // never depend on an unexpired confirmation.
          await controller.pvesh('create', `${base}/agent/fsfreeze-thaw`, { signal: exec?.signal });
          return { instance: name, vmid, action, frozen: false };
        }
        if (action === 'password') {
          const user = String(args.user ?? '').trim();
          if (user === '') throw new VmError('password needs a guest user name', 'BAD_ARGUMENT');
          const secret = String(args.password ?? '');
          if (secret.length < 5) throw new VmError('the guest password must be at least 5 characters', 'BAD_ARGUMENT');
          if (secret.length > 1024) throw new VmError('the guest password is longer than 1024 characters', 'BAD_ARGUMENT');
          const summary =
            `Set the password of guest user "${user}" on VM ${vmid} on ${name} through the guest agent. ` +
            'The password is not echoed in the answer.';
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'vm_guest:password', target: `${name}:vm:${vmid}:${user}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('create', `${base}/agent/set-user-password`, {
                params: { username: user, password: secret, ...(args.crypted === true ? { crypted: 1 } : {}) },
                signal: exec?.signal,
              });
              return { instance: name, vmid, action, user, changed: true };
            },
          );
        }
        if (action === 'exec') {
          const program = executablePath(args.path);
          const argv = Array.isArray(args.args) ? args.args.map((entry) => String(entry)) : [];
          if (argv.some((entry) => entry.includes('\u0000'))) {
            throw new VmError('an exec argument contains a NUL byte', 'BAD_ARGUMENT');
          }
          const input = args.inputData !== undefined ? String(args.inputData) : undefined;
          if (input !== undefined && Buffer.byteLength(input, 'utf8') > 64 * 1024) {
            throw new VmError('inputData is limited to 64 KiB by the PVE agent', 'BAD_ARGUMENT');
          }
          // The API's `command` is a string-alist; split_list() splits on NUL
          // when one is present, which is the only way to keep spaces intact.
          const command = [program, ...argv].join('\u0000');
          const summary =
            `Run ${program} with ${argv.length} argument(s) in the guest of VM ${vmid} on ${name} through the guest ` +
            'agent, as root. Only system binary directories are allow-listed.';
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'vm_guest:exec', target: `${name}:vm:${vmid}:${program}`, risk: 'destroy', summary },
            async () => {
              const answer = await controller.pvesh('create', `${base}/agent/exec`, {
                params: { command, ...(input !== undefined ? { 'input-data': input } : {}) },
                signal: exec?.signal,
              });
              const pid = Number(answer?.json?.pid);
              if (!Number.isInteger(pid)) throw new VmError('the guest agent did not return a pid', 'NODE_COMMAND_FAILED');
              return { instance: name, vmid, action, pid, path: program, argv };
            },
          );
        }
        if (action === 'exec-status') {
          const pid = Number(args.pid);
          if (!Number.isInteger(pid) || pid <= 0) throw new VmError('exec-status needs a numeric pid', 'BAD_ARGUMENT');
          const data = await controller.pveshGet(`${base}/agent/exec-status`, { pid }, { signal: exec?.signal });
          return { instance: name, vmid, action, pid, data };
        }
        const probes = {
          osinfo: 'get-osinfo',
          fsinfo: 'get-fsinfo',
          interfaces: 'network-get-interfaces',
        };
        const probe = probes[action];
        if (probe === undefined) throw new VmError(`unknown guest action "${action}"`, 'BAD_ARGUMENT');
        const data = await controller.pveshGet(`${base}/agent/${probe}`, {}, { signal: exec?.signal });
        return { instance: name, vmid, action, data };
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
