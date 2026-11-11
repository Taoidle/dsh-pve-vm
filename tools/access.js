/**
 * Access control: users, groups, roles, ACLs and API tokens.
 *
 * A plugin that manages access needs to be honest about what it is doing. Every
 * write here is confirmed with a token, because these objects decide who may do
 * what to the whole cluster — a wrong ACL is worse than a wrong VM setting: the
 * VM setting breaks one guest, the ACL can hand the cluster to somebody.
 *
 * PVE 7 has no "privilege inventory" endpoint, so the role tools accept the
 * privilege names as written in the PVE docs (`VM.PowerMgmt`, `Datastore.Audit`,
 * …) and let the API reject a typo — the error names the privilege it did not
 * know, which is more useful than a guessed list going stale.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';

/** Split `VM.Audit, VM.PowerMgmt` or an array into privilege names. */
function privileges(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/);
  const clean = list.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  for (const entry of clean) {
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/.test(entry)) {
      throw new VmError(`"${entry}" is not a privilege name — they look like VM.PowerMgmt or Datastore.Audit`, 'BAD_ARGUMENT');
    }
  }
  return clean;
}

/** A user id must look like `name@realm`. */
function userId(value, label = 'userid') {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(id)) {
    throw new VmError(`${label} must look like name@realm (for example root@pam)`, 'BAD_ARGUMENT');
  }
  return id;
}

/** One ACL line for the agent. */
function aclLine(entry) {
  const subject = entry.type === 'token' ? `token ${entry.ugid}` : `${entry.type} ${entry.ugid}`;
  return `${entry.path} → ${subject}: ${entry.roleid}${entry.propagate ? ' (propagate)' : ''}`;
}

