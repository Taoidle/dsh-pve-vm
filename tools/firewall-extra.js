/**
 * Cluster firewall objects the base `pve_firewall` tool does not manage:
 * security groups (and their rules), IP sets (and their entries), aliases,
 * the cluster options record, the node firewall log and cross-references.
 *
 * These are plain API writes: unlike `pve_firewall`'s cluster/node
 * enable/policy actions they do not arm the commit-confirm timer, but every
 * write still needs a confirmation token.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';
import {
  assignments,
  flag,
  matchText,
  nodeOf,
  numberParam,
  optionalText,
  requireText,
  segment,
} from '../lib/admin-util.js';

/** A firewall object name (group, alias, ipset). */
function objectName(value, label) {
  return matchText(value, label, /^[A-Za-z][A-Za-z0-9_-]*$/, 'letters, digits, dash and underscore');
}

/** A CIDR entry. */
function cidrValue(value, label = 'cidr') {
  return matchText(value, label, /^[0-9A-Fa-f:.]+(?:\/[0-9]{1,3})?$/, 'an IPv4/IPv6 address or CIDR');
}

/** The fields a security-group rule may carry. */
function ruleParams(args) {
  const params = {};
  if (args.rule_action !== undefined) params.action = String(args.rule_action);
  for (const key of ['comment', 'dest', 'dport', 'iface', 'log', 'macro', 'proto', 'source', 'sport', 'type']) {
    if (args[key] !== undefined) params[key] = String(args[key]);
  }
  if (args.icmp_type !== undefined) params['icmp-type'] = String(args.icmp_type);
  if (args.enable !== undefined) params.enable = flag(args.enable);
  if (args.moveto !== undefined) params.moveto = numberParam(args.moveto, 'moveto', { min: 0, integer: true });
  if (args.digest !== undefined) params.digest = String(args.digest);
  return params;
}

/** Describe one rule. */
function describeRule(rule) {
  return `${rule.pos ?? '?'}: ${rule.action ?? '?'} ${rule.type ?? ''} ${rule.source ?? 'any'} → ${rule.dest ?? 'any'}${rule.dport ? `:${rule.dport}` : ''}${rule.enable === 0 || rule.enable === false ? ' (disabled)' : ''}`.replace(/\s+/g, ' ').trim();
}

