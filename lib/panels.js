/**
 * Panel-driven actions: the buttons in the right sidebar.
 *
 * The panel is a thin client of the same operations the tools perform; the
 * confirmation rule is identical, so a click on "stop" without a token returns
 * the same "confirmation-required" payload a tool call returns.
 */
import { runGuarded } from './confirm.js';
import { VmError } from './session.js';

/** Power actions the panel can request, and how risky each one is. */
const POWER = {
  start: { risk: 'safe', args: (id) => ['start', id], note: 'power on' },
  shutdown: {
    risk: 'danger',
    args: (id, timeoutSec) => ['shutdown', id, '--timeout', String(timeoutSec)],
    note: 'graceful shutdown (ACPI)',
  },
  stop: { risk: 'danger', args: (id) => ['stop', id], note: 'hard power off' },
  reset: { risk: 'destroy', args: (id) => ['reset', id], note: 'hard reset' },
};

/**
 * Build the panel actions.
 * @param {{pool: object, confirms: object}} deps the instance pool and the confirmation store.
 */
export function createPanelActions(deps) {
  return {
    /**
     * Run one power action for the panel.
     * @param {{instance?: string, vmid: number, action: string, confirm?: string, timeoutSec?: number}} body the request.
     * @returns {Promise<object>} the outcome, or the confirmation request.
     */
    async power(body) {
      const target = deps.pool.target(body.instance ?? undefined);
      const controller = target.controller;
      const entry = POWER[body.action];
      if (!entry) throw new VmError(`unknown panel action "${body.action}"`, 'BAD_ARGUMENT');
      const vmid = controller.assertAllowed(Number(body.vmid));
      const timeoutSec = Math.min(Math.max(Number(body.timeoutSec ?? 60) || 60, 5), 900);
      const summary =
        `Panel button: power "${body.action}" on VM ${vmid} of ${target.name} — ${entry.note}.` +
        (body.action === 'shutdown' ? ` The guest gets ${timeoutSec} s.` : '');
      return runGuarded(
        deps.confirms,
        {
          args: { confirm: body.confirm },
          instance: target.name,
          action: `vm_power:${body.action}`,
          target: `${target.name}:vm:${vmid}`,
          risk: entry.risk,
          summary,
        },
        async () => {
          await controller.qmOk(entry.args(vmid, timeoutSec), { timeoutMs: 600_000 });
          const { stdout } = await controller.qm(['status', vmid], { timeoutMs: 20_000 });
          return {
            status: 'done',
            action: body.action,
            vmid,
            instance: target.name,
            state: stdout.replace(/^status:\s*/i, '').trim() || 'unknown',
          };
        },
      );
    },
  };
}
