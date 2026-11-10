/**
 * The controller pool: one {@link VmController} per PVE instance.
 *
 * A controller owns state that must not be shared between hosts — ssh sessions,
 * the OS and code-page caches, the per-VM `qm` queues — and all of it is keyed by
 * a bare vmid (VM 100 on two nodes is two different machines). Instead of
 * rewriting those maps into composite keys, each instance gets its own
 * controller whose `settings()` returns the settings of that instance: the class
 * keeps working unchanged, and the isolation is structural rather than a
 * convention someone has to remember.
 */
import { VmController, VmError } from './session.js';
import { instanceSettings } from './config.js';

/** A configured instance could not be found by the name given in a tool call. */
const BAD_INSTANCE = 'BAD_INSTANCE';

export class ControllerPool {
  /**
   * @param {{settings: () => object, spawn: (spec: object) => object, cwd: string}} deps
   *   `settings` returns the resolved settings (see {@link resolveSettings}).
   */
  constructor(deps) {
    this.deps = deps;
    this.controllers = new Map();
  }

  /** Names of the configured instances, in list order. */
  names() {
    return (this.deps.settings().instances ?? []).map((entry) => entry.name);
  }

  /** The instance a call acts on: the asked name, else the configured default. */
  resolve(requested) {
    const settings = this.deps.settings();
    const names = (settings.instances ?? []).map((entry) => entry.name);
    const asked = typeof requested === 'string' ? requested.trim() : '';
    if (asked.length === 0) return settings.defaultInstance ?? names[0];
    const exact = names.find((name) => name === asked);
    if (exact !== undefined) return exact;
    // Names are typed by hand in a tool call; a case difference is not a mistake
    // worth failing, an unknown host is.
    const folded = names.find((name) => name.toLowerCase() === asked.toLowerCase());
    if (folded !== undefined) return folded;
    throw new VmError(
      `no PVE instance named "${asked}" — configured: ${names.join(', ') || 'none'}; add it in the plugin settings`,
      BAD_INSTANCE,
    );
  }

  /**
   * The controller of one instance.
   * @param {string} [requested] instance name from the tool arguments.
   * @returns {{name: string, controller: VmController, settings: object}} the target.
   */
  target(requested) {
    const name = this.resolve(requested);
    let controller = this.controllers.get(name);
    if (controller === undefined) {
      controller = new VmController({
        settings: () => instanceSettings(this.deps.settings(), name),
        spawn: this.deps.spawn,
        cwd: this.deps.cwd,
      });
      this.controllers.set(name, controller);
    }
    return { name, controller, settings: instanceSettings(this.deps.settings(), name) };
  }

  /** Controllers of every instance that has been used, for the panel and the status tool. */
  used() {
    return [...this.controllers.entries()].map(([name, controller]) => ({ name, controller }));
  }

  /** Close every console session of every instance (plugin unload). */
  closeAll() {
    for (const controller of this.controllers.values()) controller.closeAll();
    this.controllers.clear();
  }
}
