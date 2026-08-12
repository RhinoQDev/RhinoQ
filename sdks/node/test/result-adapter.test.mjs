import assert from 'node:assert/strict';
import test from 'node:test';

import { localResult, proxyResult, s3CompatibleResult, signedResult } from '../dist/index.js';

test('signedResult resolves with owner context and requires HTTPS', async () => {
  const resolve = signedResult({ resolve(reference, owner) { assert.equal(reference, 'object/key'); assert.equal(owner, 'owner-a'); return 'https://download.test/file'; } });
  assert.equal((await resolve({ reference: 'object/key' }, new Request('https://app.test/tasks/1/result'), 'owner-a')).url, 'https://download.test/file');
  const unsafe = signedResult({ resolve: () => 'http://download.test/file' });
  await assert.rejects(unsafe({ reference: 'x' }, new Request('https://app.test/tasks/1/result'), 'owner-a'), /HTTPS/);
});

test('golden result adapters require access context and hide storage references', async () => {
  const local = localResult();
  assert.match((await local({ reference: 'private/key' }, new Request('http://localhost/tasks/1'), 'owner-a', 'tenant-a')).url, /private%2Fkey/);
  await assert.rejects(local({ reference: 'x' }, new Request('https://app.test/tasks/1'), 'owner-a', 'tenant-a'), /development-only/);
  const proxy = proxyResult({ route: ({ ownerId, tenantId }) => `/download/${ownerId}/${tenantId}` });
  assert.equal((await proxy({ reference: 'secret-storage-key' }, new Request('https://app.test/tasks/1'), 'owner-a', 'tenant-a')).url, 'https://app.test/download/owner-a/tenant-a');
  const s3 = s3CompatibleResult({ sign: (_reference, context) => `https://storage.test/${context.tenantId}/signed` });
  assert.equal((await s3({ reference: 'bucket/private' }, new Request('https://app.test/tasks/1'), 'owner-a', 'tenant-a')).url, 'https://storage.test/tenant-a/signed');
  await assert.rejects(s3({ reference: 'x' }, new Request('https://app.test/tasks/1'), '', 'tenant-a'), /ownerId/);
});
