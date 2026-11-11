# dsh-pve-vm

**Proxmox VE VM control for [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness): see a VM's screen and click in its console over VNC, plus commands, files and typed text through the QEMU guest agent.**

Almost every computer-use plugin drives the desktop the agent itself runs on — and therefore needs
X11 or Wayland, a screenshot tool and an input injector on that host. This plugin does something
different: it drives **the console of a virtual machine on a Proxmox VE node**, over one ssh
connection. The host can be a headless server, a Wayland desktop or a laptop in another country;
the guest can be Windows, Linux with any GUI, or a machine that has not booted yet.

```
agent ──► plugin ──► ssh ──► node: qm vncproxy ──► unix socket /var/run/qemu-server/<vmid>.vnc
                      └────► node: qm guest exec ──► qemu-guest-agent inside the VM
```

## What you get

* **Pixels** — `console_shot` returns the VM screen as an inline image (with `region` and `scale`
  to keep the token cost sane), and mouse/keyboard tools operate in VM screen coordinates: move,
  click, double click, drag, wheel, type, key combinations, and a batch runner that performs a
  chain of actions and returns a single frame at the end.
* **Commands** — `vm_exec`, `vm_file_read`, `vm_file_write`, `vm_status` through the QEMU guest
  agent. Deterministic and cheap: use pixels only where a GUI really is in the way.
* **Reliable input** — uppercase goes through Caps Lock (`qm monitor` → HMP `sendkey`), shifted
  symbols through RFB keysyms with a settle delay. This is what makes typing a password on the
  Windows login screen work instead of producing `xxXX` → `xxxX`.
* **Unicode text** — a Windows guest gets a scheduled task in the logged-in user's session
  (`SendKeys`), a Linux guest gets `xdotool`/`wtype` through the guest agent. Layout and
  modifiers stop mattering.
* **Clipboard** — `console_paste` puts UTF-8 text into the guest clipboard and presses Ctrl+V;
  `console_clipboard` reads the guest clipboard back, so text can leave the VM without OCR. The guest
  agent is the primary channel (a scheduled task in the logged-in Windows session, `xsel`/`xclip`/
  `wl-copy`/`wl-paste` on Linux), so it also works on SPICE VMs (`vga: qxl`) where the VNC clipboard
  cannot reach the guest. The VNC clipboard (`clipboard=vnc`) remains as a fallback.
* **A settings card** in the web UI (English, Russian and Chinese labels), backed by the profile patch
  layer.
* **A live screen panel** — the “VM screen” tab in the right sidebar shows the frames the agent
  sees, taken from the very same VNC session, while the agent works. It follows the agent's VM
  automatically or stays on the VM you pick by hand. Watching only: the panel never clicks or types.
* **Zero runtime dependencies** — RFB, DES authentication, keysym tables and PNG encoding are
  implemented in this package on top of `node:crypto` and `node:zlib`. There is nothing to install
  on the host, and nothing to install on the node either.

Verified against `pve-manager 8.4.21` with Windows 11 / Windows Server 2025 and Linux guests, on
DeepSeek Harness `0.2.0-rc.2`.

## Requirements

| What | Why |
|---|---|
| DeepSeek Harness **≥ 0.2.0-rc.2** | The plugin uses the 0.2.x plugin contract (`defineTool`, `ctx.tools`, `ctx.subprocess`, `ctx.attachments`, the `computerUse` slot, client-side `configForms`). It does not load on 0.1.x. |
| Node.js **≥ 22** | The harness runtime. |
| A **Proxmox VE** node with the `qm` CLI | `/usr/sbin/qm vncproxy`, `qm guest exec`, `qm monitor`. Containers (LXC) are not supported. |
| **SSH access to that node as `root`** (or an account that may run `qm`) | `qm` needs root on the node. Key-based access is expected (`BatchMode`, no password prompts). |
| **`AcceptEnv LC_*` in the node's `sshd_config`** | The VNC password is handed to `qm` as the `LC_PVE_TICKET` environment variable via `SendEnv`, so it never appears in `ps`. Without `AcceptEnv`, ssh silently drops it and the console cannot authenticate. |
| Host key already accepted | Connections run with `BatchMode=yes`; an unknown host key fails. Run `ssh <node>` once by hand, or add `StrictHostKeyChecking=accept-new` to `sshExtraOptions`. |
| `qemu-guest-agent` **inside the guest** (optional) | Only the `vm_*` tools need it. Console tools work without any agent at all. |

## Install

```bash
# 1. Add the bundle
dsh plugin --profile web add github:taxah92/dsh-pve-vm

# 2. Make sure the bundle is enabled in the profile: dsh.profile.bundles must list "dsh-pve-vm"
#    (the plugin manager / market toggle does the same thing)

# 3. Restart the harness:  the host half of a plugin is loaded once per process
```

The plugin adds one row to the profile patch layer:

```yaml
- id: pve-vm
  name: dsh-pve-vm
```

The row id `pve-vm` **is** the settings namespace — do not rename it, or the settings card and the
patch layer will stop finding each other.

## Configure

Settings ▸ Plugins ▸ **Proxmox VE** in the web UI. Everything is written into the profile patch
layer, and the same values can be edited there by hand:

```yaml
- id: pve-vm
  name: dsh-pve-vm
  config:
    # Several PVE hosts: one entry per host, each with its own ssh endpoint and
    # its own VM ids. An empty list means "one implicit `default` host, described
    # by the ssh fields below" — a 0.2.x configuration keeps working untouched.
    # The settings page writes this list from the host cards; the ssh keys below
    # are for patch files and for the implicit default host only.
    instances: []
    defaultInstance: ''         # the host a tool call lands on when it names none
    sshHost: proxmox            # alias from ~/.ssh/config, or an address
    sshUser: root
    sshPort: 22
    sshKeyPath: ''              # empty — default keys
    sshConfigFile: ''           # like `ssh -F`
    sshExtraOptions: []         # extra -o options, one per item
    allowVmids: [100, 101]      # VMs the plugin may touch; empty list forbids everything
    enableConsole: true
    enableGuest: true
    inputChannel: auto          # auto | hmp | vnc
    sendkeyDelayMs: 80
    consoleTimeoutMs: 20000
    sessionIdleMs: 300000
    guestTimeoutMs: 60000
    guestTypeCommand: ''        # script for typing non-ASCII text into a Linux guest
    viewAutoOpen: false         # open the "VM screen" tab by itself when the agent touches a console
    viewFollowAgent: true       # the panel follows the VM the agent works with
    viewFps: 2                  # frame pace in the panel, 1–4
    viewScale: 2                # frame resolution divisor: 1 native, 2 half, 4 quarter
```

