import assert from 'node:assert/strict';
import test from 'node:test';

import { objectTransferProviderAdapter } from '../dist/index.js';

// "Fetch from a CDN, put it in S3" had no reference adapter. Stripe and
// provisioning both answer "did it happen?" from a status field the provider
// maintains; a transfer has none. The only evidence is the destination, and
// reading it back is where the expensive mistakes are.

const operation = {
  id: 'op-1', provider: 'storage', operation: 'transfer',
  idempotencyKey: 'asset-4471', confirmation: 'readback', retryPolicy: 'when-not-happened',
  state: 'accepted', version: 1, createdAt: '2026-08-03T16:00:00Z', updatedAt: '2026-08-03T16:00:00Z',
};

test('an empty destination key is not_happened, so a retry is safe', async () => {
  const adapter = objectTransferProviderAdapter({
    async transfer() { throw new Error('not called'); },
    async head() { return undefined; },
  });

  assert.deepEqual(await adapter.confirm(operation), {
    decision: 'not_happened',
    reason: 'the destination key is empty, so nothing was transferred',
  });
});

test('a matching etag confirms the transfer', async () => {
  const adapter = objectTransferProviderAdapter({
    async transfer() { throw new Error('not called'); },
    async head() { return { key: 'assets/4471.mp4', etag: '"D41D8CD98F00B204E9800998ECF8427E"', size: 1024 }; },
    async expected() { return { etag: 'd41d8cd98f00b204e9800998ecf8427e' }; },
  });

  const result = await adapter.confirm(operation);
  assert.equal(result.decision, 'confirmed');
  assert.match(result.evidence, /assets\/4471\.mp4/);
});

// S3 quotes etags and appends a part count for multipart uploads. Comparing
// raw strings would report every large file as a mismatch — and a mismatch
// here means "do not retry", so it would strand real work.
test('etag comparison ignores quoting and case', async () => {
  const adapter = objectTransferProviderAdapter({
    async transfer() { throw new Error('not called'); },
    async head() { return { key: 'k', etag: '"abc123-4"' }; },
    async expected() { return { etag: 'ABC123-4' }; },
  });

  assert.equal((await adapter.confirm(operation)).decision, 'confirmed');
});

// This is the one that costs money if it is wrong. Retrying would overwrite an
// object that is already there, and an unversioned bucket cannot undo it.
test('a different object at the destination fails instead of retrying', async () => {
  const adapter = objectTransferProviderAdapter({
    async transfer() { throw new Error('not called'); },
    async head() { return { key: 'assets/4471.mp4', etag: 'aaaa' }; },
    async expected() { return { etag: 'bbbb' }; },
  });

  const result = await adapter.confirm(operation);
  assert.equal(result.decision, 'failed');
  assert.match(result.reason, /different object/);
  assert.match(result.reason, /etag aaaa ≠ bbbb/);
  assert.match(result.reason, /unversioned bucket cannot undo/);
});

test('a truncated upload is caught by size when no etag is available', async () => {
  const adapter = objectTransferProviderAdapter({
    async transfer() { throw new Error('not called'); },
    async head() { return { key: 'k', size: 512 }; },
    async expected() { return { size: 4096 }; },
  });

  const result = await adapter.confirm(operation);
  assert.equal(result.decision, 'failed');
  assert.match(result.reason, /size 512 ≠ 4096/);
});

// "Something exists at this key" is not proof that this operation put it
// there. Treating it as confirmation is how a failed transfer is recorded as a
// success because last week's file sits at the same path.
test('an object with nothing to compare against stays unknown, not confirmed', async () => {
  const adapter = objectTransferProviderAdapter({
    async transfer() { throw new Error('not called'); },
    async head() { return { key: 'assets/4471.mp4', size: 1024 }; },
  });

  const result = await adapter.confirm(operation);
  assert.equal(result.decision, 'unknown');
  assert.match(result.reason, /nothing identifies it as this transfer/);
  assert.match(result.reason, /expected\(\)/);
  assert.match(result.evidence, /size=1024/);
});

test('an expectation with no comparable field is also unknown', async () => {
  const adapter = objectTransferProviderAdapter({
    async transfer() { throw new Error('not called'); },
    async head() { return { key: 'k', size: 1024 }; },
    // The source could be interrogated but only produced an etag; the
    // destination only reported a size. Nothing lines up.
    async expected() { return { etag: 'aaaa' }; },
  });

  assert.equal((await adapter.confirm(operation)).decision, 'unknown');
});

// A versionId is unique, so it wins over an etag two different objects could
// theoretically share.
test('a versionId is compared before the weaker identities', async () => {
  const adapter = objectTransferProviderAdapter({
    async transfer() { throw new Error('not called'); },
    async head() { return { key: 'k', versionId: 'v2', etag: 'same', size: 10 }; },
    async expected() { return { versionId: 'v1', etag: 'same', size: 10 }; },
  });

  const result = await adapter.confirm(operation);
  assert.equal(result.decision, 'failed');
  assert.match(result.reason, /versionId v2 ≠ v1/);
});

test('the operation id prefers the immutable version over the mutable key', async () => {
  const adapter = objectTransferProviderAdapter({
    async transfer(key) { return { key: `assets/${key}.mp4`, versionId: 'v9', etag: 'e', size: 3 }; },
    async head() { return undefined; },
  });

  const transferred = await adapter.execute('asset-4471');
  assert.equal(adapter.providerId(transferred), 'v9');
  assert.equal(adapter.evidence(transferred), 'assets/asset-4471.mp4 v=v9 etag=e size=3');
  assert.equal(adapter.providerId({ key: 'assets/x.mp4' }), 'assets/x.mp4');
});
