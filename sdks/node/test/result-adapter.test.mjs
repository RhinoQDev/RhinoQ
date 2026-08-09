import assert from 'node:assert/strict';
import test from 'node:test';

import { signedResult } from '../dist/index.js';

test('signedResult resolves with owner context and requires HTTPS', async () => {
  const resolve = signedResult({ resolve(reference, owner) { assert.equal(reference, 'object/key'); assert.equal(owner, 'owner-a'); return 'https://download.test/file'; } });
  assert.equal((await resolve({ reference: 'object/key' }, new Request('https://app.test/tasks/1/result'), 'owner-a')).url, 'https://download.test/file');
  const unsafe = signedResult({ resolve: () => 'http://download.test/file' });
  await assert.rejects(unsafe({ reference: 'x' }, new Request('https://app.test/tasks/1/result'), 'owner-a'), /HTTPS/);
});
