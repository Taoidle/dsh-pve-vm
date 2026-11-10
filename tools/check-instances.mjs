#!/usr/bin/env node
/**
 * Check of the multi-instance layer: a settings section with several PVE hosts,
 * the per-instance settings handed to one controller, the controller pool that
 * resolves a tool call's `instance`, the panel state per instance, and the tool
 * surface (every tool takes `instance` and answers with it).
 *
 * Run from the plugin directory:
 *   node tools/check-instances.mjs
 *
 * A dev-time script: it imports the harness compiler like tools/check-plugin.mjs
 * does, and the volatile shim first (see tools/volatile-shim.mjs).
 */
import './volatile-shim.mjs';
import process from 'node:process';

const problems = [];
const note = (message) => problems.push(message);
const show = (value) => {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
};
const eq = (actual, expected, label) => {
  if (show(actual) !== show(expected)) note(`${label}: expected ${show(expected)}, got ${show(actual)}`);
};
const ok = (condition, label) => {
  if (!condition) note(label);
};

const DSH_PACKAGES =
  process.env.DSH_PACKAGES ?? '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
async function loadCompiler() {
  try {
    return await import('@deepseek-ai/dsh-tools');
  } catch {
    // Not resolvable from here — fall through to the installation path.
  }
  return import(`${DSH_PACKAGES}/dsh-tools/lib/index.js`);
}

const { resolveSettings, instanceSettings, CONFIG_KEYS } = await import('../lib/config.js');
const { ControllerPool } = await import('../lib/pool.js');
const { ConsoleView } = await import('../lib/view.js');

// A single host configured the 0.2.x way must keep working: one instance named
// `default`, described by the top-level ssh fields.
const legacy = resolveSettings({ sshHost: 'pve1', sshUser: 'admin', allowVmids: [100, 200] });
eq(legacy.instances.length, 1, 'legacy: instance count');
eq(legacy.instances[0].name, 'default', 'legacy: instance name');
eq(legacy.instance, 'default', 'legacy: default instance');
eq(legacy.defaultInstance, 'default', 'legacy: defaultInstance');
eq(legacy.ssh.host, 'pve1', 'legacy: ssh host');
eq(legacy.ssh.user, 'admin', 'legacy: ssh user');
eq(legacy.allowVmids, [100, 200], 'legacy: allowVmids');
eq(instanceSettings(legacy, 'default').ssh.host, 'pve1', 'legacy: instanceSettings host');

// Two hosts: fields the entry omits fall back to the top-level ones, an empty
// per-instance allowVmids inherits the global list, and defaultInstance picks
// the host a call without `instance` lands on.
const multi = resolveSettings({
  sshHost: 'pve-default',
  sshUser: 'root',
  allowVmids: [10],
  defaultInstance: 'prod',
  instances: [
    { name: 'lab', sshHost: '10.0.0.11', allowVmids: [100, 101] },
    { name: 'prod', sshHost: '10.0.1.11', sshUser: 'admin' },
  ],
});
eq(multi.instances.map((entry) => entry.name), ['lab', 'prod'], 'multi: names');
eq(multi.defaultInstance, 'prod', 'multi: defaultInstance');
eq(multi.instance, 'prod', 'multi: default instance');
eq(multi.ssh.host, '10.0.1.11', 'multi: default ssh host');
eq(multi.ssh.user, 'admin', 'multi: default ssh user');
eq(multi.allowVmids, [10], 'multi: default allowVmids');
eq(multi.instances[1].allowVmids, [10], 'multi: inherited allowVmids');
eq(multi.instances[0].allowVmids, [100, 101], 'multi: own allowVmids');
const lab = instanceSettings(multi, 'lab');
eq(lab.ssh.host, '10.0.0.11', 'multi: lab host');
eq(lab.ssh.user, 'root', 'multi: lab inherits the ssh user');
eq(lab.allowVmids, [100, 101], 'multi: lab allowVmids');
eq(instanceSettings(multi, 'prod').allowVmids, [10], 'multi: prod allowVmids');
eq(lab.view.fps, multi.view.fps, 'multi: panel settings survive the per-instance view');

// An entry without a name gets a generated one; duplicates are suffixed, so a
// tool call always has an unambiguous name to pass.
const generated = resolveSettings({
  instances: [{ sshHost: 'a' }, { sshHost: 'b' }, { name: 'x', sshHost: 'c' }, { name: 'x', sshHost: 'd' }],
});
eq(generated.instances.map((entry) => entry.name), ['pve-1', 'pve-2', 'x', 'x-2'], 'generated: names');

// An unknown name is a configuration error worth quoting the configured list for.
try {
  instanceSettings(multi, 'nope');
  note('instanceSettings: an unknown instance did not throw');
} catch (error) {
  ok(/unknown PVE instance/.test(error.message), `instanceSettings: unclear message — ${error.message}`);
  ok(error.message.includes('lab'), 'instanceSettings: the message does not list the configured names');
}

