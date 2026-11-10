#!/usr/bin/env node
/**
 * Behavioural check of the settings card: the host list is a card editor, and the
 * card's own logic (add, validate, save, make default, remove, rename) only shows
 * up when the component actually runs. There is no DOM in this checkout, so the
 * file below is a ~120-line renderer: function components, hooks and event
 * handlers, with the design-system primitives mapped to plain host elements.
 *
 *   node tools/check-client-ui.mjs
 *
 * It asserts, not reports: a non-zero exit means the settings card would lie
 * about what it wrote.
 */

/* A tiny renderer: function components, hooks and event handlers, no DOM. */
const ELEMENT = Symbol.for('react.element');
const el = (type, props) => ({ $$typeof: ELEMENT, type, props: props ?? {} });
const jsx = (type, props, key) => (props && props.children === undefined && key !== undefined ? el(type, { ...props }) : el(type, props));

const stores = new Map();
let current = null;
let pending = [];
let dirty = false;

function rerender() {
  dirty = true;
  queueMicrotask(() => {
    if (!dirty) return;
    dirty = false;
    root.render();
  });
}

const React = {
  useState(init) {
    const store = current;
    const index = store.index++;
    if (!(index in store.states)) store.states[index] = typeof init === 'function' ? init() : init;
    const set = (next) => {
      store.states[index] = typeof next === 'function' ? next(store.states[index]) : next;
      rerender();
    };
    return [store.states[index], set];
  },
  useMemo(fn) {
    return fn();
  },
  useEffect(fn) {
    current.effects.push(fn);
  },
  useRef(init) {
    const store = current;
    const index = store.index++;
    if (!(index in store.states)) store.states[index] = { current: init };
    return store.states[index];
  },
};

const stubs = {
  react: React,
  'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
  '@deepseek-ai/dsh-client-ui-primitives': {
    Button: 'button',
    Checkbox: 'input',
    Input: 'input',
  },
};

let captured = null;
globalThis.window = { __ModuleLoader__: { load(entry) { captured = entry; } } };
globalThis.document = { getElementById: () => null, createElement: () => ({ id: '', textContent: '', remove() {} }), head: { append() {} } };
await import(new URL('../client.js', import.meta.url).href);
const module = captured.factory((name) => {
  if (!Object.hasOwn(stubs, name)) throw new Error('unknown require ' + name);
  return stubs[name];
});

/* The host side of the settings: a value object plus the subscribers. */
const subscribers = new Set();
const writes = [];
let value = {};
const form = {
  getSnapshot: () => ({ status: 'ready', writable: true, user: {}, value }),
  subscribe: (cb) => (subscribers.add(cb), () => subscribers.delete(cb)),
  set: async (key, next) => {
    writes.push([key, next]);
    value = { ...value, [key]: next };
    for (const cb of [...subscribers]) cb();
    return true;
  },
  unset: async () => true,
};
const dictionaries = [];
const registrations = [];
const locale = {
  register: (ns, id, dict) => (dictionaries.push({ id, dict }), () => {}),
  getLocale: () => ({ active: 'en', locales: [], revision: 1 }),
  subscribe: () => () => {},
  bind: () => (key, params) => {
    const found = dictionaries.find((entry) => entry.id === 'en') ?? dictionaries[0];
    let text = found?.dict[key] ?? key;
    for (const [name, val] of Object.entries(params ?? {})) text = text.replace('{' + name + '}', String(val));
    return text;
  },
};
const slots = { inject: (slot, cb) => (cb(), () => {}), register: (r, c) => (registrations.push({ registration: r, component: c }), () => {}) };
const ctx = {
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  locale, slots,
  configForms: { get: () => form },
  inject: (services, cb) => { const d = cb({ slots, sidebarRight: { mounted: { getSnapshot: () => 's1', subscribe: () => () => {} }, openTabIn() {} }, sidebarRightTabs: { register: () => () => {} }, locale, configForms: { get: () => form } }); return typeof d === 'function' ? d : () => {}; },
};
module.apply(ctx);
const registration = registrations.find((entry) => entry.registration.name === 'settings.section');
const Section = registration.component;
const cardProps = registration.registration.inject;

/* Expand function components; keep host elements as nodes. */
function instantiate(node, path) {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return { type: 'text', props: { children: String(node) }, path };
  if (Array.isArray(node)) return node.map((child, index) => instantiate(child, path + '.' + index)).flat();
  const { type, props } = node;
  if (typeof type === 'function') {
    const name = type.name || 'anon';
    let store = stores.get(name);
    if (!store) { store = { states: [], index: 0, effects: [] }; stores.set(name, store); }
    const previous = current;
    current = store;
    store.index = 0;
    const rendered = instantiate(type(props), path + '/' + name);
    current = previous;
    pending.push(...store.effects.splice(0));
    return rendered;
  }
  const kids = instantiate(props?.children, path + '/' + type);
  return { type, props: { ...props, children: kids }, path };
}

