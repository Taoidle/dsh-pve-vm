/**
 * Node certificates, subscriptions and the notification endpoints probe.
 *
 * The notification API arrived after PVE 7.4, so that tool is written to
 * answer "not available on this PVE version" instead of failing.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { instanceOf, withInstance } from '../lib/instances.js';
import { runGuarded } from '../lib/confirm.js';
import { PLAIN_SCHEMA, textOutput } from '../lib/tool-output.js';
import { VmError } from '../lib/session.js';
import { flag, isUnavailable, nodeOf, optionalText, requireBlock, requireText, segment, unavailable } from '../lib/admin-util.js';

const SUBSCRIPTION_KEY = /^pve([1248])([cbsp])-[0-9a-f]{10}$/;

/** One certificate as a short line. */
function describeCertificate(entry) {
  const subject = entry.subject ?? entry.filename ?? 'certificate';
  const expiry = entry.notafter ? ` until ${entry.notafter}` : '';
  return `${subject}${expiry}${entry.issuer ? ` (issuer ${entry.issuer})` : ''}`;
}

/**
 * Build the monitoring tools.
 * @param {{pool: object, settings: () => object, confirms: object}} deps plugin dependencies.
 */
export function monitorExtraTools(deps) {
  return [
    {
      name: 'pve_certificate',
      description:
        'Inspect the node certificate store and manage the custom/ACME certificate: upload a custom certificate, ' +
        'delete it, order/renew/revoke an ACME certificate. Every write needs a confirmation token.',
      parameters: {
        action: {
          type: 'string',
          enum: ['info', 'upload', 'delete-custom', 'acme-order', 'acme-renew', 'acme-revoke'],
          required: true,
          description: 'Certificate operation.',
        },
        node: { type: 'string', description: 'Node (default: this instance\'s node).' },
        certificates: { type: 'string', description: 'PEM certificate chain (upload).' },
        key: { type: 'string', description: 'PEM private key (upload; omit to keep the existing key).' },
        force: { type: 'boolean', description: 'Force the operation.' },
        restart: { type: 'boolean', description: 'Restart pveproxy after the change.' },
        confirm: { type: 'string', description: 'The token from the first call, for every write.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (args.action === 'info') {
            const lines = (value.certificates ?? []).map(describeCertificate);
            return textOutput(`certificates on ${value.node}:\n${lines.join('\n') || 'none'}`);
          }
          return textOutput(`certificate ${value.action} on ${value.node} done.`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        const signal = exec?.signal;
        const node = await nodeOf(controller, args);
        const n = segment(node);
        if (action === 'info') {
          const certificates = await controller.pveshGet(`/nodes/${n}/certificates/info`, {}, { signal });
          return { instance: name, node, action, certificates: Array.isArray(certificates) ? certificates : [] };
        }
        if (action === 'upload') {
          const certificates = requireBlock(args.certificates, 'certificates', 200000);
          const params = { certificates };
          if (args.key !== undefined) params.key = requireBlock(args.key, 'key', 200000);
          if (args.force !== undefined) params.force = flag(args.force);
          if (args.restart !== undefined) params.restart = flag(args.restart);
          const summary = `Upload a custom TLS certificate on ${node}${args.restart ? ' and restart pveproxy' : ''}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_certificate:upload', target: `${name}:cert:${node}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('create', `/nodes/${n}/certificates/custom`, { params, signal });
              return { instance: name, node, action };
            },
          );
        }
        if (action === 'delete-custom') {
          const params = {};
          if (args.restart !== undefined) params.restart = flag(args.restart);
          const summary = `Delete the custom TLS certificate on ${node}; the node falls back to its default certificate.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_certificate:delete-custom', target: `${name}:cert:${node}`, risk: 'destroy', summary },
            async () => {
              await controller.pvesh('delete', `/nodes/${n}/certificates/custom`, { params, signal });
              return { instance: name, node, action };
            },
          );
        }
        const path = `/nodes/${n}/certificates/acme/certificate`;
        const params = {};
        if (args.force !== undefined) params.force = flag(args.force);
        if (action === 'acme-order') {
          const summary = `Order an ACME certificate for ${node}; this contacts the configured ACME account.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_certificate:acme-order', target: `${name}:acme:${node}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('create', path, { params, signal });
              return { instance: name, node, action };
            },
          );
        }
        if (action === 'acme-renew') {
          const summary = `Renew the ACME certificate for ${node}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_certificate:acme-renew', target: `${name}:acme:${node}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('set', path, { params, signal });
              return { instance: name, node, action };
            },
          );
        }
        const summary = `Revoke the ACME certificate for ${node}; HTTPS falls back to the default certificate.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'pve_certificate:acme-revoke', target: `${name}:acme:${node}`, risk: 'destroy', summary },
          async () => {
            await controller.pvesh('delete', path, { params, signal });
            return { instance: name, node, action };
          },
        );
      },
    },
    {
      name: 'pve_subscription',
      description:
        'Read, set or remove the node subscription key, or refresh the subscription state from the Proxmox shop. ' +
        'Setting and deleting the key need a confirmation token.',
      parameters: {
        action: { type: 'string', enum: ['get', 'set', 'check', 'delete'], required: true, description: 'Subscription operation.' },
        node: { type: 'string', description: 'Node (default: this instance\'s node).' },
        key: { type: 'string', description: 'Subscription key, for example pve8c-0123456789 (set).' },
        force: { type: 'boolean', description: 'Force the refresh even if the last check is recent (check).' },
        confirm: { type: 'string', description: 'The token from the first call, for set and delete.' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.status === 'confirmation-required') return textOutput(value.summary);
          if (args.action === 'get') {
            const status = value.subscription ?? {};
            return textOutput(
              `subscription on ${value.node}: ${status.status ?? 'unknown'}${status.level ? ` (${status.level})` : ''}` +
                `${status.key ? `, key …${String(status.key).slice(-4)}` : ''}${status.nextduedate ? `, due ${status.nextduedate}` : ''}`,
            );
          }
          if (args.action === 'check') return textOutput(`subscription check on ${value.node}: ${value.subscription?.status ?? 'done'}`);
          return textOutput(`subscription ${value.action} on ${value.node} done.`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        const action = args.action;
        const signal = exec?.signal;
        const node = await nodeOf(controller, args);
        const base = `/nodes/${segment(node)}/subscription`;
        if (action === 'get') {
          const subscription = await controller.pveshGet(base, {}, { signal });
          return { instance: name, node, action, subscription };
        }
        if (action === 'check') {
          const params = {};
          if (args.force !== undefined) params.force = flag(args.force);
          await controller.pvesh('create', base, { params, signal });
          return { instance: name, node, action };
        }
        if (action === 'set') {
          const key = requireText(args.key, 'key');
          if (!SUBSCRIPTION_KEY.test(key)) throw new VmError('key must look like pve8c-0123456789', 'BAD_ARGUMENT');
          const summary = `Set the subscription key on ${node} to …${key.slice(-4)}.`;
          return runGuarded(
            deps.confirms,
            { args, instance: name, action: 'pve_subscription:set', target: `${name}:subscription:${node}`, risk: 'danger', summary },
            async () => {
              await controller.pvesh('set', base, { params: { key }, signal });
              return { instance: name, node, action };
            },
          );
        }
        const summary = `Delete the subscription key on ${node}; paid repository access stops at the next check.`;
        return runGuarded(
          deps.confirms,
          { args, instance: name, action: 'pve_subscription:delete', target: `${name}:subscription:${node}`, risk: 'destroy', summary },
          async () => {
            await controller.pvesh('delete', base, { signal });
            return { instance: name, node, action };
          },
        );
      },
    },
    {
      name: 'pve_notifications',
      description:
        'List the cluster notification endpoints. Introduced after PVE 7.4: on an older node the tool reports that the ' +
        'API is not available instead of failing.',
      parameters: {
        type: { type: 'string', description: 'Optional endpoint type filter (sendmail, gotify, smtp, webhook).' },
      },
      output: {
        schema: PLAIN_SCHEMA,
        render: (args, value) => {
          if (value?.available === false) return textOutput(value.note);
          const lines = (value.endpoints ?? []).map((entry) => `${entry.name} (${entry.type ?? 'endpoint'})${entry.disable ? ' — disabled' : ''}`);
          return textOutput(`notification endpoints:\n${lines.join('\n') || 'none'}`);
        },
      },
      async execute(args, exec) {
        const { controller, name } = instanceOf(deps, args);
        try {
          const endpoints = await controller.pveshGet('/cluster/notifications/endpoints', {}, { signal: exec?.signal });
          const list = Array.isArray(endpoints) ? endpoints : [];
          const filtered = args.type ? list.filter((entry) => entry.type === args.type) : list;
          return { instance: name, available: true, endpoints: filtered };
        } catch (error) {
          if (isUnavailable(error)) return { instance: name, ...unavailable('notifications', 'Notification endpoints are not available on this PVE version (needs PVE 8 or newer).') };
          throw error;
        }
      },
    },
  ]
    .map(withInstance(deps))
    .map((options) => defineTool(options));
}