**First run checklist**

1. `allowVmids` is empty by default — **nothing is allowed until you list a VM id**. This is the
   only gate the plugin has.
2. `ssh <alias> 'qm status <vmid>'` should work from the host without a password prompt.
3. `ssh <alias> sshd -T | grep -i acceptenv` must include `LC_*` (see Requirements).
4. Call `vm_status` — it reports whether the VM is allowed, whether the guest agent answers, which
   guest OS was detected, and whether a console session is open.

### Several PVE hosts

One plugin instance can drive several independent Proxmox VE hosts. Settings → Proxmox VE shows one
card per host — **Add host** opens a full form (name, SSH host/user/port, key, ssh config, extra
options, allowed VMs, note), and each card carries **Make default**, **Edit** and **Remove**. With no
host card configured the plugin still resolves one implicit `default` host from the top-level `sshHost`
/ `sshUser` / … keys, so an existing 0.2.x profile keeps working — but those keys are config-file only
now; the settings page edits hosts as cards. The page writes exactly the `instances` list below, which
you can also set in a patch file:

```yaml
- id: pve-vm
  name: dsh-pve-vm
  config:
    defaultInstance: lab
    allowVmids: []              # global list; an instance with an empty list inherits it
    instances:
      - name: lab               # the `instance` argument of every tool
        sshHost: 10.0.0.11      # an address, or an alias from ~/.ssh/config
        sshUser: root
        sshKeyPath: ~/.ssh/lab_ed25519
        # Optional API transport (see "The API transport" below):
        apiUrl: https://10.0.0.11:8006
        apiToken: root@pam!dsh=…    # user@realm!tokenid=secret
        mode: api                 # auto (API when a token is set) | api | ssh
        node: pve1                # node-level calls; empty — ask the API
        apiTlsFingerprint: ''     # sha256 of the node certificate; self-signed nodes need it
        apiInsecureTls: false     # only when the fingerprint is not an option
        allowVmids: [100, 101]
        description: the lab cluster, node pve1
      - name: office
        sshHost: office-pve
        allowVmids: [200]
```

* Every tool takes an optional `instance`. Without it, the call lands on `defaultInstance`, or on
  the first entry of the list when that is empty. An unknown name fails with `BAD_INSTANCE` and
  lists the configured ones.
* The card's allow-list is per host, and values are separated by commas (a full-width `，`, `、`,
  `;` or a newline works too). A token that is not a positive vmid refuses the save and names the
  token, rather than being dropped. Leaving the list empty inherits the global list rather than
  allowing everything.
* `allowVmids` is decided **per host**. An entry with an empty list inherits the top-level
  `allowVmids`; a VM id allowed on one host is not allowed on another.
* The entries are isolated, not just labelled: each host gets its own controllers, console
  sessions, guest-agent caches and `qm` queues, so VM 100 on two nodes is two different machines.
* The **VM screen** panel grows a host selector when more than one entry is configured, and
  `vm_status` without a `vmid` answers with the inventory — every host, its endpoint and its
  allow-list.
* **In a cluster, point each entry at the node that owns the VM.** `qm vncproxy` and the guest agent
  are node-local, so a single ssh transport cannot reach VMs of different nodes; add one entry per
  node (or per host) you want to reach. Host-level clustering and migration are not followed
  automatically — a moved VM must be reachable through the entry you name.

### The API transport

A token switches the management plane from `ssh qm …` to the Proxmox API. Nothing about the console
changes — pixels and keystrokes still travel over ssh — but everything that is *configuration* becomes
cluster-wide and does not need a shell on the node:

* the node a VM lives on is read from `/cluster/resources`, so a tool call works from any entry of the
  cluster instead of only from the node that owns the VM;
* the credential is an API token you can revoke or re-scope, not a root ssh key;
* node administration (`apt`, services, storage, tasks, backups) uses the same REST endpoints as the
  web UI, and long operations are awaited by polling their task instead of a blocking ssh call.

Create the token once, on a node you can reach (Proxmox shows the secret only at creation time):

```bash
pveum user token add root@pam dsh --privsep 1 --comment "DeepSeek Harness"
pveum acl modify / --tokens 'root@pam!dsh' --roles PVEAdmin
```

Then put `apiUrl` and `apiToken` (`user@realm!tokenid=secret`) on the host card. `mode` decides the
transport: `auto` (the default) uses the API when a token is set and ssh otherwise, so a host without a
token keeps working exactly as before. The certificate of a default PVE install is self-signed: either
pin it with `apiTlsFingerprint` (the sha256 the browser shows) or, in a lab, set `apiInsecureTls: true`.

The API transport is optional on purpose. If the token is missing, expired or its role lacks a
permission, the error names the endpoint and the HTTP status (`PVE_API_DENIED`), and the ssh path to the
same node is untouched.

## Tools

Every tool also takes `instance` — the name of a configured PVE host. It is optional; omit it for
the default one.


### Console (VNC)

