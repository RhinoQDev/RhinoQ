import assert from 'node:assert/strict';
import test from 'node:test';
import { createWaitpointTokenSigner } from '../dist/index.js';

test('waitpoint tokens bind action, identity and expiry', async () => {
  const signer = createWaitpointTokenSigner('0123456789abcdef0123456789abcdef');
  const token = await signer.sign({ waitpointId: 'wp-1', taskId: 'task-1', ownerId: 'owner-1', action: 'resolve', expiresAt: 2_000, nonce: 'nonce-1' });
  const claims = await signer.verify(token, 'resolve', 1_000);
  assert.equal(claims.ownerId, 'owner-1');
  await assert.rejects(() => signer.verify(token, 'read', 1_000), /action/);
  await assert.rejects(() => signer.verify(token, 'resolve', 2_000), /expired/);
  await assert.rejects(() => signer.verify(`${token.slice(0,-1)}x`, 'resolve', 1_000), /signature|invalid/);
});
