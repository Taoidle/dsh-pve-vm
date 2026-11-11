# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- README: "Which actions need a confirmation" lists every gated tool and action.
- `vm_detail` — read-only RRD history (`rrddata`, with `timeframe` and `cf`) and the
  `snapshot`/`clone`/`copy` feature probe, so support can be checked before an operation.
- `vm_guest` — cloud-init read/dump/set/delete, guest filesystem freeze/thaw, guest user password,
  allow-listed `exec` plus `exec-status`, and the OS/filesystem/interface probes over the QEMU agent.
  Exactly one guest password endpoint exists on PVE 7.4 (`agent/set-user-password`) and the password is
  never echoed back.
- `vm_passthrough` — node PCI/USB hardware lists and `hostpciN`/`usbN` attach or detach. Attach is
  danger, detach destroy; both go through the confirmation token. PCI changes need a stopped VM.
- `vm_disk` — `unlink`, `pending-delete`, and detached `unusedN` volumes in `list`.
- `lxc_clone`, `lxc_migrate`, `lxc_resize`, `lxc_move_volume`, `lxc_template`, `lxc_feature` and
  `lxc_rrddata`; the task-returning calls await their UPID.
- `cluster_ha` — HA resources, groups and current status; `cluster_replication` — replication jobs and
  `schedule_now`; `cluster_options` — cluster-wide options; `cluster_metrics` — metrics servers;
  `cluster_tasks` — the cluster task list with client-side filtering.
- `node_dns`, `node_time`, `node_disks`, `node_apt_repos`, `node_hosts`, `node_wakeonlan`,
  `node_execute`, `node_rrddata` and `node_diagnostics` — the remaining node administration views and
  writes, including the `/nodes/<node>/execute` batch endpoint and the `/report` diagnostic fallback.
- `pve_domain`, `pve_tfa`, `pve_permissions`, `pve_password` and `pve_token_rotate` — realm management,
  TFA entries, effective permissions, the token owner's own password and token rotation.
- `pve_security_group`, `pve_ipset`, `pve_alias` and `pve_firewall_extra` — security groups, IPSets,
  aliases, cluster firewall options, the node firewall log and references.
- `pve_certificate`, `pve_subscription` and `pve_notifications` — certificate lifecycle, subscription
  key management and the notification-endpoints probe.
- `lib/admin-util.js` — shared validators, node resolution, confirmation of block text (PEM, hosts,
  scripts) and the "feature is not in this PVE release" answer.
- README sections for the new tools; the mock-server suite now covers every new tool, its confirmation
  gate and the 404/501 fallbacks.

### Changed


- PVE 7.4 has no `DELETE /nodes/{node}/qemu/{vmid}/pending`: `pending-delete` performs the same
  `qm set --delete` operation through `PUT /config` with `delete=<key>`.
- PVE 7.4 has no per-VM `fsfreeze` or `password` endpoints: `vm_guest` uses the agent's
  `fsfreeze-freeze`, `fsfreeze-thaw` and `set-user-password` calls. Thawing is deliberately not gated,
  so a frozen guest can always be released.
- `PUT /cloudinit` on 7.4 only regenerates the drive; `cloudinit-set`/`cloudinit-pending` write the
  fields (or `delete`) through `PUT /config` and then regenerate.
- `lxc_feature` is read-only: 7.4 exposes `GET .../feature` but no write endpoint; container feature
  flags remain config keys.

### Fixed

- `vm_backup` `start` with `mode=stop` or `mode=suspend` now needs a confirmation token: those modes
  stop or pause the guest for the whole backup. `mode=snapshot` still runs directly.
- `backup_job` `run` now checks the stored job mode and needs a token when it will stop or suspend the
  guests.
- `pve_pool` `update` is a danger action: replacing the member list changes which pool-derived ACLs
  apply, and the confirmation summary lists the added and removed guests.
- `lxc_power` `shutdown` is now `danger`, matching `vm_power`, so a graceful stop cannot run unguarded
  just because the guest is a container.
- Irreversible actions are labelled `destroy`, not `danger`: `vm_snapshot` delete/rollback,
  `lxc_snapshot` delete/rollback, `storage_content` delete-volume and `pve_storage` delete.
