import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresTaskClient } from '../dist/index.js';

function fakePool(claims) {
  const calls = [];
  const connection = {
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes('claim_item_effect')) {
        return { rows: [{ claimed: claims.shift() ?? false }] };
      }
      return { rows: [] };
    },
    release() {
      calls.push({ text: 'RELEASE' });
    },
  };
  return {
    calls,
    async query() {
      throw new Error('onceForItem must use the checked-out transaction');
    },
    async connect() {
      return connection;
    },
  };
}

test('onceForItem commits the claim with the application write and skips a repeat', async () => {
  const pool = fakePool([true, false]);
  const tasks = new PostgresTaskClient(pool);
  let runs = 0;

  const first = await tasks.onceForItem('execution-1', 'deduct-credits', async (transaction) => {
    runs += 1;
    await transaction.query('INSERT INTO credit_logs (item_id) VALUES ($1)', ['item-1']);
    return 'ledger-row-1';
  });
  const second = await tasks.onceForItem('execution-1', 'deduct-credits', async () => {
    runs += 1;
    return 'should-not-run';
  });

  assert.deepEqual(first, { executed: true, value: 'ledger-row-1' });
  assert.deepEqual(second, { executed: false });
  assert.equal(runs, 1);
  // The lock_timeout is LOCAL and comes before the claim, so a transaction
  // that cannot get the item lock fails fast instead of holding a pooled
  // connection for as long as the other holder takes.
  assert.deepEqual(
    pool.calls.map((call) => call.text),
    [
      'BEGIN',
      "SELECT set_config('lock_timeout', $1, true)",
      'SELECT rhinoq_task.claim_item_effect($1, $2) AS claimed',
      'INSERT INTO credit_logs (item_id) VALUES ($1)',
      'COMMIT',
      'RELEASE',
      'BEGIN',
      "SELECT set_config('lock_timeout', $1, true)",
      'SELECT rhinoq_task.claim_item_effect($1, $2) AS claimed',
      'COMMIT',
      'RELEASE',
    ],
  );
});

test('onceForItem bounds the wait for the item lock', async () => {
  const pool = fakePool([true]);
  const tasks = new PostgresTaskClient(pool, { lockTimeoutMs: 250 });

  await tasks.onceForItem('execution-1', 'deduct-credits', async () => 'done');

  const timeout = pool.calls.find((call) => call.text.includes('lock_timeout'));
  assert.ok(timeout, 'the transaction must set a lock timeout before claiming');
  assert.deepEqual(timeout.values, ['250ms']);
});

test('onceForItem refuses a lock timeout that cannot bound anything', async () => {
  for (const lockTimeoutMs of [0, -1, 1.5]) {
    assert.throws(
      () => new PostgresTaskClient(fakePool([]), { lockTimeoutMs }),
      RangeError,
      `lockTimeoutMs ${lockTimeoutMs} must be refused at construction`,
    );
  }
});

test('onceForItem rolls the claim back when the business callback fails', async () => {
  const pool = fakePool([true, true]);
  const tasks = new PostgresTaskClient(pool);

  await assert.rejects(
    tasks.onceForItem('execution-2', 'write-result', async () => {
      throw new Error('business write failed');
    }),
    /business write failed/,
  );
  const retry = await tasks.onceForItem('execution-2', 'write-result', async () => 'retried');

  assert.deepEqual(retry, { executed: true, value: 'retried' });
  assert.deepEqual(
    pool.calls.map((call) => call.text),
    [
      'BEGIN',
      "SELECT set_config('lock_timeout', $1, true)",
      'SELECT rhinoq_task.claim_item_effect($1, $2) AS claimed',
      'ROLLBACK',
      'RELEASE',
      'BEGIN',
      "SELECT set_config('lock_timeout', $1, true)",
      'SELECT rhinoq_task.claim_item_effect($1, $2) AS claimed',
      'COMMIT',
      'RELEASE',
    ],
  );
});