/**
 * Build the extra firewall tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function firewallExtraTools(deps) {
  return [
    {
      name: 'pve_security_group',
      description:
        'Cluster firewall security groups: list/get/create/delete them, and add/update/delete their rules. Group rules ' +
        'are referenced from cluster, node and guest rule sets. Every write needs a confirmation token.',
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'delete', 'rule-add', 'rule-update', 'rule-delete'],
          required: true,
          description: 'Security-group operation.',
        },
        group: { type: 'string', description: 'Group name (all actions except list).' },
        comment: { type: 'string', description: 'Group or rule comment.' },
        pos: { type: 'number', description: 'Rule position (update/delete).' },
        rule_action: { type: 'string', description: 'Rule action, for example ACCEPT, DROP or REJECT.' },
        rule_type: { type: 'string', enum: ['group', 'in', 'out'], description: 'Rule direction/type.' },
        source: { type: 'string', description: 'Source address or alias.' },
        dest: { type: 'string', description: 'Destination address or alias.' },
        proto: { type: 'string', description: 'Protocol, for example tcp, udp, icmp.' },
        dport: { type: 'string', description: 'Destination port or range.' },
        sport: { type: 'string', description: 'Source port or range.' },
        iface: { type: 'string', description: 'Interface the rule applies to.' },
        log: { type: 'string', enum: ['nolog', 'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'], description: 'Log level.' },
        enable: { type: 'boolean', description: 'Enable the rule.' },
        macro: { type: 'string', description: 'Security-group macro.' },
        icmp_type: { type: 'string', description: 'ICMP type.' },
        moveto: { type: 'number', description: 'Move the rule to this position (update).' },
        digest: { type: 'string', description: 'Only apply if the ruleset still has this digest.' },
        confirm: { type: 'string', description: 'The token from the first call, for every write.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (args.action === 'list') {
            const lines = (value.groups ?? []).map((group) => `${group.group}${group.comment ? ` — ${group.comment}` : ''}`);
            return textOutput(`security groups:\n${lines.join('\n') || 'none'}`);
          }
          if (args.action === 'get') {
            const lines = (value.rules ?? []).map(describeRule);
            return textOutput(`security group ${value.group}:\n${lines.join('\n') || 'no rules'}`);
          }
          return textOutput(`security group ${value.group}: ${value.action} done.`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        const signal = exec?.signal;
        if (action === 'list') {
          const groups = await controller.pveshGet('/cluster/firewall/groups', {}, { signal });
          return { instance: name, action, groups: Array.isArray(groups) ? groups : [] };
        }
        const group = objectName(args.group, 'group');
        const base = `/cluster/firewall/groups/${segment(group)}`;
        if (action === 'get') {
          const rules = await controller.pveshGet(base, {}, { signal });
          return { instance: name, action, group, rules: Array.isArray(rules) ? rules : [] };
        }
        if (action === 'create') {
          const params = { group };
          if (args.comment !== undefined) params.comment = String(args.comment);
          const summary = `Create firewall security group ${group}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_security_group:create', target: `${name}:fw-group:${group}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('create', '/cluster/firewall/groups', { params, signal });
              return { instance: name, action, group };
            },
          );
        }
        if (action === 'delete') {
          const summary = `Delete firewall security group ${group}: every rule that references it stops matching.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_security_group:delete', target: `${name}:fw-group:${group}`, risk: 'destroy', summary },
            async () => {
              await controller.pvesh('delete', base, { signal });
              return { instance: name, action, group };
            },
          );
        }
        if (action === 'rule-add') {
          const type = requireText(args.rule_type, 'rule_type');
          const ruleAction = requireText(args.rule_action, 'rule_action');
          const params = { ...ruleParams(args), type, action: ruleAction };
          const summary = `Add ${ruleAction} ${type} rule to security group ${group}: ${params.source ?? 'any'} → ${params.dest ?? 'any'}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_security_group:rule-add', target: `${name}:fw-group:${group}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('create', base, { params, signal });
              return { instance: name, action, group };
            },
          );
        }
        const pos = numberParam(args.pos, 'pos', { min: 0, integer: true });
        if (action === 'rule-delete') {
          const params = {};
          if (args.digest !== undefined) params.digest = String(args.digest);
          const summary = `Delete rule ${pos} from security group ${group}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_security_group:rule-delete', target: `${name}:fw-group:${group}:${pos}`, risk: 'destroy', summary },
            async () => {
              await controller.pvesh('delete', `${base}/${pos}`, { params, signal });
              return { instance: name, action, group, pos };
            },
          );
        }
        const params = ruleParams(args);
        if (Object.keys(params).length === 0) throw new VmError('action=rule-update needs at least one field', 'BAD_ARGUMENT');
        const summary = `Change rule ${pos} in security group ${group}: ${Object.entries(params).map(([key, value]) => `${key}=${value}`).join(', ')}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'pve_security_group:rule-update', target: `${name}:fw-group:${group}:${pos}`, risk: 'danger', summary },
          async () => {
            await controller.pvesh('set', `${base}/${pos}`, { params, signal });
            return { instance: name, action, group, pos };
          },
        );
      },
    },
    {
      name: 'pve_ipset',
      description:
        'Cluster firewall IP sets: list/get/create/delete sets and add/update/delete their CIDR entries. Every write ' +
        'needs a confirmation token.',
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'delete', 'entry-add', 'entry-update', 'entry-delete'],
          required: true,
          description: 'IP-set operation.',
        },
        name: { type: 'string', description: 'IP-set name (all actions except list).' },
        comment: { type: 'string', description: 'Set or entry comment.' },
        cidr: { type: 'string', description: 'Entry address/CIDR (entry actions).' },
        nomatch: { type: 'boolean', description: 'Exclude this entry from matching.' },
        force: { type: 'boolean', description: 'Delete the set even if rules reference it.' },
        digest: { type: 'string', description: 'Only apply if the set still has this digest.' },
        confirm: { type: 'string', description: 'The token from the first call, for every write.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (args.action === 'list') {
            const lines = (value.sets ?? []).map((set) => `${set.name}${set.comment ? ` — ${set.comment}` : ''}`);
            return textOutput(`IP sets:\n${lines.join('\n') || 'none'}`);
          }
          if (args.action === 'get') {
            const lines = (value.entries ?? []).map((entry) => `${entry.cidr}${entry.nomatch ? ' (nomatch)' : ''}${entry.comment ? ` — ${entry.comment}` : ''}`);
            return textOutput(`IP set ${value.name}:\n${lines.join('\n') || 'no entries'}`);
          }
          return textOutput(`IP set ${value.name}: ${value.action} done.`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        const signal = exec?.signal;
        if (action === 'list') {
          const sets = await controller.pveshGet('/cluster/firewall/ipset', {}, { signal });
          return { instance: name, action, sets: Array.isArray(sets) ? sets : [] };
        }
        const setName = objectName(args.name, 'name');
        const base = `/cluster/firewall/ipset/${segment(setName)}`;
        if (action === 'get') {
          const entries = await controller.pveshGet(base, {}, { signal });
          return { instance: name, action, name: setName, entries: Array.isArray(entries) ? entries : [] };
        }
        if (action === 'create') {
          const params = { name: setName };
          if (args.comment !== undefined) params.comment = String(args.comment);
          const summary = `Create firewall IP set ${setName}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_ipset:create', target: `${name}:fw-ipset:${setName}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('create', '/cluster/firewall/ipset', { params, signal });
              return { instance: name, action, name: setName };
            },
          );
        }
        if (action === 'delete') {
          const params = {};
          if (args.force !== undefined) params.force = flag(args.force);
          const summary = `Delete firewall IP set ${setName}${args.force ? ' (force)' : ''}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_ipset:delete', target: `${name}:fw-ipset:${setName}`, risk: 'destroy', summary },
            async () => {
              await controller.pvesh('delete', base, { params, signal });
              return { instance: name, action, name: setName };
            },
          );
        }
        const cidr = cidrValue(args.cidr);
        const entryBase = `${base}/${segment(cidr)}`;
        if (action === 'entry-add') {
          const params = { cidr };
          if (args.comment !== undefined) params.comment = String(args.comment);
          if (args.nomatch !== undefined) params.nomatch = flag(args.nomatch);
          const summary = `Add ${cidr}${args.nomatch ? ' (nomatch)' : ''} to IP set ${setName}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_ipset:entry-add', target: `${name}:fw-ipset:${setName}:${cidr}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('create', base, { params, signal });
              return { instance: name, action, name: setName, cidr };
            },
          );
        }
        const params = {};
        if (args.comment !== undefined) params.comment = String(args.comment);
        if (args.nomatch !== undefined) params.nomatch = flag(args.nomatch);
        if (args.digest !== undefined) params.digest = String(args.digest);
        if (action === 'entry-delete') {
          const summary = `Delete entry ${cidr} from IP set ${setName}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_ipset:entry-delete', target: `${name}:fw-ipset:${setName}:${cidr}`, risk: 'destroy', summary },
            async () => {
              await controller.pvesh('delete', entryBase, { params, signal });
              return { instance: name, action, name: setName, cidr };
            },
          );
        }
        if (Object.keys(params).length === 0) throw new VmError('action=entry-update needs comment, nomatch or digest', 'BAD_ARGUMENT');
        const summary = `Change entry ${cidr} in IP set ${setName}: ${Object.entries(params).map(([key, value]) => `${key}=${value}`).join(', ')}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'pve_ipset:entry-update', target: `${name}:fw-ipset:${setName}:${cidr}`, risk: 'danger', summary },
          async () => {
            await controller.pvesh('set', entryBase, { params, signal });
            return { instance: name, action, name: setName, cidr };
          },
        );
      },
    },
    {
      name: 'pve_alias',
      description:
        'Cluster firewall aliases: named IP/CIDR values used by rules. List/get/create/update/delete; every write needs ' +
        'a confirmation token.',
      parameters: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'], required: true, description: 'Alias operation.' },
        name: { type: 'string', description: 'Alias name (all actions except list).' },
        cidr: { type: 'string', description: 'Address/CIDR of the alias (required for create).' },
        comment: { type: 'string', description: 'Description.' },
        rename: { type: 'string', description: 'New name (update only).' },
        digest: { type: 'string', description: 'Only apply if the alias still has this digest.' },
        confirm: { type: 'string', description: 'The token from the first call, for every write.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (args.action === 'list') {
            const lines = (value.aliases ?? []).map((alias) => `${alias.name} = ${alias.cidr}${alias.comment ? ` — ${alias.comment}` : ''}`);
            return textOutput(`firewall aliases:\n${lines.join('\n') || 'none'}`);
          }
          if (args.action === 'get') return textOutput(`alias ${value.alias?.name ?? value.name} = ${value.alias?.cidr ?? '?'}`);
          return textOutput(`alias ${value.name}: ${value.action} done.`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        const signal = exec?.signal;
        if (action === 'list') {
          const aliases = await controller.pveshGet('/cluster/firewall/aliases', {}, { signal });
          return { instance: name, action, aliases: Array.isArray(aliases) ? aliases : [] };
        }
        const aliasName = objectName(args.name, 'name');
        const base = `/cluster/firewall/aliases/${segment(aliasName)}`;
        if (action === 'get') {
          const alias = await controller.pveshGet(base, {}, { signal });
          return { instance: name, action, name: aliasName, alias };
        }
        if (action === 'create') {
          const cidr = cidrValue(args.cidr);
          const params = { name: aliasName, cidr };
          if (args.comment !== undefined) params.comment = String(args.comment);
          const summary = `Create firewall alias ${aliasName} = ${cidr}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_alias:create', target: `${name}:fw-alias:${aliasName}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('create', '/cluster/firewall/aliases', { params, signal });
              return { instance: name, action, name: aliasName, cidr };
            },
          );
        }
        if (action === 'delete') {
          const summary = `Delete firewall alias ${aliasName}: rules that reference it stop matching.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_alias:delete', target: `${name}:fw-alias:${aliasName}`, risk: 'destroy', summary },
            async () => {
              await controller.pvesh('delete', base, { signal });
              return { instance: name, action, name: aliasName };
            },
          );
        }
        const current = args.cidr !== undefined ? { cidr: cidrValue(args.cidr) } : await controller.pveshGet(base, {}, { signal });
        const params = { cidr: cidrValue(current.cidr) };
        if (args.comment !== undefined) params.comment = String(args.comment);
        if (args.rename !== undefined) params.rename = objectName(args.rename, 'rename');
        if (args.digest !== undefined) params.digest = String(args.digest);
        const summary = `Change firewall alias ${aliasName}: ${Object.entries(params).map(([key, value]) => `${key}=${value}`).join(', ')}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'pve_alias:update', target: `${name}:fw-alias:${aliasName}`, risk: 'danger', summary },
          async () => {
            await controller.pvesh('set', base, { params, signal });
            return { instance: name, action, name: aliasName };
          },
        );
      },
    },
    {
      name: 'pve_firewall_extra',
      description:
        'The rest of the firewall: read/change cluster firewall options, read a node\'s firewall log, and list ' +
        'cross-references (which aliases/ipsets are used where). Option writes affect the whole cluster and need a ' +
        'confirmation token.',
      parameters: {
        action: { type: 'string', enum: ['options', 'options-set', 'log', 'refs'], required: true, description: 'Firewall view or write.' },
        changes: { type: 'array', items: { type: 'string' }, description: 'Options as "key=value" for options-set.' },
        delete: { type: 'string', description: 'Comma-separated option names to reset.' },
        node: { type: 'string', description: 'Node for action=log (default: this instance\'s node).' },
        limit: { type: 'number', description: 'Maximum log lines (log only).' },
        since: { type: 'number', description: 'Only entries since this unix time (log only).' },
        start: { type: 'number', description: 'Start line/time for the log.' },
        until: { type: 'number', description: 'Only entries until this unix time (log only).' },
        type: { type: 'string', enum: ['alias', 'ipset'], description: 'Restrict refs to one kind.' },
        confirm: { type: 'string', description: 'The token from the first call, for options-set.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (args.action === 'options') {
            const lines = Object.entries(value.options ?? {}).map(([key, entry]) => `${key}=${entry}`);
            return textOutput(`cluster firewall options:\n${lines.join('\n') || 'none'}`);
          }
          if (args.action === 'log') {
            const lines = (value.log ?? []).map((entry) => `${entry.n ?? ''} ${entry.t ?? ''} ${entry.d ?? ''}`.trim());
            return textOutput(`firewall log on ${value.node}:\n${lines.join('\n') || 'empty'}`);
          }
          if (args.action === 'refs') return textOutput(`firewall references:\n${JSON.stringify(value.refs ?? {}, null, 2)}`);
          return textOutput(`cluster firewall options changed: ${(value.changed ?? []).join(', ')}`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        const signal = exec?.signal;
        if (action === 'options') {
          const options = await controller.pveshGet('/cluster/firewall/options', {}, { signal });
          return { instance: name, action, options };
        }
        if (action === 'refs') {
          const params = args.type !== undefined ? { type: String(args.type) } : {};
          const refs = await controller.pveshGet('/cluster/firewall/refs', params, { signal });
          return { instance: name, action, refs };
        }
        if (action === 'log') {
          const node = await nodeOf(controller, args);
          const params = {};
          for (const key of ['limit', 'since', 'start', 'until']) if (args[key] !== undefined) params[key] = Number(args[key]);
          const log = await controller.pveshGet(`/nodes/${segment(node)}/firewall/log`, params, { signal });
          return { instance: name, node, action, log: Array.isArray(log) ? log : [] };
        }
        const params = assignments(args.changes);
        if (args.delete !== undefined) params.delete = String(args.delete);
        if (Object.keys(params).length === 0) throw new VmError('action=options-set needs changes or delete', 'BAD_ARGUMENT');
        const warning = params.enable !== undefined ? ' Enabling the firewall without an ACCEPT rule for the management ports can cut access.' : '';
        const summary = `Change cluster firewall options: ${Object.entries(params).map(([key, value]) => `${key}=${value || '(reset)'}`).join(', ')}.${warning}`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'pve_firewall_extra:options-set', target: `${name}:fw-options`, risk: 'danger', summary },
          async () => {
            await controller.pvesh('set', '/cluster/firewall/options', { params, signal });
            return { instance: name, action, changed: Object.keys(params) };
          },
        );
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
