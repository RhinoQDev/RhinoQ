import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { sha256Blob } from '../dist/browser.js';

test('browser Blob checksum is correct across bounded chunk boundaries', async () => {
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 17);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const progress = [];
  const actual = await sha256Blob(new Blob([bytes]), { chunkBytes: 1024 * 1024, onProgress: (done) => progress.push(done) });
  assert.equal(actual, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(progress.at(-1), bytes.length);
});

test('browser Blob checksum honors cancellation before reading', async () => {
  const controller = new AbortController(); controller.abort(new Error('stop'));
  await assert.rejects(() => sha256Blob(new Blob(['abc']), { signal: controller.signal }), /stop/);
});
