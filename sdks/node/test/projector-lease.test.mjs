import assert from 'node:assert/strict';
import test from 'node:test';

import { BullMQTaskBridge, PostgresProjectorLease } from '../dist/index.js';

test('PostgresProjectorLease holds a session lock until release', async () => {
  const calls = [];
  let released = false;
  const connection = {
    async query(sql, values) {
      calls.push([sql, values]);
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      return { rows: [{ pg_advisory_unlock: true }] };
    },
    release() { released = true; },
  };
  let connects = 0;
  const lease = new PostgresProjectorLease({
    async connect() { connects += 1; return connection; },
  }, 'reports');

  assert.equal(await lease.acquire(), true);
  assert.equal(await lease.acquire(), true, 'the same owner is re-entrant');
  assert.equal(connects, 1);
  await lease.release();

  assert.equal(released, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /pg_try_advisory_lock/);
  assert.match(calls[1][0], /pg_advisory_unlock/);
});

test('a projector that does not get the lock returns false and releases its connection', async () => {
  let released = false;
  const lease = new PostgresProjectorLease({
    async connect() {
      return {
        async query() { return { rows: [{ acquired: false }] }; },
        release() { released = true; },
      };
    },
  }, 'reports');

  assert.equal(await lease.acquire(), false);
  assert.equal(released, true);
  await lease.release();
});

test('a bridge with a lease does not subscribe when it is not the owner', async () => {
  const subscribed = [];
  const bridge = new BullMQTaskBridge({
    client: {},
    events: {
      on(name) { subscribed.push(name); },
      off() {},
    },
    runtimeScope: `lease-${Math.random().toString(36).slice(2)}`,
    terminalProjection: 'execution-only',
    projectorLease: {
      async acquire() { return false; },
      async release() {},
    },
  });
  try {
    await assert.rejects(bridge.start(), /could not acquire projector ownership/);
    assert.deepEqual(subscribed, []);
  } finally {
    bridge.close();
  }
});

// The lock lives in a database session. A failover, a restart or a
// pg_terminate_backend releases it server-side while this process still holds
// a connection object, so without a check acquire() keeps answering true from
// its cached field and two projectors run believing each is the only one.
test('a dead session is reported as a lost lease, not as ownership', async () => {
  let released = false;
  let alive = true;
  const lease = new PostgresProjectorLease({
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
          if (!alive) throw new Error('terminating connection due to administrator command');
          return { rows: [{ ok: 1 }] };
        },
        release() { released = true; },
      };
    },
  }, 'reports');

  assert.equal(await lease.acquire(), true);
  assert.equal(await lease.verify(), true, 'a live session still owns the lock');

  alive = false;
  assert.equal(await lease.verify(), false, 'a dead session cannot still own it');
  assert.equal(released, true, 'the broken connection is not returned to the pool');
  assert.equal(await lease.verify(), false, 'and it stays lost');
});

test('a checked-out pg client error is consumed and immediately invalidates the lease', async () => {
  const listeners = new Set();
  const releases = [];
  const connection = {
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      return { rows: [{ ok: 1 }] };
    },
    on(event, listener) { if (event === 'error') listeners.add(listener); },
    removeListener(event, listener) { if (event === 'error') listeners.delete(listener); },
    release(destroy) { releases.push(destroy); },
  };
  const lease = new PostgresProjectorLease({ async connect() { return connection; } }, 'reports');

  assert.equal(await lease.acquire(), true);
  assert.equal(listeners.size, 1, 'the checked-out client has an error listener');
  for (const listener of listeners) listener(Object.assign(new Error('terminated'), { code: '57P01' }));

  assert.equal(await lease.verify(), false, 'the asynchronous client error invalidates ownership');
  assert.deepEqual(releases, [true], 'the broken session is destroyed, not returned to the pool');
  await lease.release();
  assert.deepEqual(releases, [true], 'cleanup is idempotent after the error event');
});

test('a bridge stops projecting when it loses the lease', async () => {
  const listeners = new Set();
  let held = true;
  const lost = [];
  const warnings = [];
  const bridge = new BullMQTaskBridge({
    client: {},
    events: {
      on(name) { listeners.add(name); },
      off(name) { listeners.delete(name); },
    },
    runtimeScope: `lease-${Math.random().toString(36).slice(2)}`,
    terminalProjection: 'execution-only',
    leaseVerifyIntervalMs: 5,
    onWarning: (warning) => warnings.push(warning),
    onLeaseLost: (scope) => lost.push(scope),
    projectorLease: {
      async acquire() { return true; },
      async release() {},
      async verify() { return held; },
    },
  });

  try {
    await bridge.start();
    assert.equal(listeners.size > 0, true, 'the owner subscribes');

    held = false;
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(listeners.size, 0, 'a bridge that lost the lease must unsubscribe');
    assert.equal(lost.length, 1, 'onLeaseLost fires exactly once');
    assert.match(warnings.join('\n'), /lost projector ownership/);
    assert.match(warnings.join('\n'), /TaskReconciler/);
  } finally {
    bridge.close();
  }
});

test('a lease without verify() is called out rather than trusted', async () => {
  const warnings = [];
  const bridge = new BullMQTaskBridge({
    client: {},
    events: { on() {}, off() {} },
    runtimeScope: `lease-${Math.random().toString(36).slice(2)}`,
    terminalProjection: 'execution-only',
    onWarning: (warning) => warnings.push(warning),
    projectorLease: {
      async acquire() { return true; },
      async release() {},
    },
  });
  try {
    await bridge.start();
    assert.match(warnings.join('\n'), /does not implement verify\(\)/);
  } finally {
    bridge.close();
  }
});