- `pve_storage` create/update/delete and `storage_content` download-url/delete-volume now check the
  `pvesh` exit code and raise `NODE_COMMAND_FAILED` with the stderr instead of reporting success.
- The offline suite pins the new gates: dangerous backups, pool updates and LXC shutdown perform
  nothing without a token, and a failing storage write surfaces its error.
- Tools that take multi-line text (custom certificates, `/etc/hosts`, shell scripts) no longer trim the
  trailing newline or interior whitespace before sending it to the API.

## [0.9.2] — 2026-11-11

### Fixed

- Tool answers could contain `undefined` members (`guest` on a cluster-wide firewall answer, `swap` on a
  node without swap), which the harness rejects as "not lossless JSON". The instance mapper now prunes
  them once for every tool, and the offline suite round-trips a firewall answer to prove it.

## [0.9.1] — 2026-11-11

### Fixed

- `node_network` and `pve_firewall` used the text renderer with an object value, so every answer reached
  the agent as `[object Object]`. They now render the JSON of the answer, and the offline suite checks
  that both render objects as text.

## [0.9.0] — 2026-11-11

### Added

- `node_network` — list, create, update, delete and apply the node's network configuration. Changes
  are staged in `/etc/network/interfaces.new`; `apply` is the only action that touches the running
  system.
- `pve_firewall` — cluster, node and guest scopes: status, enable/disable, default policy and rules.
  `status` names the management ports (8006, 22) that have no ACCEPT rule.
- Commit-confirm for both: before a change that can cut access, the previous files are copied to
  `/var/lib/dsh-pve-vm/rollback/<unit>/` and a detached `systemd-run --on-active=<N>s` unit restores
  them and reloads (`ifreload -a`, `pve-firewall restart`). The timer is cancelled once the API answers
  again; otherwise it fires and the node comes back by itself.
- `lib/netguard.js` — the arming/cancelling/probing primitives, with unit and path validation.
- README: "Network changes that can lock you out" and "The firewall, with a way back".

### Fixed

- A kept-alive API socket closed by the node between two calls made the next GET fail with
  `socket hang up`. Idempotent GETs are now retried once on a fresh agent; mutating verbs are not
  retried, because the node may have applied them before the connection broke.

## [0.8.2] — 2026-11-11

### Fixed

- `pve_role get` read `/access/roles/{id}` as `{ privs }`, but Proxmox answers a map of privilege → 1
  even with `--output-format json`; the render now joins the keys instead of printing "no privileges".

## [0.8.0] — 2026-11-11

### Added

- Access control: `pve_user`, `pve_group`, `pve_role`, `pve_acl` and `pve_token`. Every write is
  confirmed with a token; role updates can append to the existing privilege set, and `pve_acl`
  refuses to mix two subject kinds in one entry.
- `pve_token create` prints the secret exactly once and says so — Proxmox never shows it again.
- README: the two-token pattern (a `DSHOperator` role for guests/storage/backups, a second card with a
  `PVEAdmin` token for access control) and the exact `pveum` recipe.

### Changed

- A 401/403 from the API is explained as a missing privilege instead of printing an empty body:
  `permission denied — the token's role does not grant this path`.

## [0.7.0] — 2026-11-11

### Added

- Storage definitions: `pve_storage` lists, creates, updates and deletes `/storage` records, with the
  storage type and the content kinds kept as an enum so a typo cannot hide a datastore.
- Storage contents: `storage_content` lists one content kind, uploads an ISO from this machine
  (streamed `multipart/form-data`, no buffering), downloads a file from a URL on the node, deletes a
  volume and imports a disk into a VM. Delete and import are confirmed.
- `PveApi.upload()` and `ApiController.waitTask()`: the upload body is piped from disk with an exact
  content-length, and the task id it answers with is awaited like every other long operation.
- `PVE_API_CONFIGURATION` for a token that is not written as `user@realm!tokenid=secret`; it surfaces
  as `BAD_ARGUMENT` instead of a generic node-command failure.

### Changed

- The API client's response handling is one private `#settle` step, shared by requests and uploads.

## [0.6.0] — 2026-11-11

### Added