| Tool | Parameters | What it does |
|---|---|---|
| `console_shot` | `vmid`, `region?`, `scale?`, `drawCursor?`, `wake?` | Frame as an inline image. `scale` 1 / 0.5 / 0.25, `region` in VM pixels. Nearly uniform frames are flagged as `blank` (a blanked display or a locked screen). |
| `console_move` | `vmid`, `x`, `y`, `observe?`, `wake?`, `settleMs?`, `scale?`, `region?` | Move the pointer. |
| `console_click` | `vmid`, `x`, `y`, `button?`, `count?`, `observe?`, … | Click (2 = double click); returns a frame by default. |
| `console_drag` | `vmid`, `fromX`, `fromY`, `toX`, `toY`, `button?`, … | Drag — move a window, select a region. |
| `console_scroll` | `vmid`, `x`, `y`, `delta`, … | Wheel: positive scrolls up, negative down. |
| `console_type` | `vmid`, `text`, … | Printable ASCII only, `\n` presses Enter. Capitals go through Caps Lock, so expect ≈0.1 s per character. |
| `console_key` | `vmid`, `combo`, … | `enter`, `esc`, `tab`, `ctrl+alt+del`, `win+r`, `alt+f4`, `ctrl+shift+esc`, `f5`, and modifier-only combinations such as `alt+shift` (layout switch). |
| `console_paste` | `vmid`, `text`, `submit?`, … | Put any Unicode text into the guest clipboard and press Ctrl+V. Uses the guest agent (needs a logged-in session); falls back to the VNC clipboard when the VM has `clipboard=vnc`. |
| `console_batch` | `vmid`, `actions[]`, `observe?`, … | A chain of actions (`move`, `click`, `drag`, `scroll`, `type`, `key`, `wait`) and one frame at the end. |
| `console_clipboard` | `vmid`, `timeoutMs?` | Read the guest text clipboard through the guest agent (or the extended VNC clipboard as a fallback). Empty means "no text". |
| `console_release` | `vmid` | Close the console session (emergency brake: releases the ssh child and the QEMU connection). |

Every action tool accepts a common tail: `observe` (return a frame after the action, default true),
`wake` (Shift + pointer jitter to wake a blanked display), `settleMs`, `scale`, `region`.

### Guest agent

| Tool | Parameters | What it does |
|---|---|---|
| `vm_exec` | `vmid`, `command` \| `argv`, `shell?`, `timeoutMs?` | Run a command in the guest (`cmd`/PowerShell on Windows, shell on Linux). Runs as root/SYSTEM and does not see the user's graphical session. A `command` with non-ASCII travels as a base64 envelope; `argv` must be ASCII. A command that outlives `timeoutMs` keeps running and is reported as `STILL_RUNNING` with its pid. |
| `vm_file_read` | `vmid`, `path`, `maxBytes?`, `encoding?` | Read a file (text, or base64 for binary) through the agent, in 256 KiB chunks. |
| `vm_file_write` | `vmid`, `path`, `data` \| `dataBase64` | Write a file (up to 1 MiB per call, sent over stdin); parent directories are created. |
| `vm_type_text` | `vmid`, `text`, `settleMs?`, `observe?` | Type text through the best available channel: ASCII → console, non-ASCII → the user session on Windows / `xdotool`–`wtype` on Linux. |
| `vm_status` | `vmid?` | Is the VM allowed, does the agent answer, which OS, are there open console sessions. |

### Lifecycle, snapshots, storage, node and cluster

These go through `qm` and `pvesh` on the node over the same ssh transport as everything else — the
plugin still needs no PVE API token.

