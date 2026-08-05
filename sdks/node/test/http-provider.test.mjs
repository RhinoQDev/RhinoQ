import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HttpProviderError,
  httpProviderAdapter,
} from '../dist/index.js';

test('HTTP provider adapter injects the ledger key and preserves provider callbacks', async () => {
  let received;
  const adapter = httpProviderAdapter({
    request: (key) => ({
      input: 'https://provider.test/refunds',
      init: { method: 'POST', headers: { Authorization: 'Bearer test' }, body: JSON.stringify({ key }) },
    }),
    parse: async (response) => ({ id: (await response.json()).id, status: 'accepted' }),
    confirm: async () => ({ decision: 'confirmed', evidence: 'refund_1:succeeded' }),
    providerId: (result) => result.id,
    evidence: (result) => `${result.id}:${result.status}`,
    fetch: async (input, init) => {
      received = { input: String(input), init };
      return Response.json({ id: 'refund_1' }, { status: 202 });
    },
  });

  const result = await adapter.execute('ledger-key-1');
  assert.equal(result.id, 'refund_1');
  assert.equal(received.input, 'https://provider.test/refunds');
  assert.equal(received.init.headers.get('Idempotency-Key'), 'ledger-key-1');
  assert.equal(received.init.headers.get('Authorization'), 'Bearer test');
  assert.deepEqual(await adapter.confirm({}), { decision: 'confirmed', evidence: 'refund_1:succeeded' });
  assert.equal(adapter.providerId(result), 'refund_1');
  assert.equal(adapter.evidence(result), 'refund_1:accepted');
});

test('HTTP provider adapter refuses a caller-supplied key that disagrees with the ledger key', async () => {
  const adapter = httpProviderAdapter({
    request: () => ({ input: 'https://provider.test/mutate', init: { headers: { 'Idempotency-Key': 'wrong' } } }),
    parse: () => ({ ok: true }),
    confirm: async () => ({ decision: 'unknown' }),
    fetch: async () => Response.json({ ok: true }),
  });

  await assert.rejects(() => adapter.execute('ledger-key-1'), /conflicting Idempotency-Key/);
});

test('HTTP provider adapter keeps non-2xx responses fail-closed', async () => {
  const adapter = httpProviderAdapter({
    request: () => ({ input: 'https://provider.test/mutate' }),
    parse: () => ({ ok: true }),
    confirm: async () => ({ decision: 'unknown', reason: 'read-back unavailable' }),
    fetch: async () => new Response('provider timed out', { status: 504 }),
  });

  await assert.rejects(
    () => adapter.execute('ledger-key-1'),
    (error) => error instanceof HttpProviderError && error.status === 504 && error.body === 'provider timed out',
  );
});