function flatten(value) {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (value === null || value === undefined || typeof value !== 'object') return [];
  return [value, ...flatten(value.props?.children)];
}

const root = {
  render() {
    const props = { ...cardProps() };
    const tree = instantiate(el(Section, props), 'root');
    const flat = flatten(tree);
    for (const effect of pending.splice(0)) { try { effect(); } catch (error) { console.error('effect failed', error); } }
    return flat;
  },
  find(predicate) { return flatten(this.nodes).filter(predicate); },
  nodes: [],
};

async function settle() { for (let i = 0; i < 6; i += 1) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); }

let nodes = (root.nodes = root.render());

const uniq = (list) => [...new Set(list)];
const buttons = () => uniq(flatten(nodes).filter((n) => n.type === 'button'));
const labelOf = (node) => flatten(node.props.children).map((c) => c.props?.children ?? '').join('');
const click = async (text) => {
  const hit = buttons().find((b) => labelOf(b) === text);
  if (!hit) throw new Error(`no button "${text}"; have ${buttons().map(labelOf).join(' | ')}`);
  await hit.props.onClick?.();
  await settle();
  nodes = root.nodes = root.render();
  await settle();
};
const inputs = () => uniq(flatten(nodes).filter((n) => n.type === 'input'));
const typeInto = async (index, text) => { inputs()[index].props.onChange?.({ target: { value: text } }); await settle(); nodes = root.nodes = root.render(); await settle(); };
const texts = () => uniq(flatten(nodes).filter((n) => n.type === 'div' || n.type === 'span')).map(labelOf);

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

/* 1. empty state: one Add button, and nothing that edits a host without a card. */
check(buttons().length === 1, `empty: buttons ${buttons().map(labelOf).join(',')}`);
check(!texts().includes('One host, legacy form'), 'the legacy single-host block is still rendered');
check(!texts().includes('Proxmox host'), 'an ssh-host field is editable without a host card');

/* 2. add a host, fill name + address, save. */
await click('Add host');
check(inputs().length >= 9, `editor: expected at least 9 inputs, got ${inputs().length}`);
await typeInto(0, 'lab');
await typeInto(1, '10.0.0.11');
await click('Save');
const firstWrite = writes.find(([key]) => key === 'instances');
check(firstWrite !== undefined, 'save wrote no instances');
check(firstWrite?.[1]?.[0]?.name === 'lab' && firstWrite?.[1]?.[0]?.sshHost === '10.0.0.11', `saved entry ${JSON.stringify(firstWrite?.[1]?.[0])}`);
check(firstWrite?.[1]?.[0]?.sshUser === 'root' && firstWrite?.[1]?.[0]?.sshPort === 22, 'defaults not applied to the entry');

/* 3. validation: a duplicate name is refused and nothing is written. */
const before = writes.length;
await click('Add host');
await typeInto(0, 'lab');
await typeInto(1, '10.0.0.12');
await click('Save');
check(writes.length === before, 'duplicate name was written');
check(texts().includes('The name lab is already taken.'), 'duplicate error not shown');

/* 4. a second host, then make it default. */
await typeInto(0, 'office');
await typeInto(1, 'office-pve');
await typeInto(3, '2222');
await click('Save');
check(value.instances.length === 2, `expected 2 instances, got ${value.instances?.length}`);
check(value.instances[1].sshPort === 2222, `port not parsed: ${value.instances[1].sshPort}`);
await click('Make default');
check(value.defaultInstance === 'office', `default not written: ${value.defaultInstance}`);

/* 5. remove a host: the first click arms, the second removes. */
await click('Remove');
check(value.instances.length === 2, 'remove happened on the first click');
await click('Click again to remove');
check(value.instances.length === 1 && value.instances[0].name === 'office', `remove result ${JSON.stringify(value.instances)}`);
check(value.defaultInstance === 'office', `default after removing the default host: ${value.defaultInstance}`);

/* 6. edit keeps the entry editable: rename lab to lab2. */
await click('Edit');
await typeInto(0, 'lab2');
await click('Save');
check(value.instances[0].name === 'lab2', `rename failed: ${JSON.stringify(value.instances)}`);
check(value.defaultInstance === 'lab2', `default after renaming the default host: ${value.defaultInstance}`);

console.log(JSON.stringify({ problems, writes: writes.map(([key, val]) => [key, Array.isArray(val) ? val.map((entry) => entry.name) : val]) }, null, 2));
process.exit(problems.length === 0 ? 0 : 1);