| Tool | Parameters | What it does |
|---|---|---|
| `vm_power` | `vmid`, `action` = `start` \| `shutdown` \| `stop` \| `reboot` \| `reset` \| `suspend` \| `resume`, `timeoutSec?`, `confirm?` | Power state. `shutdown` asks the guest (ACPI) and waits up to `timeoutSec` (default 60); `stop` and `reset` do not. Answer carries the `qm status` afterwards. |
| `vm_create` | `vmid?`, `name?`, `memory?`, `cores?`, `ostype?`, `disk?`, `net?`, `iso?`, `start?` | Create a VM; the id defaults to `/cluster/nextid`. |
| `vm_destroy` | `vmid`, `purge?`, `confirm?` | Delete the VM and its disks. `purge` also removes the backup/job references. |
| `vm_snapshot` | `vmid`, `action` = `list` \| `create` \| `delete` \| `rollback`, `name?`, `description?`, `confirm?` | Snapshot management; `list` reads `/nodes/<node>/qemu/<id>/snapshot`. |
| `vm_config` | `vmid`, `action` = `get` \| `pending` \| `set`, `settings?: ["key=value"]`, `confirm?` | Read or change the VM configuration (`qm set`; a bare `key` deletes it). |
| `vm_disk` | `vmid`, `action` = `list` \| `rescan` \| `trim` \| `resize` \| `move` \| `attach-iso` \| `detach-iso`, `slot?`, `size?`, `storage?`, `iso?`, `deleteSource?`, `confirm?` | Disks and the ISO drive. `list` shows every `ideN\|sataN\|scsiN\|virtioN` slot with its current value. |
| `node_storage` | — | The node's storage list (type, content, free space). |
| `node_status` | `action` = `overview` \| `apt` \| `services` \| `tasks` \| `syslog` \| `network`, `limit?` | Node read-only views. `overview` is trimmed to uptime, load, memory/rootfs, PVE and kernel version. |
| `node_apt` | `action` = `update` \| `upgrade`, `reboot?`, `confirm?` | Refresh the package lists, or install the pending upgrades (a task; answers with its UPID). |
| `node_service` | `action` = `list` \| `start` \| `stop` \| `restart` \| `reload`, `name?`, `confirm?` | Node services (`pveproxy`, `pvedaemon`, …). |
| `node_task` | `upid`, `action` = `status` \| `log` \| `stop`, `confirm?` | Follow or stop a task by UPID (apt upgrade, backup, migration). |
| `cluster_status` | `action` = `status` \| `resources` \| `nodes` \| `nextid` \| `ha` | Cluster view; this is also how the plugin finds which node owns a VM. |
| `pve_api` | `method` = `get` \| `create` \| `set` \| `delete`, `path`, `params?: ["k=v"]`, `confirm?` | Escape hatch for anything the typed tools do not cover. Reads run directly; writes go through the confirmation flow. |
| `vm_backup` | `action` = `list` \| `start` \| `restore`, `vmid?`, `storage?`, `mode?`, `archive?`, `confirm?` | `vzdump` tasks and `qmrestore`. |
| `vm_clone` | `vmid`, `newid?`, `name?`, `full?`, `target?` | Clone a VM (full or linked). |
| `vm_migrate` | `vmid`, `target`, `online?`, `withLocalDisks?`, `confirm?` | Move a VM to another cluster node. |
| `cluster_ha` | `action` = `list` \| `get` \| `create` \| `update` \| `delete` \| `status` \| `groups` \| `group-get` \| `group-create` \| `group-update` \| `group-delete` \| `rules`, `sid?`, `type?`, `group?`, `nodes?`, `comment?`, `state?`, `max_relocate?`, `max_restart?`, `nofailback?`, `restricted?`, `delete?`, `digest?`, `confirm?` | HA resources, groups and current status. HA rules are a PVE 8 feature and answer "not available" here. Writes need a token. |
| `cluster_replication` | `action` = `list` \| `get` \| `create` \| `update` \| `delete` \| `schedule_now`, `id?`, `target?`, `schedule?`, `type?`, `comment?`, `disable?`, `rate?`, `source?`, `remove_job?`, `delete?`, `digest?`, `force?`, `keep?`, `node?`, `confirm?` | Replication jobs and a one-off `schedule_now`. A new job needs `id`, `target` and `schedule`; `type` defaults to `local`. Writes need a token. |
| `cluster_options` | `action` = `get` \| `set`, `changes?: ["key=value"]`, `delete?: ["key"]`, `confirm?` | Cluster-wide options. `set` is a confirmed PUT; `delete` removes the named keys. |
| `cluster_metrics` | `action` = `list` \| `get` \| `create` \| `update` \| `delete` \| `influxdb` \| `influxdb-set`, `id?`, `type?`, `server?`, `port?`, `changes?: ["key=value"]`, `delete?`, `confirm?` | Metrics servers (`/cluster/metrics/server`). The legacy `/cluster/metrics/influxdb` endpoint is gone in 7.4 and answers "not available". Writes need a token. |
| `cluster_tasks` | `type?`, `status?`, `user?`, `node?`, `vmid?`, `limit?` | Cluster task list, filtered client-side (the 7.4 API rejects those filters) and sorted newest first. |
| `node_dns` | `action` = `get` \| `set`, `node?`, `search?`, `dns1?`, `dns2?`, `dns3?`, `confirm?` | Resolver settings; `set` needs `search` and is confirmed. |
| `node_time` | `action` = `get` \| `set`, `node?`, `timezone?`, `confirm?` | Timezone; `set` is a confirmed PUT (7.4 has no POST variant). |
| `node_disks` | `action` = `list` \| `smart` \| `zfs` \| `lvm` \| `directory`, `node?`, `disk?`, `healthonly?` | Physical disks and storage views. `smart` needs `disk` (`sda` or `/dev/sda`). Read-only. |
| `node_apt_repos` | `action` = `get` \| `add-standard` \| `toggle`, `node?`, `handle?`, `index?`, `path?`, `enabled?`, `digest?`, `confirm?` | APT repository files, add a standard repository by `handle`, or enable/disable one entry. Writes need a token. |
| `node_hosts` | `action` = `get` \| `write` \| `replace` \| `delete`, `node?`, `data?`, `digest?`, `confirm?` | `/etc/hosts`; `write` is a confirmed POST. `replace`/`delete` are PVE 8 shapes and answer "not available" on 7.4. |
| `node_wakeonlan` | `node?`, `mac?` | Send a Wake-on-LAN packet from the node; the API takes no parameters, `mac` is echoed in the answer. |
| `node_execute` | `mode` = `api` \| `shell`, `node?`, `commands?`, `script?`, `confirm?` | **Destroy risk.** `api` posts a batch of `{path, method, args}` API calls to `/nodes/<node>/execute`; `shell` is a plugin extension that runs a script as root over ssh. Both need a token. |
| `node_rrddata` | `node?`, `timeframe` = `hour` \| `day` \| `week` \| `month` \| `year`, `cf?` | Node RRD samples, optionally consolidated with `AVERAGE`/`MAX`. |
| `node_diagnostics` | `node?`, `maxChars?` | Diagnostic report. 7.4 has no `/diagnostics`; the tool falls back to `/nodes/<node>/report` and labels the source. |

### Containers, scheduled backups, pools and templates

Containers, backup jobs and pools are cluster objects, so they go through the Proxmox API and
therefore need the API transport (an `apiToken` on the card, see above). Container ids share the
number space with VM ids and are checked against the same `allowVmids` list — the one exception is
`lxc_create`, which is allowed to pick a new id but the container has to be added to the list before
it can be managed afterwards.

| Tool | Parameters | What it does |
|---|---|---|
| `lxc_list` | `node?` | Every container in the cluster (or one node) with status, memory and the node it lives on. |
| `lxc_status` | `vmid` | Runtime status and the full container configuration. |
| `lxc_power` | `vmid`, `action` = `start` \| `shutdown` \| `stop` \| `reboot` \| `suspend` \| `resume`, `confirm?` | Lifecycle; `stop`, `reboot` and `suspend` need a token. Answer carries the status afterwards. |
| `lxc_create` | `ostemplate`, `vmid?`, `hostname?`, `storage?`, `memory?`, `cores?`, `password?`, `start?`, `unprivileged?`, `node?` | Create a container from a template; the id defaults to `/cluster/nextid`. |
| `lxc_config` | `vmid`, `action` = `get` \| `set`, `settings?: ["key=value"]`, `confirm?` | Read or change the configuration (`key` without `=` deletes it); writes need a token. |
| `lxc_snapshot` | `vmid`, `action` = `list` \| `create` \| `delete` \| `rollback`, `name?`, `description?`, `confirm?` | Container snapshots; delete and rollback need a token. |
| `lxc_exec` | `vmid`, `argv` | Run a command with `pct exec` over ssh (the REST API has no exec endpoint). `argv` is the program and its arguments, for example `["uname", "-a"]`. |
| `lxc_delete` | `vmid`, `purge?`, `force?`, `confirm?` | Destroy the container and its disks; needs a token. |
| `backup_job` | `action` = `list` \| `create` \| `update` \| `delete` \| `run`, `id?`, `storage?`, `schedule?`, `vmid?`, `mode?`, `compress?`, `enabled?`, `node?`, `confirm?` | Scheduled backup jobs (`/cluster/backup`). `run` reads the job first and then starts `vzdump` on the node that holds the guests; create/update/delete need a token. |
| `pve_pool` | `action` = `list` \| `create` \| `update` \| `delete`, `pool?`, `comment?`, `vms?`, `storage?`, `confirm?` | Resource pools and their members; `delete` needs a token. |
| `vm_template` | `action` = `list` \| `convert`, `vmid?`, `confirm?` | List templates or turn a VM into one (a template cannot be started; clear the flag in the configuration to undo). |

