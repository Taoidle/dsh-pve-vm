/**
 * Plugin configuration.
 *
 * In 0.2.x the settings form is not written by hand: the `settings` service finds the plugin by
 * the id of its entry in the patch layer and builds the form from the exported `Config` schema.
 * That is why every field must be `.volatile()` — otherwise the service refuses to write the
 * field ("Config field … is not volatile"), and `apply` receives not values but
 * live references with `.get()`.
 */
import z from '@deepseek-ai/schemastery';

/** Text input script inside a Linux guest (used by `vm_type_text`). */
export const DEFAULT_GUEST_TYPE_COMMAND = [
  'set -e',
  // `$(...)` strips trailing newlines, and without them the text cannot be
  // "submitted" with Enter: `vm_type_text` with a trailing \"\\n\" silently typed
  // the line and left the prompt waiting.
  'text=$(printf %s "$1" | base64 -d; printf X)',
  'text=${text%X}',
  'uid=""; home=""; disp=""; xauth=""',
  'for s in $(loginctl list-sessions --no-legend 2>/dev/null | awk \'{print $1}\'); do',
  '  [ "$(loginctl show-session "$s" -p Active --value 2>/dev/null)" = "yes" ] || continue',
  // Take the first active GRAPHICAL session: on RedOS 8 `loginctl` reports an
  // empty Display even for X11, so the old `[ -n "$disp" ]` criterion fell
  // through to root's tty sessions — the script picked uid=0 and xdotool got
  // "No protocol specified" (found on 2026-10-23 in VM 121: X11 session 42,
  // then root tty 76/78).
  '  type=$(loginctl show-session "$s" -p Type --value 2>/dev/null)',
  '  [ "$type" = "x11" ] || [ "$type" = "wayland" ] || [ "$type" = "mir" ] || continue',
  '  uid=$(loginctl show-session "$s" -p User --value 2>/dev/null) || continue',
  '  home=$(getent passwd "$uid" | cut -d: -f6)',
  '  disp=$(loginctl show-session "$s" -p Display --value 2>/dev/null)',
  '  break',
  'done',
  '[ -n "$disp" ] || disp=":0"',
  '[ -n "$uid" ] || uid=$(id -u)',
  // XAUTHORITY. GDM (RedOS 8, RHEL) keeps it in /run/user/<uid>/gdm/Xauthority,
  // and ~/.Xauthority may not exist at all — xdotool then talked to X with no
  // authorization whatsoever, got "No protocol specified" and typed nothing
  // (found during acceptance on 2026-10-13, RedOS 8 + MATE + GDM).
  'if [ -n "$home" ] && [ -f "$home/.Xauthority" ]; then xauth="$home/.Xauthority"',
  'elif [ -f "/run/user/$uid/gdm/Xauthority" ]; then xauth="/run/user/$uid/gdm/Xauthority"',
  'else xauth=$(ls -1 /run/user/$uid/*/Xauthority /run/user/$uid/xauth* 2>/dev/null | head -1)',
  'fi',
  'run() { if [ -n "$xauth" ]; then XAUTHORITY="$xauth" DISPLAY="$disp" "$@"; else DISPLAY="$disp" "$@"; fi; }',
  'if command -v xdotool >/dev/null 2>&1; then run xdotool type --delay 12 --clearmodifiers -- "$text"; exit 0; fi',
  'if command -v wtype >/dev/null 2>&1; then',
  '  wd="$type"',
  '  if [ "$wd" = "wayland" ]; then XDG_RUNTIME_DIR="/run/user/$uid" WAYLAND_DISPLAY=wayland-0 wtype -- "$text"; exit 0; fi',
  'fi',
  'echo "neither xdotool nor wtype worked: a graphical session and one of these packages are required" >&2',
  'exit 3',
].join('\n');

/** Schema keys: `snapshot` reads the live values by them. */
export const CONFIG_KEYS = [
  'instances',
  'defaultInstance',
  'sshHost',
  'sshUser',
  'sshPort',
  'sshKeyPath',
  'sshConfigFile',
  'sshExtraOptions',
  'allowVmids',
  'enableConsole',
  'enableGuest',
  'inputChannel',
  'sendkeyDelayMs',
  'consoleTimeoutMs',
  'sessionIdleMs',
  'guestTimeoutMs',
  'guestTypeCommand',
  'viewAutoOpen',
  'viewFollowAgent',
  'viewFps',
  'viewScale',
];

/**
 * One PVE host: its own ssh endpoint and its own allowVmids.
 *
 * Every field has a default, and the entry as a whole is optional: an empty
 * `instances` list means "the single host described by the fields below".
 */