- LXC containers: `lxc_list`, `lxc_status`, `lxc_power`, `lxc_create`, `lxc_config`,
  `lxc_snapshot`, `lxc_exec` and `lxc_delete`. Containers share the VM id space and the
  `allowVmids` guard; `lxc_exec` runs `pct exec` over the existing ssh channel.
- Scheduled backup jobs: `backup_job` lists, creates, updates, deletes and runs
  `/cluster/backup` records, reusing the job's own storage, guests and mode for `vzdump`.
- Resource pools and templates: `pve_pool` and `vm_template`.
- New confirmed actions: container stop/reboot/suspend, configuration writes, snapshot
  delete/rollback, container destroy, backup-job changes, pool deletion and the template
  conversion — all through the same single-use confirmation token.

### Changed

- The management plane is the Proxmox API for these operations, so a card needs an
  `apiToken`; instance-level `node` is used for creates when set, otherwise the online node.

## [0.5.0] — 2026-11-11

### Added

* **API transport.** A host card can carry `apiUrl` / `apiToken` (`user@realm!tokenid=secret`), plus
  `mode` (`auto` | `api` | `ssh`), `node`, `apiTlsFingerprint` and `apiInsecureTls`. With a token the
  management plane speaks the Proxmox API: `qm` verbs map onto REST calls, long operations (start,
  destroy, clone, migrate, backup) are awaited through their task, and `qmrestore` becomes a POST on
  the VM endpoint. The console and the guest agent keep using ssh.
* **Cluster-wide placement.** `nodeFor(vmid)` reads `/cluster/resources`, so snapshots, disks,
  configuration and backups work on a VM that lives on another node than the entry points at. The ssh
  transport answers with its own node, as before.
* **Token validation by shape.** A bare secret is refused with the expected
  `user@realm!tokenid=secret` form instead of a 401 that says nothing.
* `tools/check-api.mjs`: a local HTTP server pins the token header, the `pveshGet` answer shape, the
  `qm` → REST translation, UPID awaiting and the fingerprint normalisation.

### Changed

* The host card grew the API fields; the API token is never painted back into the form — leaving the
  field empty keeps the stored secret.

## [0.4.0] — 2026-11-11

### Added

* **VM lifecycle.** `vm_power` (start / shutdown / stop / reboot / reset / suspend / resume),
  `vm_create` and `vm_destroy`. Shutdown is ACPI with a timeout; stop and reset do not ask the guest.
* **Snapshots and configuration.** `vm_snapshot` (list / create / delete / rollback) and `vm_config`
  (get / pending / set, including deleting a key).
* **Storage.** `vm_disk` (list / rescan / trim / resize / move / attach-iso / detach-iso) and
  `node_storage`.
* **Node administration.** `node_status` (overview / apt / services / tasks / syslog / network),
  `node_apt` (update / upgrade), `node_service` and `node_task` — all over `pvesh`, still without a
  PVE API token.
* **Cluster awareness.** `cluster_status` (status / resources / nodes / nextid / ha). `pvesh` also
  resolves the node name from `hostname -s`, so a VM can be found without hard-coding the node.
* **Everything else, guarded.** `pve_api` for the long tail of the Proxmox API, plus `vm_backup`
  (vzdump list / start / restore), `vm_clone` and `vm_migrate`.
* **A second confirmation for dangerous operations.** The first call performs nothing and returns a
  token bound to the action and the target; repeating the call with `confirm: "<token>"` within three
  minutes performs it. A token works once, and a token issued for another VM or action is refused
  with `CONFIRM_MISMATCH`.
* The right-sidebar panel gained power buttons (start / shut down / stop / reset) with the same
  confirmation step for the dangerous two.

### Changed

* `node_status action: overview` is trimmed to uptime, load, memory, rootfs and the PVE/kernel
  versions — the raw status carries every CPU flag in one very long string.

## [0.3.5] — 2026-11-11

### Fixed

* **The host-card editor no longer swallows what you type.** Its inputs were re-rendered from
  the *parsed* value on every keystroke, so `100,` collapsed back to `100` and no separator,
  space, or letter could ever be entered — only bare digits. The card now keeps the raw text in
  its draft and converts once on save, exactly like the global rows always did.

### Changed

