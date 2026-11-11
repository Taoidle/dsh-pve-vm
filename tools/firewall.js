/**
 * Firewall: cluster, node and guest levels.
 *
 * Writes are dangerous in a way that is easy to underestimate: a firewall that is
 * enabled with a DROP policy and no rule for tcp/8006 removes the API (and the
 * panel) that would undo it. So every write at cluster/node scope runs the same
 * commit-confirm as the network: save the `.fw` files, arm a `systemd-run`
 * rollback that restores them and runs `pve-firewall restart`, apply, probe the
 * API, cancel the timer when the node still answers.
 *
 * Guest-level rules can only lock that guest out, not the node, so they are
 * confirmed but not timer-protected.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, renderValue } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';
import { armRollback, canCommitConfirm, cancelRollback, probeApi, rollbackId, runDetached } from '../lib/netguard.js';

/** Rule fields the API accepts. */
const RULE_FIELDS = ['type', 'action', 'enable', 'proto', 'dport', 'sport', 'source', 'dest', 'iface', 'log', 'comment', 'macro', 'icmp_type'];

/** The ports that carry this plugin's own access. */
const MANAGEMENT_PORTS = ['8006', '22'];

/** Where a scope writes its rules. */
function basePath(scope, node, { guestType, vmid }) {
  if (scope === 'cluster') return '/cluster/firewall';
  if (scope === 'node') return `/nodes/${node}/firewall`;
  if (scope === 'guest') return `/nodes/${node}/${guestType}/${vmid}/firewall`;
  throw new VmError(`unknown firewall scope "${scope}" — use cluster, node or guest`, 'BAD_ARGUMENT');
}

/** The configuration files a restore has to put back. */
function filesOf(scope, node, vmid) {
  if (scope === 'cluster') return ['/etc/pve/firewall/cluster.fw'];
  if (scope === 'node') return [`/etc/pve/nodes/${node}/host.fw`];
  return [`/etc/pve/firewall/${vmid}.fw`];
}

/** True when a rule's dport covers `port` (a value, a range or a list). */
function covers(rule, port) {
  const text = String(rule ?? '').trim();
  if (text === '') return false;
  return text.split(/[,;]/).some((part) => {
    const item = part.trim();
    if (item === port) return true;
    const range = /^(\d+):(\d+)$/.exec(item);
    if (range) return Number(port) >= Number(range[1]) && Number(port) <= Number(range[2]);
    return false;
  });
}

/** The ACCEPT rules that keep the management ports reachable. */
function managementRules(rules) {
  const list = Array.isArray(rules) ? rules : [];
  return MANAGEMENT_PORTS.filter(
    (port) => !list.some((rule) => String(rule.type ?? 'in') === 'in' && String(rule.action ?? '').toUpperCase() === 'ACCEPT' && covers(rule.dport, port)),
  );
}

/** Collect the rule properties the caller passed (the API names differ twice). */
function ruleFields(args) {
  const body = {};
  for (const key of RULE_FIELDS) {
    const value = key === 'action' ? args?.rule_action : key === 'comment' ? args?.rule_comment : key === 'type' ? args?.rule_type : args?.[key];
    if (value === undefined || value === null || value === '') continue;
    body[key] = value;
  }
  return body;
}

/**
 * Build the firewall tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 * @returns {Array<object>} compiled tool definitions.
 */
