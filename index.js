/**
 * dsh-pve-vm — control of Proxmox VE VMs from DeepSeek Harness.
 *
 * Two channels over one ssh transport per PVE instance:
 *   • console (VNC/RFB through `qm vncproxy`) — see the screen and click, any guest OS;
 *   • guest agent (`qm guest exec`/`qm guest cmd`) — commands, files, state.
 *
 * Settings arrive through the `settings` service from the form built from the exported
 * schema {@link Config}; the id of the entry in `cordis.patch.yml` must match the
 * settings namespace (`pve-vm`).
 */
import { Config, resolveSettings, snapshot } from './lib/config.js';
import { ControllerPool } from './lib/pool.js';
import { ConsoleView } from './lib/view.js';
import { registerViewRoutes } from './lib/routes.js';
import { createPanelActions } from './lib/panels.js';
import { ConfirmationStore } from './lib/confirm.js';
import { consoleTools } from './tools/console.js';
import { guestTools } from './tools/guest.js';
import { lifecycleTools } from './tools/lifecycle.js';
import { snapshotTools } from './tools/snapshot.js';
import { storageTools } from './tools/storage.js';
import { storageAdminTools } from './tools/storage-admin.js';
import { nodeTools } from './tools/node.js';
import { clusterTools } from './tools/cluster.js';
import { backupTools } from './tools/backup.js';
import { backupJobTools } from './tools/backup-jobs.js';
import { lxcTools } from './tools/lxc.js';
import { poolTools } from './tools/pools.js';
import { accessTools } from './tools/access.js';
import { networkTools } from './tools/network.js';
import { firewallTools } from './tools/firewall.js';

export { Config };
export const name = 'pve-vm';
export const inject = ['tools', 'attachments', 'subprocess'];

/**
 * Attach the plugin to the composition.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {Record<string, {get?: () => unknown}>} config live settings values.
 */
export function apply(ctx, config) {
  const settings = () => resolveSettings(snapshot(config));
  // One controller per instance: the sessions, the OS and code-page caches and
  // the per-VM `qm` queues are all keyed by a bare vmid, which is only unique
  // inside one host (see lib/pool.js).
  const pool = new ControllerPool({
    settings,
    spawn: (spec) => ctx.subprocess.spawn(spec),
    cwd: process.cwd(),
  });
  ctx.effect(() => () => pool.closeAll());

  // Dangerous operations (power off, destroy, resize, apt upgrade …) are
  // confirmed with a token: the first call changes nothing and returns it.
  const confirms = new ConfirmationStore();
  const deps = { pool, settings, attachments: ctx.attachments, confirms };
  const tools = [
    ...consoleTools(deps),
    ...guestTools(deps),
    ...lifecycleTools(deps),
    ...snapshotTools(deps),
    ...storageTools(deps),
    ...storageAdminTools(deps),
    ...nodeTools(deps),
    ...clusterTools(deps),
    ...backupTools(deps),
    ...backupJobTools(deps),
    ...lxcTools(deps),
    ...poolTools(deps),
    ...accessTools(deps),
    ...networkTools(deps),
    ...firewallTools(deps),
  ];
  for (const tool of tools) ctx.tools.register(tool);

  // Observation panel: the client half pulls frames from these routes. A
  // composition may have no web server at all (headless profile) — then there is
  // simply no panel while the tools keep working, so the dependency is declared
  // through ctx.inject instead of the plugin's mandatory `inject` list.
  const view = new ConsoleView({ pool, settings });
  const actions = createPanelActions({ pool, confirms });
  ctx.inject(['webServer'], (scoped) => registerViewRoutes(scoped.webServer, { view, actions }));

  // The computer-use slot is per composition: if another provider has already taken it,
  // the plugin tools still work, so the error is only recorded.
  ctx.inject(['computerUse'], (scoped) => {
    try {
      scoped.computerUse.register('pve-vm');
    } catch (error) {
      scoped.logger?.warn?.(`pve-vm: the computer-use slot is taken: ${error?.message ?? error}`);
    }
  });
}