const InstanceSchema = z.object({
  name: z
    .string()
    .default('')
    .description('Short name for this host — the `instance` argument of every tool. Empty — a generated name.'),
  sshHost: z
    .string()
    .default('proxmox')
    .description(
      'Node address or an alias from ~/.ssh/config. In a cluster point it at a node: every instance has one ssh transport.',
    ),
  sshUser: z.string().default('root').description('ssh user on the node.'),
  sshPort: z.number().step(1).min(1).max(65535).default(22).description('ssh port.'),
  sshKeyPath: z.string().default('').description('Private SSH key for this host. Empty — the default keys.'),
  sshConfigFile: z
    .string()
    .default('')
    .description('Custom ssh-config for this host (`ssh -F`). Empty — ~/.ssh/config.'),
  sshExtraOptions: z
    .array(z.string())
    .default([])
    .description('Extra ssh `-o` options for this host, one per element.'),
  allowVmids: z
    .array(z.number().step(1).min(1))
    .default([])
    .description('VMs of this host the plugin may touch. Empty — inherited from the `allowVmids` field below.'),
  description: z.string().default('').description('A note about this host, for people.'),
  apiUrl: z
    .string()
    .default('')
    .description(
      'Proxmox API base URL, for example https://10.0.0.10:8006. Empty — the plugin drives the node over ssh only.',
    ),
  apiToken: z
    .string()
    .default('')
    .role('secret')
    .description(
      'API token secret (`user@realm!tokenid=secret`). With a token the management plane uses the API: names are ' +
        'resolved cluster-wide and no shell is needed. The console and the guest agent still use ssh.',
    ),
  apiTlsFingerprint: z
    .string()
    .default('')
    .description(
      'sha256 fingerprint of the node certificate, e.g. AA:BB:…. Empty — the certificate is verified normally; ' +
        'self-signed nodes need the pin or apiInsecureTls.',
    ),
  apiInsecureTls: z.boolean().default(false).description('Skip TLS verification for the API. Prefer apiTlsFingerprint.'),
  node: z
    .string()
    .default('')
    .description('Node name for node-level calls (apt, services, storage). Empty — asked from the API.'),
  mode: z
    .string()
    .default('auto')
    .description('Transport: "auto" (API when a token is set, else ssh), "api" or "ssh".'),
});

/** Settings schema: the id of the entry in `cordis.patch.yml` must match `pve-vm`. */
export const Config = z.object({
  instances: z
    .array(InstanceSchema)
    .default([])
    .description(
      'Additional PVE hosts. Empty — the single host from the ssh fields below (the historic behaviour). ' +
        'With several entries every tool takes an `instance` name; an omitted name means the default one.',
    )
    .volatile(),
  defaultInstance: z
    .string()
    .default('')
    .description('Instance used when a tool call omits `instance`. Empty — the first entry of the list.')
    .volatile(),
  sshHost: z
    .string()
    .default('proxmox')
    .description(
      'Proxmox VE node: an alias from ~/.ssh/config or an address (for example 10.0.0.10). ' +
        'With `instances` set, these fields are the defaults an instance inherits when it omits them.',
    )
    .volatile(),
  sshUser: z.string().default('root').description('ssh user on the node.').volatile(),
  sshPort: z.number().step(1).min(1).max(65535).default(22).description('ssh port.').volatile(),
  sshKeyPath: z
    .string()
    .default('')
    .description('Path to the private SSH key. Empty — the default SSH keys.')
    .volatile(),
  sshConfigFile: z
    .string()
    .default('')
    .description('Custom ssh-config (equivalent to `ssh -F`). Empty — the standard ~/.ssh/config.')
    .volatile(),
  sshExtraOptions: z
    .array(z.string())
    .default([])
    .description('Extra ssh `-o` options, one per element.')
    .volatile(),
  allowVmids: z
    .array(z.number().step(1).min(1))
    .default([])
    .description(
      'VMs the plugin is allowed to work with. An empty list forbids everything. ' +
        'An instance without its own list inherits this one.',
    )
    .volatile(),
  enableConsole: z.boolean().default(true).description('Enable the console (VNC) tools.').volatile(),
  enableGuest: z.boolean().default(true).description('Enable the guest agent tools.').volatile(),
  inputChannel: z
    .union(['auto', 'hmp', 'vnc'])
    .default('auto')
    .description(
      'Text input channel: auto — the reliable plan (Caps Lock for capitals through `qm monitor`, ' +
        'the rest as keysym over RFB; verified on `Pa55w0rd!`), hmp — everything through QEMU sendkey ' +
        '(faster, but it loses modifiers), vnc — RFB keysym only (upper case breaks).',
    )
    .volatile(),
  sendkeyDelayMs: z
    .number()
    .step(5)
    .min(5)
    .max(500)
    .default(80)
    .description(
      'Delay between keys in the hmp channel, ms. 80 ms is the verified pace (2026-10-13): at 40 ms ' +
        'QEMU sometimes lost the modifier (`shift-a` produced `a`).',
    )
    .volatile(),
  consoleTimeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .default(20000)
    .description('Console operation timeout, ms.')
    .volatile(),
  sessionIdleMs: z
    .number()
    .step(1)
    .min(10000)
    .default(300000)
    .description('Idle milliseconds after which the console session is closed.')
    .volatile(),
  guestTimeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .default(60000)
    .description('Guest agent command timeout, ms.')
    .volatile(),
  guestTypeCommand: z
    .string()
    .default(DEFAULT_GUEST_TYPE_COMMAND)
    .description(
      'Script for typing non-ASCII text in a Linux guest: takes the base64 text as its first argument ($1).',
    )
    .volatile(),
  viewAutoOpen: z
    .boolean()
    .default(false)
    .description(
      'Open the "VM screen" tab in the right sidebar by itself when the agent touches a VM console.',
    )
    .volatile(),
  viewFollowAgent: z
    .boolean()
    .default(true)
    .description('The panel follows the VM the agent is working with by default.')
    .volatile(),
  viewFps: z
    .number()
    .step(1)
    .min(1)
    .max(4)
    .default(2)
    .description('How many frames per second the panel asks the node for (1–4).')
    .volatile(),
  viewScale: z
    .number()
    .step(1)
    .min(1)
    .max(4)
    .default(2)
    .description(
      'Frame resolution divisor in the panel: 1 — native, 2 — half (default), 4 — quarter.',
    )
    .volatile(),
});