// The pool: one controller per instance, resolved by name, tolerant of case.
const fakeSpawn = () => ({
  stdin: null,
  stdout: null,
  stderr: null,
  done: Promise.resolve({ exitCode: 0, signal: null }),
  terminate() {},
  waitForExit: async () => true,
});
const pool = new ControllerPool({ settings: () => multi, spawn: fakeSpawn, cwd: process.cwd() });
eq(pool.names(), ['lab', 'prod'], 'pool: names');
eq(pool.resolve(undefined), 'prod', 'pool: default');
eq(pool.resolve(''), 'prod', 'pool: empty name is the default');
eq(pool.resolve('lab'), 'lab', 'pool: exact name');
eq(pool.resolve('LAB'), 'lab', 'pool: case-insensitive name');
const labTarget = pool.target('lab');
const prodTarget = pool.target();
eq(labTarget.name, 'lab', 'pool: target name');
eq(labTarget.settings.ssh.host, '10.0.0.11', 'pool: target settings');
eq(prodTarget.name, 'prod', 'pool: default target');
ok(labTarget.controller !== prodTarget.controller, 'pool: two instances share one controller');
ok(pool.target('lab').controller === labTarget.controller, 'pool: the controller is not cached');
ok(labTarget.controller instanceof (await import('../lib/session.js')).VmController, 'pool: not a VmController');
try {
  pool.target('nope');
  note('pool: an unknown instance did not throw');
} catch (error) {
  eq(error.code, 'BAD_INSTANCE', 'pool: error code');
  ok(/no PVE instance named "nope"/.test(error.message), `pool: unclear message — ${error.message}`);
}
eq(pool.used().map((entry) => entry.name), ['lab', 'prod'], 'pool: used()');

// The panel state is per instance; a stale name from a previous configuration
// falls back to the default instead of blanking the panel.
const view = new ConsoleView({ pool, settings: () => multi });
const labState = view.state('lab');
eq(labState.instance, 'lab', 'view: state instance');
eq(labState.allowed, [100, 101], 'view: state allowVmids');
eq(labState.instances.map((entry) => entry.name), ['lab', 'prod'], 'view: state inventory');
eq(labState.instances[0].host, '10.0.0.11', 'view: state inventory host');
eq(view.state().instance, 'prod', 'view: state default');
eq(view.state('gone').instance, 'prod', 'view: stale name falls back to the default');

// The tool surface: every tool names an instance and answers with it, or the
// model cannot tell which host an answer came from.
const { assertSupportedJsonSchema } = await loadCompiler();
const registered = [];
const ctx = {
  tools: { register: (definition) => registered.push(definition) },
  attachments: { saveImage: async () => ({ attachmentId: 'x', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }) },
  subprocess: { spawn: fakeSpawn },
  effect: (fn) => {
    const disposer = fn();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  inject: () => {},
};
const live = (value) => ({ get: () => value });
const liveConfig = Object.fromEntries(
  Object.entries({ ...multi, instances: multi.instances, defaultInstance: multi.defaultInstance }).map(([key, value]) => [
    key,
    live(value),
  ]),
);
const plugin = await import('../index.js');
try {
  plugin.apply(ctx, liveConfig);
} catch (error) {
  note(`apply threw: ${error?.stack ?? error}`);
}
ok(registered.length > 0, 'apply registered no tools');
/** Whether a schema lets an `instance` string through, oneOf branches included. */
const allowsInstance = (schema) => {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.properties?.instance?.type === 'string') return true;
  return [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].some(allowsInstance);
};
for (const definition of registered) {
  const name = definition?.name ?? '<unnamed>';
  eq(definition?.parameters?.properties?.instance?.type, 'string', `${name}: parameters.instance`);
  ok(allowsInstance(definition?.output?.schema), `${name}: the output schema rejects instance`);
  try {
    assertSupportedJsonSchema(definition.parameters ?? {});
    assertSupportedJsonSchema(definition.output?.schema);
  } catch (error) {
    note(`${name}: the registry will reject a schema — ${error.message}`);
  }
}

// A call naming an unconfigured host must fail as a configuration error before
// anything is spawned.
const status = registered.find((definition) => definition.name === 'vm_status');
if (!status) note('vm_status is not registered');
else {
  try {
    await status.execute({ instance: 'nope' }, {});
    note('vm_status: an unknown instance did not fail');
  } catch (error) {
    ok(/no PVE instance named "nope"/.test(error.message), `vm_status: unclear failure — ${error.message}`);
  }
}

// The new keys must reach the settings form, or a profile cannot configure a
// second host at all.
ok(CONFIG_KEYS.includes('instances'), 'CONFIG_KEYS is missing instances');
ok(CONFIG_KEYS.includes('defaultInstance'), 'CONFIG_KEYS is missing defaultInstance');

if (problems.length === 0) console.log(JSON.stringify({ problems: [] }));
else {
  console.log(JSON.stringify({ problems }, null, 2));
  process.exitCode = 1;
}
