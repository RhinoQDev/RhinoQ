import assert from 'node:assert/strict';
import test from 'node:test';
import { createWaitpointCapabilityHandler } from '../dist/index.js';

test('capability handler scopes webhook resolution and derives stable resolution identity from nonce', async () => {
  const seen = [];
  const handler = createWaitpointCapabilityHandler({
    tasks: {
      async getTaskWaitpoint(id, ownerId, tenantId) { assert.equal(id, 'wp-1'); assert.equal(ownerId, 'owner-1'); assert.equal(tenantId, 'tenant-a'); return { id, taskId: 'task-1' }; },
      async resolveTaskWaitpoint(id, ownerId, request, tenantId) { seen.push({ id, ownerId, tenantId, request }); return { id, taskId: 'task-1', state: 'resolved' }; },
    },
    async verify(token, action) { assert.equal(token, 'signed'); assert.equal(action, 'resolve'); return { schemaVersion: 2, waitpointId: 'wp-1', taskId: 'task-1', tenantId: 'tenant-a', ownerId: 'owner-1', action, expiresAt: 2_000, nonce: 'nonce-1' }; },
  });
  const response = await handler(new Request('http://app.test/waitpoint', { method: 'POST', headers: { authorization: 'Bearer signed', 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1, resolution: { delivered: true } }) }));
  assert.equal(response.status, 200); assert.equal(seen[0].request.resolutionId, 'nonce-1');
});

test('capability handler rejects legacy claims before touching the Task store', async () => {
  let touched = false;
  const handler = createWaitpointCapabilityHandler({
    tasks: {
      async getTaskWaitpoint() { touched = true; throw new Error('store must not be touched'); },
      async resolveTaskWaitpoint() { touched = true; throw new Error('store must not be touched'); },
    },
    async verify() {
      return { schemaVersion: 1, waitpointId: 'wp-1', taskId: 'task-1', ownerId: 'owner-1', action: 'resolve', expiresAt: 2_000, nonce: 'legacy' };
    },
  });
  const response = await handler(new Request('http://app.test/waitpoint', {
    method: 'POST', headers: { authorization: 'Bearer legacy', 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 1, resolution: { delivered: true } }),
  }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { code: 'RHINOQ_INVALID_CAPABILITY' });
  assert.equal(touched, false);
});