/**
 * Build the access-control tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function accessTools(deps) {
  return [
    {
      name: 'pve_user',
      description:
        'Cluster users: list them with their groups and realm, read one, or create, update and delete one. ' +
        'Writes need a second confirmation. Managing users needs the Permissions.Modify privilege on /access.',
      parameters: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'], required: true, description: 'User operation.' },
        userid: { type: 'string', description: 'User id, for example ci@pve or root@pam.' },
        password: { type: 'string', description: 'Initial password (create only); it is sent once and never read back.' },
        email: { type: 'string', description: 'Email address.' },
        firstname: { type: 'string', description: 'First name.' },
        lastname: { type: 'string', description: 'Last name.' },
        groups: { type: 'string', description: 'Groups, comma separated.' },
        comment: { type: 'string', description: 'Comment.' },
        enable: { type: 'boolean', description: 'Enable or disable the account (update).' },
        expire: { type: 'number', description: 'Expiry as a unix timestamp, 0 disables it.' },
        confirm: { type: 'string', description: 'The token from the first call, for create, update and delete.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.action === 'list') {
            const lines = (value.users ?? []).map(
              (entry) => `${entry.userid}${entry.enable === 0 ? ' (disabled)' : ''}${entry.groups ? ` — groups ${entry.groups}` : ''}${entry.comment ? ` — ${entry.comment}` : ''}`,
            );
            return textOutput(`users:\n${lines.join('\n') || 'none'}`);
          }
          return textOutput(`user ${value.userid}: ${value.action} done`);
        },
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        if (action === 'list') {
          const users = await controller.pveshGet('/access/users', {}, { signal: exec?.signal });
          const list = Array.isArray(users) ? users : [];
          const id = typeof args.userid === 'string' ? args.userid.trim() : '';
          return { instance: name, action, users: id ? list.filter((entry) => entry.userid === id) : list };
        }
        const id = userId(args.userid);
        const endpoint = `/access/users/${encodeURIComponent(id)}`;
        if (action === 'get') {
          const user = await controller.pveshGet(endpoint, {}, { signal: exec?.signal });
          return { instance: name, action, userid: id, user };
        }
        if (action === 'delete') {
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_user:delete', target: `${name}:user:${id}`, risk: 'destroy', summary: `Delete user ${id}. Their API tokens and ACL entries go with them.` },
            async () => {
              await controller.pvesh('delete', endpoint, { signal: exec?.signal });
              return { instance: name, action, userid: id };
            },
          );
        }
        const params = { userid: id };
        for (const key of ['password', 'email', 'firstname', 'lastname', 'groups', 'comment', 'expire']) {
          if (args[key] !== undefined && args[key] !== '') params[key] = args[key];
        }
        if (args.enable !== undefined) params.enable = args.enable ? 1 : 0;
        if (action === 'create') {
          if (params.password === undefined && !id.endsWith('@pve')) {
            // A PAM user already has a system password; anything else needs one to exist at all.
            throw new VmError('creating a user needs a password (except PAM users, which authenticate against the node)', 'BAD_ARGUMENT');
          }
          const summary = `Create user ${id}${params.groups ? ` in ${params.groups}` : ''}${params.enable === 0 ? ' (disabled)' : ''}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_user:create', target: `${name}:user:${id}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('create', '/access/users', { params, signal: exec?.signal });
              return { instance: name, action, userid: id };
            },
          );
        }
        const { userid, ...rest } = params;
        const changed = Object.keys(rest);
        if (changed.length === 0) throw new VmError('action=update needs at least one field', 'BAD_ARGUMENT');
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'pve_user:update', target: `${name}:user:${id}`, risk: 'danger', summary: `Change user ${id}: ${changed.join(', ')}.` },
          async () => {
            await controller.pvesh('set', endpoint, { params: rest, signal: exec?.signal });
            return { instance: name, action, userid: id };
          },
        );
      },
    },
    {
      name: 'pve_group',
      description: 'Groups: list, create, update (members and comment) or delete. Writes need a second confirmation.',
      parameters: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], required: true, description: 'Group operation.' },
        groupid: { type: 'string', description: 'Group id.' },
        comment: { type: 'string', description: 'Comment.' },
        users: { type: 'string', description: 'Members, comma separated (update).' },
        confirm: { type: 'string', description: 'The token from the first call, for create, update and delete.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.action === 'list') {
            const lines = (value.groups ?? []).map((entry) => `${entry.groupid}${entry.comment ? ` — ${entry.comment}` : ''}`);
            return textOutput(`groups:\n${lines.join('\n') || 'none'}`);
          }
          return textOutput(`group ${value.groupid}: ${value.action} done`);
        },
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        if (action === 'list') {
          const groups = await controller.pveshGet('/access/groups', {}, { signal: exec?.signal });
          return { instance: name, action, groups: Array.isArray(groups) ? groups : [] };
        }
        const groupid = String(args.groupid ?? '').trim();
        if (!/^[A-Za-z0-9._-]+$/.test(groupid)) throw new VmError('a group id is a plain name', 'BAD_ARGUMENT');
        const endpoint = `/access/groups/${encodeURIComponent(groupid)}`;
        const params = {};
        if (args.comment !== undefined) params.comment = String(args.comment);
        if (args.users !== undefined) params.users = String(args.users);
        if (action === 'delete') {
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_group:delete', target: `${name}:group:${groupid}`, risk: 'destroy', summary: `Delete group ${groupid}. ACL entries that used it stop applying.` },
            async () => {
              await controller.pvesh('delete', endpoint, { signal: exec?.signal });
              return { instance: name, action, groupid };
            },
          );
        }
        if (action === 'create') {
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_group:create', target: `${name}:group:${groupid}`, risk: 'danger', summary: `Create group ${groupid}${params.users ? ` with ${params.users}` : ''}.` },
            async () => {
              await controller.pvesh('create', '/access/groups', { params: { groupid, ...params }, signal: exec?.signal });
              return { instance: name, action, groupid };
            },
          );
        }
        if (Object.keys(params).length === 0) throw new VmError('action=update needs comment or users', 'BAD_ARGUMENT');
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'pve_group:update', target: `${name}:group:${groupid}`, risk: 'danger', summary: `Change group ${groupid}: ${Object.keys(params).join(', ')}.` },
          async () => {
            await controller.pvesh('set', endpoint, { params, signal: exec?.signal });
            return { instance: name, action, groupid };
          },
        );
      },
    },
    {
      name: 'pve_role',
      description:
        'Roles bundle privileges. List them, read one, or create/update/delete a role. ' +
        'For a scoped operator role start from VM.Audit, VM.PowerMgmt, VM.Console, VM.Monitor, VM.Snapshot, VM.Backup, ' +
        'Datastore.Audit, Datastore.AllocateSpace, Sys.Audit. Writes need a second confirmation.',
      parameters: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'], required: true, description: 'Role operation.' },
        roleid: { type: 'string', description: 'Role id.' },
        privs: { type: 'string', description: 'Privileges, comma separated: VM.PowerMgmt, Datastore.Audit, …' },
        append: { type: 'boolean', description: 'For update: add these privileges to the existing set instead of replacing it.' },
        confirm: { type: 'string', description: 'The token from the first call, for create, update and delete.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.action === 'list') {
            const lines = (value.roles ?? []).map((entry) => `${entry.roleid}${entry.special ? ' (built-in)' : ''} — ${entry.privs ?? ''}`);
            return textOutput(`roles:\n${lines.join('\n') || 'none'}`);
          }
          if (value.action === 'get') {
            // /access/roles/{id} answers a map of privilege → 1, not a `privs` string.
            const privs = value.role?.privs ?? Object.keys(value.role ?? {}).filter((key) => value.role[key]).join(', ');
            return textOutput(`role ${value.roleid}: ${privs || 'no privileges'}`);
          }
          return textOutput(`role ${value.roleid}: ${value.action} done${value.privs ? ` — ${value.privs}` : ''}`);
        },
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        if (action === 'list') {
          const roles = await controller.pveshGet('/access/roles', {}, { signal: exec?.signal });
          const list = Array.isArray(roles) ? roles : [];
          const id = typeof args.roleid === 'string' ? args.roleid.trim() : '';
          return { instance: name, action, roles: id ? list.filter((entry) => entry.roleid === id) : list };
        }
        const roleid = String(args.roleid ?? '').trim();
        if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(roleid)) throw new VmError('a role id starts with a letter', 'BAD_ARGUMENT');
        const endpoint = `/access/roles/${encodeURIComponent(roleid)}`;
        if (action === 'get') {
          const role = await controller.pveshGet(endpoint, {}, { signal: exec?.signal });
          return { instance: name, action, roleid, role };
        }
        if (action === 'delete') {
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_role:delete', target: `${name}:role:${roleid}`, risk: 'destroy', summary: `Delete role ${roleid}. ACL entries that used it stop granting anything.` },
            async () => {
              await controller.pvesh('delete', endpoint, { signal: exec?.signal });
              return { instance: name, action, roleid };
            },
          );
        }
        let list = privileges(args.privs);
        if (action === 'update' && args.append === true) {
          const current = await controller.pveshGet(endpoint, {}, { signal: exec?.signal });
          const existing = String(current?.privs ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
          list = [...new Set([...existing, ...list])];
        }
        if (list.length === 0) throw new VmError(`action=${action} needs privs`, 'BAD_ARGUMENT');
        const privs = list.join(',');
        const summary = `Set role ${roleid} to ${list.length} privileges: ${privs}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: `pve_role:${action}`, target: `${name}:role:${roleid}`, risk: 'danger', summary },
          async () => {
            if (action === 'create') {
              await controller.pvesh('create', '/access/roles', { params: { roleid, privs }, signal: exec?.signal });
            } else {
              await controller.pvesh('set', endpoint, { params: { privs }, signal: exec?.signal });
            }
            return { instance: name, action, roleid, privs };
          },
        );
      },
    },
    {
      name: 'pve_acl',
      description:
        'ACL entries: list, add/modify (set) or remove one. `path` is the object tree path (/ or /vms/100 or /storage/local), ' +
        'and exactly one of users/groups/tokens names the subject. Writes need a second confirmation — an ACL decides ' +
        'who may do what.',
      parameters: {
        action: { type: 'string', enum: ['list', 'set', 'remove'], required: true, description: 'ACL operation.' },
        path: { type: 'string', description: 'Object path, for example / or /vms/100.' },
        users: { type: 'string', description: 'Subject users, comma separated.' },
        groups: { type: 'string', description: 'Subject groups, comma separated.' },
        tokens: { type: 'string', description: 'Subject tokens as user@realm!tokenid.' },
        roles: { type: 'string', description: 'Roles to grant (set) or to remove (remove).' },
        propagate: { type: 'boolean', description: 'Inherit to children (default true).' },
        confirm: { type: 'string', description: 'The token from the first call, for set and remove.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.action === 'list') {
            const lines = (value.acl ?? []).map((entry) => aclLine(entry));
            return textOutput(`acl:\n${lines.join('\n') || 'empty'}`);
          }
          return textOutput(`acl ${value.action} on ${value.path}: ${value.roles}`);
        },
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        if (action === 'list') {
          const acl = await controller.pveshGet('/access/acl', {}, { signal: exec?.signal });
          const list = Array.isArray(acl) ? acl : [];
          const only = typeof args.path === 'string' ? args.path.trim() : '';
          return { instance: name, action, acl: only ? list.filter((entry) => entry.path === only) : list };
        }
        const path = String(args.path ?? '').trim();
        if (!path.startsWith('/')) throw new VmError('path must be an absolute object path such as / or /vms/100', 'BAD_ARGUMENT');
        const subjects = [
          ['users', args.users],
          ['groups', args.groups],
          ['tokens', args.tokens],
        ].filter(([, value]) => typeof value === 'string' && value.trim().length > 0);
        if (subjects.length !== 1) {
          throw new VmError('exactly one of users, groups or tokens must name the subject', 'BAD_ARGUMENT');
        }
        const [kind, value] = subjects[0];
        const roles = String(args.roles ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
        if (roles.length === 0) throw new VmError('roles is required', 'BAD_ARGUMENT');
        const propagate = args.propagate === false ? 0 : 1;
        const verb = action === 'remove' ? 'remove' : 'set';
        const summary = `${verb === 'remove' ? 'Remove' : 'Grant'} ${roles.join(', ')} ${verb === 'remove' ? 'from' : 'to'} ${kind} ${value} on ${path}${propagate ? ' (inherited by children)' : ''}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: `pve_acl:${verb}`, target: `${name}:acl:${path}:${kind}:${value}`, risk: 'danger', summary },
          async () => {
            const params = { path, roles: roles.join(','), [kind]: String(value), ...(verb === 'remove' ? { delete: 1 } : { propagate }) };
            await controller.pvesh('set', '/access/acl', { params, signal: exec?.signal });
            return { instance: name, action, path, roles: roles.join(','), subject: `${kind}:${value}` };
          },
        );
      },
    },
    {
      name: 'pve_token',
      description:
        'API tokens of a user: list them, create one, or remove one. The secret is shown exactly once, in the answer to ' +
        'create — it cannot be read again, only rotated by deleting and recreating. Writes need a second confirmation.',
      parameters: {
        action: { type: 'string', enum: ['list', 'create', 'remove'], required: true, description: 'Token operation.' },
        userid: { type: 'string', description: 'Token owner, for example root@pam.' },
        tokenid: { type: 'string', description: 'Token name (the part after the !).' },
        privsep: { type: 'boolean', description: 'Separate privileges: the token keeps its own set (default true).' },
        comment: { type: 'string', description: 'Comment.' },
        expire: { type: 'number', description: 'Expiry as a unix timestamp, 0 disables it.' },
        confirm: { type: 'string', description: 'The token from the first call, for create and remove.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.action === 'list') {
            const lines = (value.tokens ?? []).map((entry) => `${entry.tokenid}${entry.comment ? ` — ${entry.comment}` : ''}`);
            return textOutput(`tokens of ${value.userid}:\n${lines.join('\n') || 'none'}`);
          }
          if (value.action === 'create') {
            return textOutput(
              `token ${value.tokenid} created. The full value is below and will not be shown again:\n` +
                `PVEAPIToken=${value.userid}!${value.tokenid}=${value.secret}`,
            );
          }
          return textOutput(`token ${value.tokenid} of ${value.userid} removed`);
        },
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        const id = userId(args.userid);
        const base = `/access/users/${encodeURIComponent(id)}/token`;
        if (action === 'list') {
          const tokens = await controller.pveshGet(base, {}, { signal: exec?.signal });
          return { instance: name, action, userid: id, tokens: Array.isArray(tokens) ? tokens : [] };
        }
        const tokenid = String(args.tokenid ?? '').trim();
        if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(tokenid)) throw new VmError('a token name starts with a letter', 'BAD_ARGUMENT');
        if (action === 'remove') {
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_token:remove', target: `${name}:token:${id}!${tokenid}`, risk: 'destroy', summary: `Remove token ${tokenid} of ${id}. Anything authenticating with it stops working immediately.` },
            async () => {
              await controller.pvesh('delete', `${base}/${encodeURIComponent(tokenid)}`, { signal: exec?.signal });
              return { instance: name, action, userid: id, tokenid };
            },
          );
        }
        const params = { tokenid };
        if (args.privsep !== undefined) params.privsep = args.privsep ? 1 : 0;
        if (args.comment !== undefined) params.comment = String(args.comment);
        if (args.expire !== undefined) params.expire = Number(args.expire);
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'pve_token:create', target: `${name}:token:${id}!${tokenid}`, risk: 'danger', summary: `Create API token ${tokenid} for ${id}${params.privsep === 0 ? ' with the user privileges' : ' with separate privileges'}.` },
          async () => {
            const answer = await controller.pvesh('create', `${base}/${encodeURIComponent(tokenid)}`, { params, signal: exec?.signal });
            const info = answer.json ?? answer;
            return { instance: name, action, userid: id, tokenid, secret: info?.value ?? info?.secret ?? '', privsep: params.privsep };
          },
        );
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
