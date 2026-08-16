import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { createWaitpointTokenSigner } from '../dist/index.js';

test('waitpoint tokens bind action, identity and expiry', async () => {
  const secret = randomBytes(32).toString('hex');
  const signer = createWaitpointTokenSigner(secret);
  const token = await signer.sign({ waitpointId: 'wp-1', taskId: 'task-1', tenantId: 'tenant-a', ownerId: 'owner-1', action: 'resolve', expiresAt: 2_000, nonce: 'nonce-1' });
  const claims = await signer.verify(token, 'resolve', 1_000);
  assert.equal(claims.schemaVersion, 2);
  assert.equal(claims.tenantId, 'tenant-a');
  assert.equal(claims.ownerId, 'owner-1');
  await assert.rejects(() => signer.verify(token, 'read', 1_000), /action/);
  await assert.rejects(() => signer.verify(token, 'resolve', 2_000), /expired/);
  await assert.rejects(() => signer.verify(`${token.slice(0,-1)}x`, 'resolve', 1_000), /signature|invalid/);
  const legacyPayload = Buffer.from(JSON.stringify({
    schemaVersion: 1, waitpointId: 'wp-1', taskId: 'task-1', ownerId: 'owner-1',
    action: 'resolve', expiresAt: 2_000, nonce: 'legacy-nonce',
  })).toString('base64url');
  const legacyKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const legacySignature = await crypto.subtle.sign('HMAC', legacyKey, new TextEncoder().encode(legacyPayload));
  const legacyToken = `${legacyPayload}.${Buffer.from(legacySignature).toString('base64url')}`;
  await assert.rejects(() => signer.verify(legacyToken, 'resolve', 1_000), /valid waitpoint token claims/);
});
