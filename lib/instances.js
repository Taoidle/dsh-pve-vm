/**
 * The `instance` argument shared by every tool, and the per-call target lookup.
 *
 * The argument is injected in one place instead of being repeated in sixteen tool
 * definitions, and the result schemas get the matching property so a tool can
 * report which host answered — every schema in this plugin is
 * `additionalProperties: false`, so an extra key would otherwise be a violation.
 */
import { VmError } from './session.js';

/** Description of the `instance` argument, shared by every tool. */
export const INSTANCE_PARAM = {
  type: 'string',
  description:
    'PVE instance to work with: a name from the `instances` list in the plugin settings. Omit for the default instance.',
};

/**
 * Drop `undefined` members before the answer leaves the plugin.
 *
 * A JSON object with an `undefined` value is not "lossless JSON" as far as the
 * harness is concerned: it validates the value by round-tripping it, and the key
 * disappears. Optional fields (a node without swap, a cluster wide firewall
 * answer) are therefore written as `undefined` and pruned here, once, instead of
 * every tool remembering to omit them.
 * @param {unknown} value any tool answer.
 * @returns {unknown} the same value without undefined object members.
 */
export function prune(value) {
  if (Array.isArray(value)) {
    const list = value.map((entry) => prune(entry)).filter((entry) => entry !== undefined);
    return list;
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = prune(entry);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return value;
}

/** One call's target: which instance, and the controller of that instance. */
export function instanceOf(deps, args) {
  const pool = deps.pool;
  if (pool === undefined) throw new VmError('the plugin has no controller pool', 'BAD_INSTANCE');
  return pool.target(args?.instance);
}

/**
 * Build the mapper that adds the `instance` argument to a tool definition.
 * @param {{pool: object}} deps tool dependencies, for the per-call lookup.
 * @returns {(options: object) => object} a mapper for a raw definition (before `defineTool`).
 */
export function withInstance(deps) {
  return (options) => {
    const parameters = options.parameters ?? {};
    if (parameters.instance === undefined) {
      // First: with several hosts this is the argument that decides *where* the
      // call goes, so it is read before the VM is chosen.
      options.parameters = { instance: INSTANCE_PARAM, ...parameters };
    }
    options.output = options.output ?? {};
    options.output.schema = allowInstance(options.output.schema);

    const execute = options.execute;
    options.execute = async (args, exec) => {
      // Resolved before the work starts, so a mistyped name fails without a
      // half-finished action on some other host.
      const target = instanceOf(deps, args);
      const value = prune(await execute(args, exec));
      // Stamp the host on the answer: a screenshot of "VM 100" is ambiguous once
      // two hosts are configured, and the renderers show this field.
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && value.instance === undefined) {
        return { ...value, instance: target.name };
      }
      return value;
    };
    return options;
  };
}

/**
 * Add the `instance` property to a result schema, including inside `oneOf`.
 * @param {object} schema a JSON schema.
 * @returns {object} the same schema, widened.
 */
function allowInstance(schema) {
  if (schema === null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema.oneOf)) {
    schema.oneOf = schema.oneOf.map((part) => allowInstance(part));
    return schema;
  }
  if (Array.isArray(schema.anyOf)) {
    schema.anyOf = schema.anyOf.map((part) => allowInstance(part));
    return schema;
  }
  if (schema.type === 'object' || schema.properties !== undefined) {
    schema.properties = { ...(schema.properties ?? {}), instance: { type: 'string', description: 'The PVE instance that answered.' } };
  }
  return schema;
}
