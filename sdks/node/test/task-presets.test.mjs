import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rhinoqPresets } from '../dist/index.js';

test('export preset supplies progress and artifact plumbing', async () => {
  const progress = [];
  const preset = rhinoqPresets.exportFile({ name: 'report.export', contentType: 'text/csv', fileName: ({ id }) => `${id}.csv`, generate: ({ id }) => `id\n${id}` });
  const result = await preset.run({ id: '42' }, { taskId: 't', executionId: 'e', progress: (...value) => progress.push(value), artifact: { file: async (_data, options) => ({ id: 'a1', contentType: options.contentType, sizeBytes: 5 }) } });
  assert.equal(result.id, 'a1');
  assert.deepEqual(progress.map((item) => item[0]), [0, 1, 2]);
});

test('external preset fails closed without effect safety', () => {
  assert.throws(() => rhinoqPresets.external({ name: 'email.send', run: async () => undefined }), /explicit idempotency/);
});
