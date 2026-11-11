/**
 * Offline checks for the second-confirmation store.
 *
 * The point of the store is that a dangerous operation cannot happen in one
 * call. These checks pin that: no token means no work, a token only works once,
 * and a token issued for another target is refused.
 */
import assert from 'node:assert/strict';
import { ConfirmationStore, confirmationRequired, runGuarded } from '../lib/confirm.js';

const problems = [];
async function check(name, operation) {
  try {
    await operation();
  } catch (error) {
    problems.push(`${name}: ${error?.message ?? error}`);
  }
}

await check('a safe action runs without a token', async () => {
  const store = new ConfirmationStore();
  let ran = 0;
  const value = await runGuarded(store, { args: {}, instance: 'lab', action: 'x', target: 'lab:vm:1', risk: 'safe', summary: '' }, async () => {
    ran += 1;
    return 'done';
  });
  assert.equal(value, 'done');
  assert.equal(ran, 1);
});

await check('a dangerous action performs nothing on the first call', async () => {
  const store = new ConfirmationStore();
  let ran = 0;
  const value = await runGuarded(
    store,
    { args: {}, instance: 'lab', action: 'vm_power:stop', target: 'lab:vm:100', risk: 'danger', summary: 'stop VM 100' },
    async () => {
      ran += 1;
      return 'done';
    },
  );
  assert.equal(ran, 0);
  assert.equal(value.status, 'confirmation-required');
  assert.equal(value.performed, false);
  assert.equal(value.action, 'vm_power:stop');
  assert.equal(value.target, 'lab:vm:100');
  assert.equal(typeof value.confirm, 'string');
  assert.ok(value.confirm.length > 0);
  assert.match(value.instruction, /Nothing was changed/);
});

await check('an irreversible destroy action is not treated as safe', async () => {
  const store = new ConfirmationStore();
  let ran = 0;
  const value = await runGuarded(
    store,
    { args: {}, instance: 'lab', action: 'vm_snapshot:delete', target: 'lab:vm:100:snap1', risk: 'destroy', summary: 'delete snapshot snap1' },
    async () => {
      ran += 1;
      return 'done';
    },
  );
  assert.equal(ran, 0);
  assert.equal(value.status, 'confirmation-required');
  assert.equal(value.performed, false);
  assert.equal(value.risk, 'destroy');
});

await check('the token performs the action exactly once', async () => {
  const store = new ConfirmationStore();
  let ran = 0;
  const spec = (args) => ({
    args,
    instance: 'lab',
    action: 'vm_power:stop',
    target: 'lab:vm:100',
    risk: 'danger',
    summary: 'stop VM 100',
  });
  const first = await runGuarded(store, spec({}), async () => {
    ran += 1;
    return 'done';
  });
  assert.equal(ran, 0);
  const second = await runGuarded(store, spec({ confirm: first.confirm }), async () => {
    ran += 1;
    return 'done';
  });
  assert.equal(second, 'done');
  assert.equal(ran, 1);
  await assert.rejects(
    () =>
      runGuarded(store, spec({ confirm: first.confirm }), async () => {
        ran += 1;
        return 'done';
      }),
    /unknown, expired or already used/,
  );
  assert.equal(ran, 1);
});

await check('a token is bound to its action and target', async () => {
  const store = new ConfirmationStore();
  const first = await runGuarded(
    store,
    { args: {}, instance: 'lab', action: 'vm_power:stop', target: 'lab:vm:100', risk: 'danger', summary: 'stop' },
    async () => 'done',
  );
  await assert.rejects(
    () =>
      runGuarded(
        store,
        { args: { confirm: first.confirm }, instance: 'lab', action: 'vm_power:reset', target: 'lab:vm:100', risk: 'destroy', summary: 'reset' },
        async () => 'done',
      ),
    /issued for vm_power:stop/,
  );
});

await check('an expired token is refused', async () => {
  let now = 1_000;
  const store = new ConfirmationStore({ ttlMs: 500, now: () => now });
  const first = await runGuarded(
    store,
    { args: {}, instance: 'lab', action: 'vm_destroy', target: 'lab:vm:100', risk: 'destroy', summary: 'destroy' },
    async () => 'done',
  );
  now += 1_000;
  await assert.rejects(
    () =>
      runGuarded(
        store,
        { args: { confirm: first.confirm }, instance: 'lab', action: 'vm_destroy', target: 'lab:vm:100', risk: 'destroy', summary: 'destroy' },
        async () => 'done',
      ),
    /unknown, expired or already used/,
  );
});

await check('confirmationRequired carries the token and the deadline', () => {
  const store = new ConfirmationStore({ ttlMs: 60_000, now: () => 5_000 });
  const record = store.issue({ instance: 'lab', action: 'a', target: 'lab:vm:1', summary: 's' });
  const payload = confirmationRequired(record);
  assert.equal(payload.confirm, record.token);
  assert.equal(payload.expiresAt, new Date(65_000).toISOString());
  assert.equal(payload.status, 'confirmation-required');
});

await check('the store keeps only the newest tokens', () => {
  const store = new ConfirmationStore({ limit: 2 });
  const a = store.issue({ instance: 'lab', action: 'a', target: '1', summary: '' });
  store.issue({ instance: 'lab', action: 'b', target: '2', summary: '' });
  store.issue({ instance: 'lab', action: 'c', target: '3', summary: '' });
  assert.equal(store.take(a.token), undefined);
});

if (problems.length > 0) {
  console.error(JSON.stringify({ problems }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ problems: [] }));
}
