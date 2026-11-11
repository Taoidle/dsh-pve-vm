/**
 * Access-control operations the base access tools do not cover: realms and
 * their sync, TFA entries, effective permissions, the token owner's own
 * password, and token rotation.
 *
 * These are cluster-level privilege operations: every write is confirmed, and
 * a password or a fresh token secret is returned at most once (never repeated
 * in the summary).
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';
import {
  assignments,
  flag,
  isUnavailable,
  matchText,
  requireText,
  segment,
  unavailable,
} from '../lib/admin-util.js';

/** A user id as PVE writes it: name@realm. */
function userId(value) {
  return matchText(value, 'userid', /^[^\s@/]+@[A-Za-z][A-Za-z0-9_-]*$/, 'the format is name@realm');
}

/** A realm id. */
function realmId(value) {
  return matchText(value, 'realm', /^[A-Za-z][A-Za-z0-9_-]*$/, 'letters, digits, dash and underscore');
}

/** Remove the password from anything that might reach a renderer. */
function withoutSecret(value) {
  if (value === null || typeof value !== 'object') return value;
  const out = { ...value };
  delete out.password;
  delete out.bind_password;
  return out;
}

/**
 * Build the extra access-control tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function accessExtraTools(deps) {
  return [
    {
      name: 'pve_domain',
      description:
        'Authentication realms (`/access/domains`): list/get/create/update/delete them, or sync users and groups from a ' +
        'directory. Realm-specific settings travel as "key=value" options. Writes and sync need a confirmation token.',
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update', 'delete', 'sync'],
          required: true,
          description: 'Realm operation.',
        },
        realm: { type: 'string', description: 'Realm id, for example "ad" or "ldap".' },
        type: {
          type: 'string',
          enum: ['pve', 'pam', 'ad', 'ldap', 'openid'],
          description: 'Realm type for create.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Realm settings as "key=value" (server1, base_dn, bind_dn, user_attr, …).',
        },
        dry_run: { type: 'boolean', description: 'For sync: only report what would change.' },
        full: { type: 'boolean', description: 'For sync: also sync groups and users, not only the configured scope.' },
        purge: { type: 'boolean', description: 'For sync: remove entries that disappeared from the directory.' },
        enable_new: { type: 'boolean', description: 'For sync: create new users/groups.' },
        remove_vanished: { type: 'string', description: 'For sync: what to do with vanished entries.' },
        scope: { type: 'string', enum: ['both', 'groups', 'users'], description: 'For sync: what to synchronize.' },
        confirm: { type: 'string', description: 'The token from the first call, for create, update, delete and sync.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (args.action === 'list') {
            const lines = (value.domains ?? []).map((domain) => `${domain.realm}: ${domain.type ?? '?'}${domain.comment ? ` — ${domain.comment}` : ''}`);
            return textOutput(`realms:\n${lines.join('\n') || 'none'}`);
          }
          if (args.action === 'get') return textOutput(`realm ${value.realm}: ${JSON.stringify(withoutSecret(value.domain))}`);
          if (args.action === 'sync') return textOutput(`realm ${value.realm}: sync ${value.status ?? 'completed'}${value.dryRun ? ' (dry run)' : ''}.`);
          return textOutput(`realm ${value.realm}: ${value.action} done.`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        const signal = exec?.signal;
        if (action === 'list') {
          const domains = await controller.pveshGet('/access/domains', {}, { signal });
          return { instance: name, action, domains: Array.isArray(domains) ? domains : [] };
        }
        const realm = realmId(args.realm);
        if (action === 'get') {
          const domain = await controller.pveshGet(`/access/domains/${segment(realm)}`, {}, { signal });
          return { instance: name, action, realm, domain: withoutSecret(domain) };
        }
        const options = assignments(args.options);
        if (action === 'create') {
          const type = requireText(args.type, 'type');
          const params = { realm, type, ...options };
          const summary = `Create authentication realm ${realm} of type ${type}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_domain:create', target: `${name}:realm:${realm}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('create', '/access/domains', { params, signal });
              return { instance: name, action, realm };
            },
          );
        }
        if (action === 'delete') {
          const summary = `Delete authentication realm ${realm}: users and groups from it lose their permissions.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_domain:delete', target: `${name}:realm:${realm}`, risk: 'destroy', summary },
            async () => {
              await controller.pvesh('delete', `/access/domains/${segment(realm)}`, { signal });
              return { instance: name, action, realm };
            },
          );
        }
        if (action === 'sync') {
          const params = {};
          if (args.remove_vanished !== undefined) params['remove-vanished'] = String(args.remove_vanished);
          if (args.scope !== undefined) params.scope = String(args.scope);
          if (args.dry_run !== undefined) params['dry-run'] = flag(args.dry_run);
          if (args.full !== undefined) params.full = flag(args.full);
          if (args.purge !== undefined) params.purge = flag(args.purge);
          if (args.enable_new !== undefined) params['enable-new'] = flag(args.enable_new);
          const summary = `Sync realm ${realm} from its directory${args.dry_run ? ' (dry run)' : ''}${args.purge ? ', purging vanished entries' : ''}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_domain:sync', target: `${name}:realm:${realm}:sync`, risk: 'danger', summary },
            async () => {
              const result = await controller.pvesh('create', `/access/domains/${segment(realm)}/sync`, { params, signal, timeoutMs: 300_000 });
              return { instance: name, action, realm, dryRun: Boolean(args.dry_run), status: typeof result.json === 'string' ? result.json : 'completed' };
            },
          );
        }
        if (Object.keys(options).length === 0) throw new VmError('action=update needs at least one option', 'BAD_ARGUMENT');
        const summary = `Change realm ${realm}: ${Object.keys(options).join(', ')}.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'pve_domain:update', target: `${name}:realm:${realm}`, risk: 'danger', summary },
          async () => {
            await controller.pvesh('set', `/access/domains/${segment(realm)}`, { params: options, signal });
            return { instance: name, action, realm, changed: Object.keys(options) };
          },
        );
      },
    },
    {
      name: 'pve_tfa',
      description:
        'Two-factor entries of a user: list them (`/access/users/<userid>/tfa`) or delete one (`/access/tfa/<userid>/<id>`). ' +
        'Deleting a TFA entry weakens the account and needs a destroy-level confirmation token.',
      parameters: {
        action: { type: 'string', enum: ['list', 'delete'], required: true, description: 'TFA operation.' },
        userid: { type: 'string', description: 'User id, name@realm.' },
        id: { type: 'string', description: 'TFA entry id (delete only).' },
        password: { type: 'string', description: 'The user\'s current password, if the realm requires it for deletion.' },
        confirm: { type: 'string', description: 'The token from the first call, for delete.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (args.action === 'list') {
            const lines = (value.entries ?? []).map((entry) => `${entry.id}: ${entry.type ?? '?'}${entry.enable ? '' : ' (disabled)'}${entry.description ? ` — ${entry.description}` : ''}`);
            return textOutput(`TFA entries of ${value.userid}:\n${lines.join('\n') || 'none'}`);
          }
          return textOutput(`TFA entry ${value.id} deleted from ${value.userid}.`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const userid = userId(args.userid);
        if (args.action === 'list') {
          const entries = await controller.pveshGet(`/access/users/${segment(userid)}/tfa`, {}, { signal: exec?.signal });
          return { instance: name, action: 'list', userid, entries: Array.isArray(entries) ? entries : [] };
        }
        const id = matchText(args.id, 'id', /^[A-Za-z0-9._-]+$/, 'the TFA entry id');
        const summary = `Delete TFA entry ${id} from ${userid}: that factor can no longer be used to sign in.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'pve_tfa:delete', target: `${name}:tfa:${userid}:${id}`, risk: 'destroy', summary },
          async () => {
            const params = {};
            if (args.password !== undefined) params.password = String(args.password);
            await controller.pvesh('delete', `/access/tfa/${segment(userid)}/${segment(id)}`, { params, signal: exec?.signal });
            return { instance: name, action: 'delete', userid, id };
          },
        );
      },
    },
    {
      name: 'pve_permissions',
      description:
        'Effective permissions: the whole ACL map (`/access/permissions`), optionally on one path, or the permissions ' +
        'of one user. PVE 7.4 has no per-user endpoint, so the user view filters /access/permissions by userid. Read-only.',
      parameters: {
        action: { type: 'string', enum: ['list', 'user'], required: true, description: 'Permission view.' },
        path: { type: 'string', description: 'Only permissions on this object path, for example /vms/104.' },
        userid: { type: 'string', description: 'User id for action=user (name@realm).' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          const entries = Object.entries(value.permissions ?? {});
          const lines = entries.map(([key, privs]) => `${key}: ${Object.keys(privs ?? {}).join(', ')}`);
          const target = value.userid ? ` for ${value.userid}` : value.path ? ` on ${value.path}` : '';
          return textOutput(`permissions${target}:\n${lines.join('\n') || 'none'}`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const params = {};
        if (args.path !== undefined) params.path = requireText(args.path, 'path');
        if (args.action === 'list') {
          if (args.userid !== undefined) params.userid = userId(args.userid);
          const permissions = await controller.pveshGet('/access/permissions', params, { signal: exec?.signal });
          return { instance: name, action: 'list', path: args.path, permissions };
        }
        const userid = userId(args.userid);
        try {
          const permissions = await controller.pveshGet(`/access/users/${segment(userid)}/permissions`, params, { signal: exec?.signal });
          return { instance: name, action: 'user', userid, permissions };
        } catch (error) {
          if (!isUnavailable(error)) throw error;
          const permissions = await controller.pveshGet('/access/permissions', { ...params, userid }, { signal: exec?.signal });
          return {
            instance: name,
            action: 'user',
            userid,
            permissions,
            note: 'Filtered /access/permissions: the per-user endpoint does not exist on this PVE release.',
          };
        }
      },
    },
    {
      name: 'pve_password',
      description:
        'Change the password of the token owner (or another user the token may modify) via PUT /access/password. This is ' +
        'the credential the plugin itself may be using, so it needs a danger-level confirmation token. The password is ' +
        'never echoed back.',
      parameters: {
        userid: { type: 'string', description: 'User id, name@realm.' },
        password: { type: 'string', description: 'The new password.' },
        confirm: { type: 'string', description: 'The token from the first call.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          return textOutput(`password changed for ${value.userid}`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const userid = userId(args.userid);
        const password = requireText(args.password, 'password', 1024);
        const summary = `Change the password of ${userid}. The current password stops working immediately.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'pve_password:set', target: `${name}:password:${userid}`, risk: 'danger', summary },
          async () => {
            await controller.pvesh('set', '/access/password', { params: { userid, password }, signal: exec?.signal });
            return { instance: name, userid, changed: true };
          },
        );
      },
    },
    {
      name: 'pve_token_rotate',
      description:
        'Rotate an API token: PUT the token with regenerate=1 and return the new secret once. The old secret stops working ' +
        'immediately, so this needs a destroy-level confirmation token. PVE 7.4 does not implement regenerate; the tool ' +
        'then answers available:false and changes nothing.',
      parameters: {
        userid: { type: 'string', description: 'Token owner, name@realm.' },
        tokenid: { type: 'string', description: 'Token id (the part after the !).' },
        privsep: { type: 'boolean', description: 'Keep privileges separate from the owner.' },
        expire: { type: 'number', description: 'Expiry as a unix timestamp, 0 disables it.' },
        comment: { type: 'string', description: 'Comment for the token.' },
        confirm: { type: 'string', description: 'The token from the first call.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (value.available === false) return textOutput(value.note);
          return textOutput(`token ${value.userid}!${value.tokenid} rotated; the new secret is ${value.secret ?? '(not returned by this PVE release)'} — it is shown once.`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const userid = userId(args.userid);
        const tokenid = matchText(args.tokenid, 'tokenid', /^[A-Za-z0-9._-]+$/, 'letters, digits, dot, dash and underscore');
        const params = { regenerate: 1 };
        for (const key of ['comment']) if (args[key] !== undefined) params[key] = String(args[key]);
        if (args.privsep !== undefined) params.privsep = flag(args.privsep);
        if (args.expire !== undefined) params.expire = Number(args.expire);
        const summary = `Rotate token ${userid}!${tokenid}: the old secret stops working immediately.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'pve_token_rotate', target: `${name}:token:${userid}:${tokenid}`, risk: 'destroy', summary },
          async () => {
            try {
              const result = await controller.pvesh('set', `/access/users/${segment(userid)}/token/${segment(tokenid)}`, { params, signal: exec?.signal });
              const data = result.json ?? {};
              return { instance: name, userid, tokenid, secret: data.value ?? data.secret };
            } catch (error) {
              if (!isUnavailable(error) && !/regenerate|unknown option|unknown parameter/i.test(String(error?.message ?? ''))) throw error;
              return {
                instance: name,
                userid,
                tokenid,
                ...unavailable('token rotation', 'This PVE release does not implement regenerate=1; recreate the token with pve_token remove + create instead.'),
              };
            }
          },
        );
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