A new container starts out **outside** the allow list on purpose: creating a guest does not touch an
existing one, but managing it later is an explicit decision, so add its id to `allowVmids` first.

### Storage: definitions and the files inside them

Two sides of the same subject. `pve_storage` owns the cluster records (`/storage`) — which
datastores exist, of what type, with which content kinds and on which nodes. `storage_content` owns
the files inside one of them: ISOs, backups and disk images. A wrong definition hides a datastore (or
points it at the wrong path), so the writes are confirmed; deleting a volume really deletes the file.

| Tool | Parameters | What it does |
|---|---|---|
| `pve_storage` | `action` = `list` \| `create` \| `update` \| `delete`, `storage?`, `type?`, `content?`, `path?`, `server?`, `export?`, `nodes?`, `disable?`, `confirm?` | Storage definitions; `create` needs a `storage` id and a `type`, `update` takes any of the fields, `delete` removes only the record (the files stay on the underlying storage). All writes need a token. |
| `storage_content` | `action` = `list` \| `upload-iso` \| `delete-volume` \| `download-url` \| `import-disk`, `storage`, `node?`, `content?`, `volume?`, `file?`, `filename?`, `url?`, `source?`, `vmid?`, `format?`, `confirm?` | `list` shows the volumes of one content kind (ISOs by default), `upload-iso` streams a local file to the storage, `download-url` fetches a URL on the node, `delete-volume` removes one volume and `import-disk` adds a local image to a VM as a new disk. |

`upload-iso` needs the API transport (an `apiToken` on the card) because the file is streamed as
`multipart/form-data`; everything else also works through `pvesh` over ssh. An upload of a few
gigabytes is fine — the body is piped from disk, not buffered — and the answer carries the task id,
which is awaited before the call returns. `delete-volume` and `import-disk` need a confirmation
token; `import-disk` adds the disk unattached, so assign it to `scsiN`/`virtioN` afterwards with
`vm_config`.

### Access control: users, groups, roles, ACLs, tokens

| Tool | Parameters | What it does |
|---|---|---|
| `pve_user` | `action` = `list` \| `get` \| `create` \| `update` \| `delete`, `userid?`, `password?`, `email?`, `firstname?`, `lastname?`, `groups?`, `comment?`, `enable?`, `expire?`, `confirm?` | Cluster users; the id must be `name@realm`. Writes need a token. |
| `pve_group` | `action` = `list` \| `create` \| `update` \| `delete`, `groupid?`, `comment?`, `users?`, `confirm?` | Groups and their members. Writes need a token. |
| `pve_role` | `action` = `list` \| `get` \| `create` \| `update` \| `delete`, `roleid?`, `privs?`, `append?`, `confirm?` | Roles and their privilege sets; `append` merges into the existing set instead of replacing it. Writes need a token. |
| `pve_acl` | `action` = `list` \| `set` \| `remove`, `path`, `users?` / `groups?` / `tokens?` (exactly one), `roles`, `propagate?`, `confirm?` | ACL entries on an object path. `remove` sends `delete=1` on the same endpoint. Writes need a token. |
| `pve_token` | `action` = `list` \| `create` \| `remove`, `userid`, `tokenid?`, `privsep?`, `comment?`, `expire?`, `confirm?` | API tokens of a user. **The secret is printed exactly once**, by `create`. Writes need a token. |
| `pve_domain` | `action` = `list` \| `get` \| `create` \| `update` \| `delete` \| `sync`, `realm?`, `type?`, `options?: ["key=value"]`, `digest?`, `dry_run?`, `full?`, `purge?`, `enable_new?`, `remove_vanished?`, `scope?`, `confirm?` | Authentication realms and a directory `sync` (dash-named PVE parameters are mapped for you). Writes and `sync` need a token. |
| `pve_tfa` | `action` = `list` \| `delete`, `userid`, `id?`, `password?`, `confirm?` | TFA entries of a user. Deletion goes through `/access/tfa/<userid>/<id>` (not the user path) and needs a token. |
| `pve_permissions` | `action` = `list` \| `user`, `path?`, `userid?` | Effective permissions; the user view falls back to `/access/permissions?userid=` because 7.4 has no per-user child endpoint. Read-only. |
| `pve_password` | `userid`, `password`, `confirm?` | Change the token owner's own password. **Danger**, confirmed, and the password is never echoed in the answer. |
| `pve_token_rotate` | `userid`, `tokenid`, `privsep?`, `expire?`, `comment?`, `confirm?` | Rotate a token with `regenerate=1`; the old secret stops working, so this is **destroy** and confirmed. PVE 7.4 may reject `regenerate` — the tool reports that as "not available" instead of a failure. |

### Two tokens: an operator and an access manager

Managing access is not a guest operation: PVE gates `/access` behind `Permissions.Modify`, `User.Modify`,
`Group.Allocate` and `Realm.Allocate`, and those privileges also let a token re-grant itself anything.
Keeping them on the every-day token would undo the point of a scoped token, so give the plugin two
cards on the same node:

```yaml
instances:
  - name: lab                 # day-to-day: guests, storage, backups
    sshHost: 10.0.0.11
    apiUrl: https://10.0.0.11:8006
    apiToken: 'root@pam!dsh=<secret>'
    mode: api
  - name: lab-admin           # access control only
    sshHost: 10.0.0.11
    apiUrl: https://10.0.0.11:8006
    apiToken: 'root@pam!dsh-admin=<secret>'
    mode: api
    description: "same node, PVEAdmin token — users, groups, roles, ACLs, tokens"
```

Create the scoped role once on the node (the privilege names below are what the tools in this plugin
actually use — guest lifecycle and configuration, snapshots and backups, storage, node status,
services and tasks, pools):

```bash
pveum role add DSHOperator -privs "VM.Audit,VM.Console,VM.Monitor,VM.PowerMgmt,VM.Snapshot,VM.Snapshot.Rollback,VM.Backup,VM.Migrate,VM.Clone,VM.Allocate,VM.Config.Disk,VM.Config.CDROM,VM.Config.Cloudinit,VM.Config.CPU,VM.Config.HWType,VM.Config.Memory,VM.Config.Network,VM.Config.Options,Datastore.Audit,Datastore.Allocate,Datastore.AllocateSpace,Datastore.AllocateTemplate,Sys.Audit,Sys.Modify,Sys.PowerMgmt,Sys.Syslog,Sys.Console,Pool.Audit,Pool.Allocate"
pveum user token add root@pam dsh --privsep 1 --comment "DeepSeek Harness"
pveum acl modify / --tokens 'root@pam!dsh' --roles DSHOperator
```