/**
 * Take the live schema values into a plain object.
 * @param {Record<string, {get?: () => unknown}>} live the config that `apply` received.
 * @returns {Record<string, unknown>} a slice of the settings at call time.
 */
export function snapshot(live) {
  const section = {};
  for (const key of CONFIG_KEYS) {
    const field = live?.[key];
    const value = typeof field?.get === 'function' ? field.get() : field;
    if (value !== undefined) section[key] = value;
  }
  return section;
}

/** Expand a leading `~` in a path. */
function expandHome(path) {
  if (typeof path !== 'string' || path.length === 0) return '';
  if (path === '~') return process.env.HOME ?? path;
  if (path.startsWith('~/')) return `${process.env.HOME ?? '~'}${path.slice(1)}`;
  return path;
}

/**
 * Reduce the settings slice to a shape convenient for the tools.
 *
 * The result describes the DEFAULT instance through `ssh`, `allowVmids` and
 * `instance` — the shape every tool read before multi-host support — and carries
 * the whole list in `instances`. `instanceSettings` turns one list entry into
 * that same shape, which is what a per-instance controller is built with.
 * @param {Record<string, unknown>} section the result of {@link snapshot}.
 * @returns {{ssh:object,allowVmids:number[],instance:string,instances:object[],defaultInstance:string,enableConsole:boolean,enableGuest:boolean,inputChannel:string,sendkeyDelayMs:number,consoleTimeoutMs:number,sessionIdleMs:number,guestTimeoutMs:number,guestTypeCommand:string,view:{autoOpen:boolean,followAgent:boolean,fps:number,scale:number}}}
 */
export function resolveSettings(section) {
  const globalAllowVmids = normalizeVmids(section.allowVmids);
  const instances = normalizeInstances(section, globalAllowVmids);
  const requested = typeof section.defaultInstance === 'string' ? section.defaultInstance.trim() : '';
  const active = instances.find((entry) => entry.name === requested) ?? instances[0];
  return {
    ssh: active.ssh,
    allowVmids: active.allowVmids,
    instance: active.name,
    api: active.api,
    node: active.node,
    mode: active.mode,
    instances,
    defaultInstance: active.name,
    enableConsole: section.enableConsole !== false,
    enableGuest: section.enableGuest !== false,
    inputChannel: ['vnc', 'hmp'].includes(section.inputChannel) ? section.inputChannel : 'auto',
    sendkeyDelayMs: Math.max(5, Number(section.sendkeyDelayMs ?? 80)),
    consoleTimeoutMs: Number(section.consoleTimeoutMs ?? 20000),
    sessionIdleMs: Number(section.sessionIdleMs ?? 300000),
    guestTimeoutMs: Number(section.guestTimeoutMs ?? 60000),
    guestTypeCommand: typeof section.guestTypeCommand === 'string' ? section.guestTypeCommand : DEFAULT_GUEST_TYPE_COMMAND,
    view: {
      autoOpen: section.viewAutoOpen === true,
      followAgent: section.viewFollowAgent !== false,
      fps: clampNumber(section.viewFps, 1, 4, 2),
      scale: clampNumber(section.viewScale, 1, 4, 2),
    },
  };
}