* An allow-list token that is not a positive vmid now **refuses the save** with an error naming
  the offending token, instead of being silently dropped (a whitelist that loses an id quietly
  is a wrong whitelist).

## [0.3.4] — 2026-11-11

### Changed

* **An allow-list accepts the separators people actually type.** `100, 101`, `100，101`, `100、101`,
  `100; 101`, or one id per line all parse to the same list. Before, only the ASCII comma worked and a
  full-width comma silently dropped every id — which reads as "the list is empty", not as an error.

## [0.3.3] — 2026-11-11

### Changed

* **The host list is edited as cards, not as JSON.** Settings → Proxmox VE now shows one complete
  configuration card per PVE host — name, `root@host:port`, allow-list, note — with **Make default**,
  **Edit** and **Remove** on the card and an **Add host** form for a new one. The card writes the same
  `instances` array as before, one field per host, so the config file format is unchanged.
* The 0.2.x single-host fields (`sshHost`, `sshUser`, …) are shown only while no host card exists:
  they are the source of the generated `default` entry, and showing both at once would be two
  editors for one host. The rest of the settings sit under a **Global settings** heading.
* A card's allow-list hint now says what the code does: an empty per-host list inherits the global
  list, and only an empty global list forbids everything.

## [0.3.0] — 2026-11-10

### Added

* **Several Proxmox VE hosts from one plugin.** The settings gained an `instances` list — `name`,
  `sshHost`/`sshUser`/`sshPort`/`sshKeyPath`/`sshConfigFile`/`sshExtraOptions`, a per-instance
  `allowVmids` and a free-form `description` — plus `defaultInstance`. Every tool takes an optional
  `instance` argument; without it the call lands on `defaultInstance`, or on the first entry when
  that is empty. An unknown name fails with `BAD_INSTANCE` and lists the configured hosts, and each
  tool result carries the `instance` it came from, so an answer is never ambiguous.
* **`vm_status` without a `vmid` now answers with the inventory** of every configured host: its
  endpoint, its allow-list and the live consoles on it.
* **The "VM screen" panel has a host selector** when more than one host is configured, and the panel
  state, frames and releases are per instance. A stale instance name from a previous configuration
  falls back to the default instead of blanking the panel.

### Changed

* **Isolation is structural, not a naming convention.** Each host gets its own controller — its own
  console sessions, guest-agent OS and code-page caches, and `qm` queues — because all of that state
  is keyed by a bare vmid, and VM 100 on two nodes is two different machines. `vm_exec`, the console
  tools and the panel therefore cannot mix two hosts' sessions.
* **`allowVmids` is decided per host.** An entry with an empty list inherits the top-level list; a VM
  id allowed on one host is not allowed on another.
* **A 0.2.x configuration keeps working unchanged.** With no `instances`, the host described by the
  top-level ssh fields becomes the single instance `default`, and the ssh and `allowVmids` fields are
  still read on their own — the plugin only ever needs `instances` when there is more than one host.

### Notes

* One instance is one ssh transport. In a Proxmox cluster, point an entry at the node that owns the
  VM (`qm vncproxy` and the guest agent are node-local); a VM that migrates is not followed
  automatically. Add one entry per node you want to reach.

## [0.2.5] — 2026-10-23

### Fixed

* **The first frame of a QXL/SPICE VM could come out blank.** On guests with a hardware cursor
  (`vga: qxl`, that is every SPICE VM) QEMU sends a “cursor only” update before the full frame, and
  the first `waitForUpdate` sometimes ended exactly there — `console_shot` and the “VM screen” panel
  returned a white frame (reproduced on a 3440x1336 guest: the single wait returned the blank frame,
  the real one arrived 79–300 ms later). `RfbClient.waitForFrame()` now keeps reading until an update
  carries a real rectangle, console captures use it, and the panel allows the first frame of a session
  up to 1.5 s (`FIRST_FRAME_WAIT_MS`) while later frames keep the cheap incremental wait.
