import assert from 'node:assert/strict';
import test from 'node:test';
import { createWaitpointCapabilityHandler } from '../dist/index.js';

test('capability handler scopes webhook resolution and derives stable resolution identity from nonce', async () => {
  const seen = [];
  const handler = createWaitpointCapabilityHandler({
    tasks: {
      async getTaskWaitpoint(id, ownerId) { assert.equal(id, 'wp-1'); assert.equal(ownerId, 'owner-1'); return { id, taskId: 'task-1' }; },
      async resolveTaskWaitpoint(id, ownerId, request) { seen.push({ id, ownerId, request }); return { id, taskId: 'task-1', state: 'resolved' }; },
    },
    async verify(token, action) { assert.equal(token, 'signed'); assert.equal(action, 'resolve'); return { schemaVersion: 1, waitpointId: 'wp-1', taskId: 'task-1', ownerId: 'owner-1', action, expiresAt: 2_000, nonce: 'nonce-1' }; },
  });
  const response = await handler(new Request('http://app.test/waitpoint', { method: 'POST', headers: { authorization: 'Bearer signed', 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1, resolution: { delivered: true } }) }));
  assert.equal(response.status, 200); assert.equal(seen[0].request.resolutionId, 'nonce-1');
});