export function firewallTools(deps) {
  return [
    {
      name: 'pve_firewall',
      description:
        'Proxmox firewall: read and change options and rules at cluster, node or guest scope. Enabling the firewall, changing the input policy, or deleting a rule can remove the management path (tcp/8006 and tcp/22) — those writes are confirmed, and at cluster/node scope they run behind a rollback timer that restores the .fw files and restarts pve-firewall if the node stops answering.',
      parameters: {
        scope: {
          type: 'string',
          required: true,
          enum: ['cluster', 'node', 'guest'],
          description: 'Which firewall to work on.',
        },
        action: {
          type: 'string',
          required: true,
          enum: ['status', 'enable', 'disable', 'policy', 'rule-list', 'rule-add', 'rule-update', 'rule-delete'],
          description: 'What to read or change.',
        },
        guest_type: { type: 'string', enum: ['qemu', 'lxc'], description: 'Guest kind for scope "guest" (default qemu).' },
        vmid: { type: 'number', description: 'Guest id for scope "guest".' },
        rule_type: { type: 'string', enum: ['in', 'out', 'group', 'forward'], description: 'Rule direction (default in).' },
        pos: { type: 'number', description: 'Rule position for update and delete.' },
        rule_action: {
          type: 'string',
          enum: ['ACCEPT', 'DROP', 'REJECT'],
          description: 'What the rule does (the tool action is a separate field: action).',
        },
        enable: { type: 'boolean', description: 'Enable the rule (default true).' },
        proto: { type: 'string', description: 'Protocol: tcp, udp, icmp, icmpv6 …' },
        dport: { type: 'string', description: 'Destination port, range (8000:9000) or list.' },
        sport: { type: 'string', description: 'Source port.' },
        source: { type: 'string', description: 'Source address or CIDR.' },
        dest: { type: 'string', description: 'Destination address or CIDR.' },
        iface: { type: 'string', description: 'Interface the rule applies to.' },
        log: { type: 'string', enum: ['nolog', 'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'], description: 'Log level.' },
        rule_comment: { type: 'string', description: 'Rule comment.' },
        macro: { type: 'string', description: 'Security group macro.' },
        policy_in: { type: 'string', enum: ['ACCEPT', 'DROP'], description: 'Input policy (action "policy").' },
        policy_out: { type: 'string', enum: ['ACCEPT', 'DROP'], description: 'Output policy (action "policy").' },
        timeout_sec: { type: 'number', description: 'Rollback delay, 30–900 seconds (default 180).' },
        confirm: { type: 'string', description: 'The token from the first call, for every write.' },
      },
      output: { schema: PLAIN_SCHEMA, render: renderValue },
      async execute(args, exec) {
        const { controller, settings, name } = instanceOf(deps, args);
        const signal = exec?.signal;
        const scope = String(args.scope ?? '');
        const guestType = args.guest_type === 'lxc' ? 'lxc' : 'qemu';
        const node = scope === 'cluster' ? null : await controller.nodeName();
        if (scope === 'guest' && !Number.isInteger(args.vmid)) {
          throw new VmError('scope "guest" needs a vmid', 'BAD_ARGUMENT');
        }
        const base = basePath(scope, node, { guestType, vmid: args.vmid });
        const target = scope === 'cluster' ? `${name}:fw:cluster` : scope === 'node' ? `${name}:fw:node:${node}` : `${name}:fw:${guestType}:${args.vmid}`;
        const action = String(args.action ?? '');

        if (action === 'status' || action === 'rule-list') {
          const options = await controller.pveshGet(`${base}/options`, {}, { signal });
          const rules = await controller.pveshGet(`${base}/rules`, {}, { signal });
          return {
            instance: name,
            scope,
            node,
            guest: scope === 'guest' ? { type: guestType, vmid: args.vmid } : undefined,
            options,
            rules: Array.isArray(rules) ? rules : [],
            missingManagementAccept: managementRules(rules),
          };
        }

        /** Wrap one write in confirmation (+ commit-confirm at cluster/node scope). */
        const guarded = async ({ risk, summary, write }) =>
          await runGuarded(deps.confirms, { args, instance: name, action: `pve_firewall:${action}`, target, risk, summary }, async () => {
            const timerScoped = scope !== 'guest';
            if (timerScoped && !canCommitConfirm(settings)) {
              throw new VmError(
                'firewall changes at cluster/node scope need the API transport (to probe reachability) and the ssh channel (to arm the rollback) — set apiUrl/apiToken and sshHost on this instance',
                'BAD_ARGUMENT',
              );
            }
            let armed = null;
            if (timerScoped) {
              armed = await armRollback(controller, {
                id: rollbackId(),
                files: filesOf(scope, node, args.vmid),
                restoreCommand: 'pve-firewall restart',
                seconds: Math.max(30, Math.min(900, Math.trunc(Number(args.timeout_sec) || 180))),
                signal,
              });
            }
            try {
              await write();
            } catch (error) {
              if (armed) await cancelRollback(controller, armed.unit, { signal }).catch(() => {});
              throw error;
            }
            let restarted = null;
            try {
              await runDetached(controller, {
                id: rollbackId('dsh-apply'),
                script: 'pve-firewall restart',
                description: 'dsh-pve-vm firewall apply',
                signal,
              });
              restarted = true;
            } catch (error) {
              restarted = false;
            }
            if (!armed) {
              return { instance: name, scope, node, action, written: true, firewallRestarted: restarted };
            }
            const probe = await probeApi(controller, { attempts: 6, delayMs: 1500, signal });
            if (probe.reachable) {
              await cancelRollback(controller, armed.unit, { signal });
              return { instance: name, scope, node, action, written: true, firewallRestarted: restarted, probe, rollback: { unit: armed.unit, cancelled: true } };
            }
            return {
              instance: name,
              scope,
              node,
              action,
              written: true,
              firewallRestarted: restarted,
              probe,
              rollback: { unit: armed.unit, cancelled: false, seconds: armed.seconds },
              warning:
                `the node stopped answering after this firewall change. Timer ${armed.unit} restores the saved .fw files in ${armed.seconds} seconds and restarts pve-firewall, so the node should come back by itself.`,
            };
          });

        if (action === 'enable' || action === 'disable') {
          const on = action === 'enable';
          const rules = await controller.pveshGet(`${base}/rules`, {}, { signal });
          const missing = managementRules(rules);
          const warning =
            on && missing.length > 0
              ? ` The current input rules have no ACCEPT for tcp/${missing.join(', tcp/')} — enabling the firewall with a DROP policy will cut this plugin's own access.`
              : '';
          const summary = `${on ? 'Enable' : 'Disable'} the ${scope} firewall${node ? ` on ${node}` : ''}.${warning}`;
          return await guarded({ risk: 'danger', summary, write: async () => controller.pvesh('set', `${base}/options`, { params: { enable: on ? 1 : 0 }, signal }) });
        }

        if (action === 'policy') {
          const body = {};
          if (args.policy_in) body.policy_in = args.policy_in;
          if (args.policy_out) body.policy_out = args.policy_out;
          if (Object.keys(body).length === 0) throw new VmError('policy needs policy_in or policy_out', 'BAD_ARGUMENT');
          const summary = `Set the ${scope} firewall policy${node ? ` on ${node}` : ''} to ${JSON.stringify(body)}. A DROP input policy without an ACCEPT rule for tcp/8006 makes the node unreachable.`;
          return await guarded({ risk: 'danger', summary, write: async () => controller.pvesh('set', `${base}/options`, { params: body, signal }) });
        }

        if (action === 'rule-add') {
          const body = ruleFields(args);
          if (body.action === undefined) throw new VmError('rule-add needs rule_action (ACCEPT, DROP or REJECT)', 'BAD_ARGUMENT');
          const summary =
            `Add a ${scope} firewall rule${node ? ` on ${node}` : ''}: ${body.type ?? 'in'} ${body.action} ${body.proto ?? 'any'}${body.dport ? ` dport ${body.dport}` : ''}.` +
            (String(body.action).toUpperCase() === 'DROP' && MANAGEMENT_PORTS.some((port) => covers(body.dport, port))
              ? ' This rule drops traffic for a management port — the node may become unreachable.'
              : '');
          return await guarded({ risk: 'danger', summary, write: async () => controller.pvesh('create', `${base}/rules`, { params: body, signal }) });
        }

        if (action === 'rule-update') {
          if (!Number.isInteger(args.pos)) throw new VmError('rule-update needs pos', 'BAD_ARGUMENT');
          const body = ruleFields(args);
          if (Object.keys(body).length === 0) throw new VmError('rule-update needs at least one field', 'BAD_ARGUMENT');
          const summary = `Update ${scope} firewall rule ${args.pos}${node ? ` on ${node}` : ''} to ${JSON.stringify(body)}.`;
          return await guarded({ risk: 'danger', summary, write: async () => controller.pvesh('set', `${base}/rules/${args.pos}`, { params: body, signal }) });
        }

        if (action === 'rule-delete') {
          if (!Number.isInteger(args.pos)) throw new VmError('rule-delete needs pos', 'BAD_ARGUMENT');
          const rules = await controller.pveshGet(`${base}/rules`, {}, { signal });
          const rule = Array.isArray(rules) ? rules.find((entry) => Number(entry.pos) === args.pos) : undefined;
          const touchesManagement =
            rule && String(rule.action ?? '').toUpperCase() === 'ACCEPT' && MANAGEMENT_PORTS.some((port) => covers(rule.dport, port));
          const summary =
            `Delete ${scope} firewall rule ${args.pos}${node ? ` on ${node}` : ''}${rule ? ` (${rule.type ?? 'in'} ${rule.action ?? ''} ${rule.proto ?? ''} ${rule.dport ?? ''})` : ''}.` +
            (touchesManagement ? ' That rule is one of the ACCEPT rules for a management port — deleting it can make the node unreachable.' : '');
          return await guarded({ risk: 'destroy', summary, write: async () => controller.pvesh('delete', `${base}/rules/${args.pos}`, { signal }) });
        }

        throw new VmError(`unknown action "${args.action}" — use status, enable, disable, policy, rule-list, rule-add, rule-update or rule-delete`, 'BAD_ARGUMENT');
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