* **The clipboard did not work on SPICE VMs at all.** `console_paste` and `console_clipboard` required
  `vga: <type>,clipboard=vnc` plus a SPICE agent, which is impossible on `vga: qxl`: the
  `com.redhat.spice.0` channel is taken by `spicevmc`, and enabling `clipboard=vnc` there would remove
  the SPICE agent (dynamic resolution and the owner's SPICE clipboard). Both tools now use the guest
  agent first — on Windows a scheduled task in the logged-in user session (the clipboard is
  per-session; SYSTEM in session 0 cannot see it), on Linux `xsel`/`xclip`/`wl-copy`/`wl-paste` in the
  active graphical session, with `XAUTHORITY` discovered the same way as for `vm_type_text`. The VNC
  clipboard stays as a fallback when the VM has `clipboard=vnc`. A logged-in session is required:
  there is no clipboard on the logon screen.
* **Non-ASCII in a guest `argv` could wedge the guest agent.** PVE truncates non-ASCII QMP payloads
  (`libio-multiplex-perl`, [Proxmox #6609](https://bugzilla.proxmox.com/show_bug.cgi?id=6609),
  [#6292](https://bugzilla.proxmox.com/show_bug.cgi?id=6292)), so the request arrives cut, `qm guest
  exec` times out and `qemu-ga` gets stuck until its service is restarted. `VmController` now refuses
  such an `argv` before anything is sent (`NON_ASCII_ARGV`) and points at stdin/base64 envelopes.

### Changed

* **`typeTextArgv` passes the guest script via base64.** The script from `guestTypeCommand` may contain
  non-ASCII and used to travel in `argv` — exactly the failure above. It now goes as a base64 payload
  decoded into `/bin/sh -s`, with the text still arriving in `$1`.
* `console_paste` and `console_clipboard` timeouts were raised for the task round trip (paste 180 s,
  read 120 s, a guest-agent read waits at least 15 s), and the clipboard result gained `channel` and
  `truncated`.
* **The default Linux input script now picks the first active graphical session.** `loginctl` on
  RedOS 8 reports an empty `Display` even for an X11 session, so the old `[ -n "$disp" ]` criterion
  fell through to root's tty sessions and `xdotool` failed with “No protocol specified”. The script
  filters by session type (`x11`/`wayland`/`mir`) and breaks on the first match.

## [0.2.4] — 2026-10-18

### Added

* **Simplified Chinese (`zh`) translation.** The web UI's settings card and the “VM screen” sidebar
  panel now follow the Chinese locale that DeepSeek Harness ships (`zh`, falling back to `en` for
  anything untranslated). The plugin card in *Settings ▸ Plugins* also reads Chinese, because
  `locale/zh.json` joins the existing `en`/`ru` metadata files. `tools/check-client.mjs` now fails
  when a locale is missing a key or a `{placeholder}` differs between dictionaries, so the three
  dictionaries cannot drift apart silently.

## [0.2.3] — 2026-10-17

### Fixed

* **The npm package was missing `tools/`, so installing from the registry was broken.** `index.js`
  imports `./tools/console.js` and `./tools/guest.js` — the definitions of all 16 tools — but the
  `files` list in `package.json` never included that directory. The published tarball therefore could
  not even be imported: `dsh plugin --profile web add dsh-pve-vm` failed with
  `ERR_MODULE_NOT_FOUND: Cannot find module '…/tools/console.js'`. Every release up to and including
  0.2.2 was affected; the GitHub install path (`github:taxah92/dsh-pve-vm`) was not, because it uses
  the repository itself. `files` now includes `tools/`, and the two-copy gate
  (`tools/sync-pve-vm.mjs`) checks that every relative import of the packed tree resolves inside the
  package — so packaging cannot silently drop a directory again. The check was verified against the
  old list: it reports exactly `index.js → ./tools/console.js` and `index.js → ./tools/guest.js`.

### Notes

* No runtime code changed since 0.2.2.

## [0.2.2] — 2026-10-17

The guest-agent half made reliable. Everything below was found by running the plugin against a real
Windows guest (Windows Server 2025 with Defender, 4 GB of RAM), not by reading the code: a live
19-check suite went from “fails somewhere on every run” to green.

### Fixed

* **A non-ASCII `command` could wedge the guest agent until the `QEMU-GA` service was restarted.**
  The fault is not in `qemu-ga`: Proxmox truncates non-ASCII QMP payloads by one byte per character
  (`IO::Multiplex` writes bytes but slices by characters,
  [Proxmox #6609](https://bugzilla.proxmox.com/show_bug.cgi?id=6609),
  [#6292](https://bugzilla.proxmox.com/show_bug.cgi?id=6292)), so the `guest-exec` JSON arrives cut.
  The agent never answers, the QMP call times out, PVE tears the QGA channel down and `qemu-ga` gets
  stuck on EOF. A Windows `command` containing non-ASCII now travels as a base64 envelope — a `.cmd`
  file written in the guest OEM code page and launched as a file, with raw output returned as base64;
  `argv` with non-ASCII is refused before anything is sent (`UNICODE_ARGV_WINDOWS`).
* **Russian output came back as mojibake** (`lvl=¢¥¤¥­¨ï` instead of `Сведения`). Two things
  stacked up: PVE puts guest bytes into JSON as latin-1, and a Windows console writes text in its OEM
  code page (`chcp` → 866), not UTF-8. Output is now decoded from bytes — latin-1 → UTF-8, or the
  guest code page when it is not UTF-8 — with the code page cached per VM. One code page turned out
  to be not enough: the messages of `cmd.exe` itself arrive in the system **ANSI** code page
  (cp1251 on a Russian system) even though `chcp` reports the OEM one, so the decoder tries both and
  keeps the candidate without box-drawing/currency junk — `Текущая кодовая страница: 866` instead of
  `╥хъє∙р ъюфютр ёЄЁэшЎр: 866`.
* **A command longer than 30 s reported a false failure** (`exitcode -1`, empty output): `qm guest
  exec` waits 30 s by default and returns `{pid}` **without** `exited`, and the plugin did not check.
  It now passes `--timeout` (our timeout minus 2 s) and inspects `exited`; a command that did not
  finish is reported as `STILL_RUNNING` with its pid and whatever output was collected, instead of
  being called a failure.
* **`vm_file_write` worked only up to ~8 KB.** The payload travelled as base64 inside `argv`, and a
  Windows command line is capped at 32 767 characters (`CreateProcess`; Linux has `MAX_ARG_STRLEN`),
  so 10 KB gave `Failed to execute helper program` and 64 KB failed locally with `spawn E2BIG`.
  File data now goes over stdin (`--pass-stdin`), which raises the limit to **1 MiB per call**.
* **`vm_file_read` broke the QGA channel at 1 MiB.** An agent reply above ~512 KB does not survive
  (`guest-exec-status … got timeout`; 512 KB still took ~2 s). Files are now read in 256 KiB chunks
  with an offset, and a chunk is retried — reading is idempotent.
* **A successful but short or foreign agent reply could silently corrupt a result.** `qemu-ga`
  reuses pids, and the tail of a previous command can arrive as the answer to a new one (one live
  run got the stdout of a running `ping` in reply to `chcp`; another got the contents of a file read
  earlier in reply to reading a **missing** path). The chunked read mistook a short reply for the end
  of the file and returned partial data with `truncated: false` — a silent wrong answer. Every read
  script and the non-ASCII command envelope now print a per-call request marker (`DSH_NONCE=`) and
  the real file length (`DSH_SIZE=`); a reply that does not match the marker, or a chunk that does
  not add up, is retried up to three times, and if it still does not, the tool fails
  (`FILE_READ` / `STALE_REPLY`) instead of returning a quietly incomplete or foreign result. A
  foreign reply to the non-ASCII envelope used to be parsed as “success with empty output” — that
  hole is closed too. `truncated` is now derived from the file length, so a file that exactly fills
  `maxBytes` is no longer flagged as truncated.
* **PowerShell progress noise ended up in error texts.** With stderr redirected, PowerShell
  serialises its progress stream into CLIXML (`#< CLIXML …`), and one 1 MiB read “failed” with that
  blob instead of a reason. Every generated script now starts with
  `$ProgressPreference='SilentlyContinue'`.

### Changed

* **All `qm` calls to one VM are serialised, with a 250 ms gap between them.** QEMU serves one QMP
  client at a time and accepts the next connection only after the previous one is closed; without
  the gap, back-to-back calls stole each other's replies (`guest-exec-status … got timeout`).
* A failed call is retried exactly once, and only when PVE answers “agent is not running” — that
  check runs **before** the command is sent, so nothing has been executed in the guest.
* `vm_status` now explains how to recover a wedged guest agent.
* Tool descriptions now state the real limits (1 MiB write over stdin, chunked reads, ASCII-only
  `argv`).

### Notes

* A command that outlives `timeoutMs` **keeps running** in the guest — the plugin says so honestly.
  Long commands are therefore better given a larger `timeoutMs` than cut off by the timeout.
* Residual transport flakiness on a busy guest is PVE/QMP behaviour, not the plugin: on mixed load
  one call in ~20 can still catch the 5-second QMP timeout, and `qemu-ga` can hand back the output of
  an earlier command when Windows reuses a pid. A chunked file read detects that case (the reply is
  checked against the file length) and retries; for a plain `vm_exec` reply there is nothing to check
  it against, so a foreign stdout remains possible — that is a `qemu-ga` artefact, not a plugin bug.

## [0.2.1] — 2026-10-14

The plugin card finally speaks Russian — along with the English title it always carried.

### Fixed

* **`locale/en.json` and `locale/ru.json` were written in a format the panel never reads.** The
  reader (`readPluginMeta` in `dsh-app-boot`) takes display text from a `meta` object —
  `{"meta": {"title": …, "description": …}}` — and silently drops a flat `{title, description}` file.
  Both files were flat, so the card in the plugin inventory showed the package name `dsh-pve-vm` and
  the manifest description, and the Russian text never appeared anywhere. Wrapped in `meta`: the card
  now reads “Proxmox VE VM control” / “Управление ВМ Proxmox VE” and follows the panel language.

### Checks

* `tools/check-plugin.mjs` now verifies the card metadata: the `meta` shape of every `locale/*.json`,
  field parity between the languages, and — through the installed harness — that `readPluginMeta`
  really answers with a translation map instead of the package-name fallback.

## [0.2.0] — 2026-10-13

Watch the agent work: a live VM screen in the right sidebar of the web UI.

### Added

* **The “VM screen” tab** — a right-sidebar panel that streams the frames the agent sees. The frames
  come from the agent's own RFB session, so no second VNC session appears and the `qm vncproxy`
  password is never reset; captures and tools share one session queue. Watch-only by design: the
  panel injects nothing into the guest.
* **`viewAutoOpen`** (off by default) — reveal the tab by itself when the agent touches a console.
* **`viewFollowAgent`** (on by default) — the panel follows the VM the agent works with; a VM chip
  pins it by hand. Watching never counts as agent work: frame requests suppress the activity mark
  (`withConsole(..., { mark: false })`), so the panel cannot chase itself.
* **`viewFps`** (2) and **`viewScale`** (2) — frame pace and resolution divisor, both changeable on
  the fly inside the panel.
* **Host routes** `/pve-vm/console/state`, `/frame` and `/release` on the harness web server,
  registered only when the composition has a `webServer`. They carry a loopback-only fence: Host must
  be loopback, a present Origin must match Host, `sec-fetch-site: cross-site` is refused and POST must
  be `application/json`. A harness bound to a LAN therefore keeps the panel dark.
* `RfbClient.waitForUpdate({ idleOk: true })` — silence at a message boundary means "the screen did
  not change" instead of an error, while a timeout inside a message stays fatal.

### Fixed

* **`inputChannel` and `sendkeyDelayMs` never reached the tools.** Both keys were missing from
  `CONFIG_KEYS`, so `snapshot()` dropped them and every run silently used the built-in `auto`/80 ms
  defaults. The form accepted the values, the code ignored them.

## [0.1.1] — 2026-10-13

Linux guest support. Everything below was found by running the plugin against a real RedOS 8
guest with a MATE desktop, not by reading the code.

### Fixed

* **Guest OS detection rejected almost every Linux distribution.** The guest agent reports `id`
  from `/etc/os-release`, and only IDs containing `linux` were accepted — RedOS reports `redos`,
  Debian `debian`, Ubuntu `ubuntu`. All of them landed in `other` and every `vm_*` tool answered
  *running a shell command is not supported for guest OS «other»*, so the whole guest-agent half
  was dead on Linux. Windows was unaffected (`mswindows`), which is why it went unnoticed.
  Windows is now matched first, Linux by `id`/`name`/`pretty-name`, and a non-Windows guest that
  answered `get-osinfo` with a non-empty `kernel-release` counts as Linux.
* **`vm_type_text` typed nothing on a GDM desktop.** The built-in typing script used
  `$home/.Xauthority`, which does not exist when GDM owns the session — RedOS and RHEL keep the
  file at `/run/user/<uid>/gdm/Xauthority`. `xdotool` then talked to the X server with no
  authorization at all, failed with *No protocol specified*, and the text never appeared. The
  script now tries `~/.Xauthority`, then the GDM path, then any `/run/user/<uid>/*/Xauthority`.
* **`vm_type_text` could not submit text.** `text=$(… | base64 -d)` — command substitution strips
  trailing newlines, so text ending in `"\n"` was typed without pressing Enter and the shell
  prompt never came back.
* **Console errors hid the actual cause.** When the node's `sshd` does not accept `AcceptEnv`,
  `LC_PVE_TICKET` never arrives and `qm vncproxy` exits with a precise
  *LC_PVE_TICKET not set, VNC proxy without password is forbidden* — but the RFB reader saw EOF
  before ssh had finished exiting, so only *the VNC stream was closed by the node* surfaced. The
  ssh stderr is now reported (after a short grace period), both during the handshake and when a
  live session dies mid-way.

### Known limitations

* Proxmox applies a **default 5-second timeout to QMP commands** (`PVE/QMPClient.pm`), and
  `guest-exec` waits for the guest agent to acknowledge. While a previous long command is still
  running inside the guest that acknowledgement arrives too late and the call fails with
  *qmp command 'guest-exec' failed - got timeout*. On an idle guest 10 out of 10 calls complete
  in about a second. `vm_exec` is currently synchronous and does not retry.

## [0.1.0] — 2026-10-13

Initial public release.

### Added

* **Console (VNC/RFB) tools** — `console_shot`, `console_move`, `console_click`, `console_drag`,
  `console_scroll`, `console_type`, `console_key`, `console_paste`, `console_batch`,
  `console_clipboard`, `console_release`. Frames come back as inline images with an attachment
  reference; `region` and `scale` cut the cost of large desktops.
* **Guest agent tools** — `vm_exec`, `vm_file_read`, `vm_file_write`, `vm_type_text`, `vm_status`
  through `qm guest exec` / `qm guest cmd`.
* **Transport** — a single ssh session to the Proxmox node; `qm vncproxy` bridges the VM's unix
  VNC socket to the plugin's stdin/stdout, so no port, TLS or websocket is involved. The VNC
  password travels as `LC_PVE_TICKET` via `SendEnv`, never in `argv`.
* **Reliable typing** — uppercase through Caps Lock (`qm monitor` → HMP `sendkey`), shifted
  symbols through RFB keysyms with a settle delay; `inputChannel` selects `auto`, `hmp` or `vnc`.
* **Unicode text** — on Windows, a scheduled task running in the logged-in user session uses
  `SendKeys`; on Linux guests, `xdotool` (X11) or `wtype` (Wayland) inside the active session.
* **Clipboard** — `console_paste` writes UTF-8 text into the guest clipboard over RFB
  `ClientCutText`; `console_clipboard` reads it back through the extended VNC clipboard
  (`VNC_ENCODING_CLIPBOARD_EXT`).
* **Settings card** — a client-side `settings.section` card (15 fields, English and Russian
  labels) backed by `configForms`, writing to the profile patch layer.
* **Checks** — `tools/check-plugin.mjs` (schemas, tool set, layout contract) and
  `tools/check-client.mjs` (browser bundle format), plus standalone probes
  (`probe-rfb.mjs`, `live-test.mjs`, `clipboard-test.mjs`, `clipboard-read-test.mjs`).

### Known limitations

* Proxmox VE only (`qm` CLI on the node); LXC containers are not supported.
* The node's `sshd` must accept `AcceptEnv LC_*`, otherwise the VNC password never reaches `qm`.
* Clipboard exchange needs `vga: <type>,clipboard=vnc` on the VM plus a SPICE agent in the guest,
  and applies only after a full VM stop/start.
* Unicode typing in a Windows guest needs a logged-in interactive session.