Then create the second token with `PVEAdmin` (or a role that only carries the access privileges), and
point only the `-admin` card at it. A denied API call now says so instead of returning an empty body:
`permission denied — the token's role does not grant this path (Permissions.Modify manages access;
VM.* and Datastore.* cover guests and storage)`.

### Network changes that can lock you out

| Tool | Parameters | What it does |
|---|---|---|
| `node_network` | `action` = `list` \| `create` \| `update` \| `delete` \| `apply`, `iface?`, plus interface fields (`type`, `address`, `cidr`, `netmask`, `gateway`, `bridge_ports`, `bridge_stp`, `bond_mode`, `slaves`, `mtu`, `vlan_id`, …), `timeout_sec?`, `confirm?` | Interfaces of the node. `create` and `update` only write `/etc/network/interfaces.new` — nothing takes effect until `apply`. |

A wrong network change is the one failure this plugin cannot talk its way out of: the node stays up,
but the address you are talking to it on is gone, so the answer to "did it work" never arrives and the
next call fails at the TCP level. `apply` therefore goes through three layers:

1. **Inventory first.** `list` shows the current interfaces, the pending file (if any), and which
   interface carries the management address (the API URL's host) — the one to be careful with.
2. **The confirmation token.** The first `apply` changes nothing; it returns the token together with a
   summary that names the pending interfaces and the management interface.
3. **A rollback timer that outlives this call.** Before applying, the plugin copies
   `/etc/network/interfaces` and `/etc/network/interfaces.new` to
   `/var/lib/dsh-pve-vm/rollback/<unit>/` on the node and arms a detached
   `systemd-run --on-active=<N>s` unit that restores them and runs `ifreload -a`. After the confirmed
   `apply` it probes the API. If the node answers, the timer is cancelled; if it does not, the timer
   stays armed and the answer says so. Worst case is two or three minutes of downtime, not a keyboard.

Because the probe is an API call and the timer is armed over ssh, `apply` needs an instance with both
`apiUrl`/`apiToken` and `sshHost`; without one it refuses with that sentence instead of trying.

### The firewall, with a way back

| Tool | Parameters | What it does |
|---|---|---|
| `pve_firewall` | `scope` = `cluster` \| `node` \| `guest`, `action` = `status` \| `enable` \| `disable` \| `policy` \| `rule-list` \| `rule-add` \| `rule-update` \| `rule-delete`, `vmid?` (guest scope), `rule_action`? (`ACCEPT`/`DROP`/`REJECT`), `rule_type`?, `dport`?, `sport`?, `source`?, `dest`?, `proto`?, `pos`?, `confirm?` | Firewall options and rules at cluster, node or guest level. Every write needs a token; cluster/node writes also arm the rollback timer. |
| `pve_security_group` | `action` = `list` \| `get` \| `create` \| `delete` \| `rule-add` \| `rule-update` \| `rule-delete`, `group?`, `comment?`, `pos?`, `rule_action?`, `rule_type?`, `source?`, `dest?`, `proto?`, `dport?`, `sport?`, `iface?`, `log?`, `enable?`, `macro?`, `icmp_type?`, `moveto?`, `digest?`, `confirm?` | Cluster security groups and their rules. Writes need a token. |
| `pve_ipset` | `action` = `list` \| `get` \| `create` \| `delete` \| `entry-add` \| `entry-update` \| `entry-delete`, `name?`, `comment?`, `cidr?`, `nomatch?`, `force?`, `digest?`, `confirm?` | Cluster IPSets and their CIDR entries. CIDRs are validated before the request; writes need a token. |
| `pve_alias` | `action` = `list` \| `get` \| `create` \| `update` \| `delete`, `name?`, `cidr?`, `comment?`, `rename?`, `digest?`, `confirm?` | Cluster aliases. `update` fetches the current CIDR when it is omitted; writes need a token. |
| `pve_firewall_extra` | `action` = `options` \| `options-set` \| `log` \| `refs`, `node?`, `changes?: ["key=value"]`, `delete?`, `limit?`, `since?`, `start?`, `until?`, `type?`, `confirm?` | Cluster firewall options (confirmed PUT), the node firewall log, and alias/IPSet references. Enabling the firewall can cut the management path, so `options-set` warns in its summary. |

`status` counts the management ports (**8006** and **22**) that have no `ACCEPT` input rule, and
`enable` warns when the count is not zero: enabling a DROP policy without an allow rule for the plugin's
own traffic cuts the plugin off. Cluster and node writes copy `cluster.fw` / `host.fw` aside, arm the
same timer with `pve-firewall restart`, apply and probe; guest-level rules are plain writes.

### Certificates, subscriptions and notifications

`pve_certificate` manages the node certificate (custom PEM upload, ACME order/renew/revoke); the
ACME actions live under `/certificates/acme/certificate` on 7.4. `pve_subscription` reads, sets or
removes the subscription key. `pve_notifications` probes `/cluster/notifications/endpoints`; PVE 7.4
does not have that API, so the tool answers “not available on this PVE version” instead of failing.

| Tool | Parameters | What it does |
|---|---|---|
| `pve_certificate` | `action` = `info` \| `upload` \| `delete-custom` \| `acme-order` \| `acme-renew` \| `acme-revoke`, `node?`, `certificates?`, `key?`, `force?`, `restart?`, `confirm?` | Certificate store and custom/ACME certificate lifecycle. Writes are **danger** and need a token. |
| `pve_subscription` | `action` = `get` \| `set` \| `check` \| `delete`, `node?`, `key?`, `force?`, `confirm?` | Subscription status, key change (validated against the PVE key shape), an info refresh, or removal. `set` and `delete` need a token. |
| `pve_notifications` | `type?` | Probe the notification endpoints API; on 7.4 it returns `available: false` with an explanation. Read-only. |

### Dangerous operations need a second confirmation

A dangerous call does **nothing** on its first invocation. It returns
`{"status":"confirmation-required","performed":false,"summary":"…","confirm":"<token>","expiresAt":"…"}`,
and the operation only runs when the same tool is called again with
`confirm: "<token>"` within three minutes. The token is bound to the action and the target, works
exactly once, and is refused with `CONFIRM_MISMATCH` when it was issued for another VM or another
action. Risks are `danger` (stop, shutdown, reboot, suspend, resize, move, restart a service, an
upgrade) and `destroy` (reset, destroy, rollback, restore, migrate, deleting a snapshot, …).

The panel's power buttons use the same mechanism: 强制断电 / 重置 answer with a confirmation bar
(确认执行 / 取消) instead of acting immediately, so the agent and the panel can never disagree about
what needs a second look.

## Watch the VM screen live

The **VM screen** tab in the right sidebar shows what the agent sees while it works. Add it from the
sidebar guide, or let `viewAutoOpen` reveal it the moment the agent touches a console.

* The frames are taken from the agent's own RFB session — **no second VNC session appears** and the
  `qm vncproxy` password is never reset under the agent's feet. Captures and the agent's tools share
  one session queue, so they never tear the stream for each other.
* `viewFollowAgent` keeps the panel on the VM the agent is working with; clicking a VM chip pins the
  panel to that VM instead. `viewFps` (1–4) and `viewScale` (1 / 2 / 4) control the pace and the
  resolution, and both can be changed on the fly inside the panel.
* The panel only **watches the guest** — no clicks, no typing, nothing is injected into the guest.
  It does control the *machine*, though: start / shut down / stop / reset live in the panel, and the
  dangerous ones ask for a second click. A blank frame is called out explicitly — the guest blanked
  its display or is locked.
* Frames are served by the plugin's own routes (`/pve-vm/console/frame`, `/state`, `/release`) on the
  harness web server, behind a loopback-only fence: a request is answered only when the `Host` is
  loopback (`localhost`, `127.0.0.0/8`, `[::1]`), a present `Origin` matches `Host`, and
  `sec-fetch-site: cross-site` is refused. If you bind the harness to your LAN, the panel stays dark
  by design — the same fence the harness applies to `/api`.
* **The fence is loopback, not the harness token.** These routes live outside `/api`, so the
  harness URL token does not cover them (the browser-skill overview works the same way). Any
  process on the same machine can therefore pull frames or call `/release`; that is the accepted
  price of loading frames without a token on a single-user box. Serve VMs you would not mind a
  local user seeing, and harden with a harness-issued token if that is not acceptable.
* The console session stays open while the panel streams (the idle reaper does not take it); the
  panel's “disconnect console” button closes it immediately. Streaming pauses by itself when the tab
  is hidden.

## How it works

* **Transport.** A VM has no TCP VNC port: QEMU listens on the unix socket
  `/var/run/qemu-server/<vmid>.vnc`, and `qm vncproxy` bridges it to its own stdin/stdout. The
  plugin therefore speaks RFB *through an ssh child process* — no ports, no TLS, no websocket, and
  the VNC password never lands in `argv`. `qm vncproxy` treats EOF on its stdin as "quit", so the
  plugin keeps that pipe open (the bridge also drops idle sessions after 15 minutes; the plugin
  closes its own session after `sessionIdleMs`, 5 minutes by default).
* **Input channels.** `inputChannel: auto` (default) mixes them: Caps Lock through the QEMU monitor
  for uppercase, RFB keysyms for the rest. `hmp` sends everything through `qm monitor sendkey`
  (faster, but QEMU occasionally loses modifiers below ~80 ms), `vnc` uses RFB only (uppercase is
  unreliable — QEMU emulates Shift itself and our own Shift events desynchronize it).
* **Unicode.** Windows: the plugin drops a payload file and a PowerShell typer into the guest and
  registers a scheduled task with `-LogonType Interactive`, so the text is typed *inside the user's
  session* via `SendKeys` — layout and modifiers stop mattering, and the VM is not restarted. Linux:
  `xdotool type` (X11) or `wtype` (Wayland) inside the active session; both paths run through the
  guest agent in a single call.
* **Guest channel.** All `qm` calls for one VM (guest exec, status, OS info, sendkey through the
  monitor) are serialised with a 250 ms gap: QEMU
  serves a single QMP client at a time and PVE's QMP timeout is 5 s, so back-to-back calls can steal
  each other's replies. A failed call is retried once, and only when PVE answers “agent is not
  running” — that check happens before the command is sent, so the retry cannot run anything twice.
  A file chunk carries the request marker and the real file length next to the data, so a foreign
  reply (a reused pid) or a short one is retried instead of being mistaken for the end of the file.
* **Output encoding.** Guest bytes are decoded from the raw bytes: UTF-8 when they are valid,
  otherwise the console OEM code page (`chcp`) or the system ANSI code page — whichever reads as
  text. Windows mixes the two: `cmd.exe` messages arrive in ANSI even when `chcp` reports OEM.
  Non-ASCII `command` text travels as a base64 envelope instead of the raw QMP request, and file
  data goes over stdin: both work around byte-per-character truncation in PVE
  ([#6609](https://bugzilla.proxmox.com/show_bug.cgi?id=6609)) and the ~32 KB command-line limit of
  a Windows guest.
* **Clipboard.** Two channels. The guest-agent channel runs a scheduled task in the logged-in
  Windows session (`Set-Clipboard`/`Get-Clipboard`; the clipboard is per-session, so SYSTEM in
  session 0 cannot see it) or `xsel`/`xclip`/`wl-copy`/`wl-paste` in the active Linux session;
  it works on SPICE VMs (`vga: qxl`) and needs a logged-in session. The VNC channel uses
  `ClientCutText` for writing and the extended clipboard pseudo-encoding
  (`VNC_ENCODING_CLIPBOARD_EXT`) with `CAPS`/`REQUEST`/`PROVIDE` for reading; QEMU passes those bytes
  to the guest through `qemu-vdagent`, so that VM needs `vga: <type>,clipboard=vnc` **and** a full
  stop/start (device arguments are fixed at start-up), plus a SPICE agent in the guest. It is used as
  a fallback when the guest-agent channel is unavailable.
* **Frames.** RFB Raw/CopyRect rectangles are composited into RGBA (QEMU leaves alpha at zero),
  optionally cropped and downscaled, then encoded to PNG with `node:zlib`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `CONSOLE_FAILED` right after connecting, node reports nothing useful | The node's `sshd` does not accept `LC_*`, so `qm` never received the VNC password. Add `AcceptEnv LC_*` to `sshd_config` and reload sshd. |
| `Host key verification failed` | The node's key is not in `known_hosts` and the plugin runs in batch mode. Run `ssh <node>` once, or set `sshExtraOptions: ["StrictHostKeyChecking=accept-new"]`. |
| A frame comes back almost uniform (`blank: true`) | The guest blanked its display or is locked. The tools already send Shift + pointer jitter to wake it; a locked session needs a password (`console_type` + `console_key`). |
| `unable to connect to VM qmp socket — timeout after 51 retries` | Something else holds the VM's single QMP socket (a hung `qm monitor`/QMP client). Find and kill that client on the node; do not restart the VM. |
| Uppercase letters turn into garbage | You are on `inputChannel: vnc`, where QEMU's own Shift emulation fights our Shift events. Use `auto`. |
| Latin characters are not typed at all on a login screen | The guest layout is not Latin: `console_key` with `alt+shift`, then type. |
| `vm_*` tools report that the agent is not running | `qemu-guest-agent` is missing or wedged (`Restart-Service qemu-ga` on Windows, `systemctl restart qemu-guest-agent` on Linux). Console tools keep working. |
| `vm_exec` answers `STILL_RUNNING` | The command outlived `timeoutMs` and **is still running** in the guest. Give long commands a larger `timeoutMs`; the reported pid lets you poll for the result. |
| `UNICODE_ARGV_WINDOWS` | `argv` contained non-ASCII. Pass the text as `command` instead — that path travels as a base64 envelope. |
| `STALE_REPLY` | The guest agent answered with a foreign reply (a reused pid) three times in a row. Call the tool again; if it keeps happening, restart the agent (`Restart-Service QEMU-GA`). |
| `agent is not running` on a guest whose agent is installed | The QGA channel blinked — PVE's 5 s QMP timeout on a busy guest. The plugin retries once by itself; if it keeps happening, the agent is really wedged (see the row above). |
| Console dies after ~15 minutes of idling | That is the `qm vncproxy` bridge timeout. Any tool call reopens the session automatically. |

## Security

This plugin gives an agent **root-level hands inside your VMs**. Be deliberate about it:

* **Every action is executed without an approval prompt.** The only gate is `allowVmids`, which is
  empty by default; list only the VMs you are willing to let an agent touch, and keep the list
  short.
* **`vm_exec` runs as root/SYSTEM in the guest**, `vm_file_write` can write anywhere the agent can,
  and the console tools can drive a logged-in desktop. Treat an allowed VM as a compromised host:
  do not keep long-lived secrets in it while the plugin is enabled.
* **Root SSH to the node is required** (`qm` needs it). Use a dedicated key, restrict it to the
  nodes you need, and consider `from=`/`command=` restrictions in `authorized_keys` where possible.
  The plugin passes the whole host environment to the ssh child, as any ssh call does.
* **`sshExtraOptions` accepts arbitrary `-o` options**, including `ProxyCommand` — it is a
  privileged escape hatch for the person who configures the plugin, not for the model.
* **VNC passwords are generated per session** (8 printable ASCII characters) and handed to `qm`
  through the environment via `SendEnv`, so they do not show up in `ps`. The QEMU password is
  scoped to the VM and expires with the session.
* **The plugin talks only to your node.** No telemetry, no outbound connections of its own.

## Limitations

* Proxmox VE only, QEMU VMs only — no LXC containers, no other hypervisors.
* Clipboard tools move **text only** (no files, no images) and only inside a logged-in session:
  the guest-agent channel needs a running `qemu-guest-agent` and a desktop session, the VNC fallback
  additionally needs `clipboard=vnc` on the VGA device and a SPICE agent in the guest.
* Unicode typing in Windows needs an interactive session; on the login screen only ASCII through
  `console_type` works.
* One console session per VM id, serialized with a mutex; the session is closed on idle.
* The console tools do not work with a serial console (`vga: serialN`) — there is no framebuffer.
* Several PVE hosts are supported as separate entries, but each entry has **one ssh transport**: in
  a cluster, point it at the node that owns the VM. Migration and cross-node lookup are not followed.
* Not yet verified: Proxmox VE 7 and 9, Linux guests with Wayland-only desktops, several hosts behind
  a Proxmox cluster API (only per-node ssh is used).

## Development

```bash
npm run check                       # node --check on every runtime file (no harness needed)
node tools/check-client.mjs         # browser bundle format (classic script, exports, inject)
node tools/check-plugin.mjs         # settings schema, tool set, JSON schemas, layout contract
```

`check-plugin.mjs` imports the plugin, and the plugin imports the harness packages
(`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`), so run it where those resolve — the
easiest way is to install the checkout into a profile with `link:` and run the script from there:

```bash
dsh plugin --profile web add link:/path/to/dsh-pve-vm
cd /path/to/dsh-pve-vm && node tools/check-plugin.mjs
```

For a bare checkout, point `DSH_PACKAGES` at the harness package directory
(`…/@deepseek-ai/dsh/node_modules/@deepseek-ai`) — the script uses it as a fallback for the
compiler it needs.

Live probes need node access only (no harness):

```bash
node tools/probe-rfb.mjs --vmid 100 --ssh-config ~/.ssh/config --out /tmp/shot.png
node tools/probe-rfb.mjs --vmid 100 --click 640,400 --after /tmp/after.png
node tools/live-test.mjs --vmid 100 --ssh-config ~/.ssh/config --out probe-out
node tools/clipboard-test.mjs --vmid 100 --text "hello" --out /tmp/clipboard.png
```

All of them talk to the node exactly like the plugin does (`qm vncproxy` over ssh), so they are the
fastest way to tell a plugin bug from a node-side problem.

## License

MIT — see [LICENSE](LICENSE).

Proxmox® is a registered trademark of Proxmox Server Solutions GmbH. This project is an
independent plugin and is not affiliated with or endorsed by Proxmox Server Solutions GmbH or by
the DeepSeek Harness project.
