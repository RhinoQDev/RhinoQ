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