/**
 * The settings of one instance: the same shape `resolveSettings` returns, with
 * `ssh`, `allowVmids` and `instance` taken from that entry.
 * @param {ReturnType<typeof resolveSettings>} settings resolved settings.
 * @param {string} name instance name, as it appears in `settings.instances`.
 * @returns {ReturnType<typeof resolveSettings>} settings pinned to one host.
 */
export function instanceSettings(settings, name) {
  const entry = (settings.instances ?? []).find((item) => item.name === name);
  if (entry === undefined) {
    const known = (settings.instances ?? []).map((item) => item.name).join(', ') || 'none';
    throw new Error(`unknown PVE instance "${name}" (configured: ${known})`);
  }
  return {
    ...settings,
    ssh: entry.ssh,
    allowVmids: entry.allowVmids,
    instance: entry.name,
    api: entry.api,
    node: entry.node,
    mode: entry.mode,
  };
}

/** VMs of one allow list, deduplicated and ordered. */
function normalizeVmids(value) {
  if (!Array.isArray(value)) return [];
  const ids = value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0);
  return [...new Set(ids)].sort((left, right) => left - right);
}

/**
 * The instance list, with the historic single host as the degenerate case.
 *
 * An empty `instances` list yields one entry named `default` built from the
 * top-level ssh fields, so a profile written for 0.2.x keeps working untouched.
 * Duplicate names are suffixed rather than dropped: two hosts with one name would
 * otherwise silently shadow each other in the controller pool.
 */
function normalizeInstances(section, globalAllowVmids) {
  const raw = Array.isArray(section.instances) ? section.instances : [];
  const list = raw.map((entry, index) => toInstance(entry, index, globalAllowVmids, section));
  if (list.length === 0) list.push(toInstance(null, 0, globalAllowVmids, section));
  const used = new Set();
  for (const entry of list) {
    let name = entry.name;
    for (let suffix = 2; used.has(name); suffix += 1) name = `${entry.name}-${suffix}`;
    used.add(name);
    entry.name = name;
  }
  return list;
}

/** One instance entry; every ssh field falls back to the top-level one. */
function toInstance(raw, index, globalAllowVmids, section) {
  const entry = raw !== null && typeof raw === 'object' ? raw : {};
  const legacy = raw === null;
  const ownAllow = normalizeVmids(entry.allowVmids);
  const pick = (key, fallback) => {
    const value = entry[key];
    if (value === undefined || value === null || value === '') return section[key] ?? fallback;
    return value;
  };
  const mode = String(pick('mode', 'auto')).toLowerCase();
  return {
    name: String(entry.name ?? '').trim() || (legacy ? 'default' : `pve-${index + 1}`),
    description: String(entry.description ?? ''),
    allowVmids: ownAllow.length > 0 ? ownAllow : globalAllowVmids,
    mode: ['api', 'ssh', 'auto'].includes(mode) ? mode : 'auto',
    node: String(pick('node', '')).trim(),
    api: {
      url: String(pick('apiUrl', '')).trim().replace(/\/+$/, ''),
      token: String(pick('apiToken', '')).trim(),
      fingerprint: String(pick('apiTlsFingerprint', '')).trim(),
      insecureTls: pick('apiInsecureTls', false) === true,
    },
    ssh: {
      host: String(pick('sshHost', 'proxmox')),
      user: String(pick('sshUser', 'root')),
      port: Number(pick('sshPort', 22)),
      keyPath: expandHome(String(pick('sshKeyPath', ''))),
      sshConfig: expandHome(String(pick('sshConfigFile', ''))),
      extraOptions: (Array.isArray(pick('sshExtraOptions', [])) ? pick('sshExtraOptions', []) : []).map(String),
    },
  };
}

/**
 * An integer inside bounds (for the panel fields: fps and the resolution divisor).
 * @param {unknown} value live settings value.
 * @param {number} min lower bound.
 * @param {number} max upper bound.
 * @param {number} fallback default value.
 * @returns {number} a usable number.
 */
function clampNumber(value, min, max, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
