import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RhinoQProcessorPackError,
  createRhinoQProcessorPack,
  createRhinoQSharpProcessorPack,
  listRhinoQProcessorPackCatalog,
} from '../dist/index.js';

const context = (overrides = {}) => ({ signal: new AbortController().signal, ...overrides });
const ready = { schemaVersion: 1, name: 'images', version: 1, ready: true, checkedAt: '2026-08-14T00:00:00.000Z', requirements: [], missing: [], warnings: [] };

test('processor catalog distinguishes the bounded FFmpeg adapter from provider-owned packs', () => {
  const catalog = listRhinoQProcessorPackCatalog();
  assert.equal(catalog.find((item) => item.name === 'ffmpeg').status, 'available');
  assert.equal(catalog.find((item) => item.name === 'sharp').status, 'provider-package-required');
  assert.ok(catalog.every((item) => item.boundary === 'application-owned adapter'));
});

test('processor pack checks readiness, workspace and emits bounded metrics', async () => {
  const metrics = [];
  let processed = 0;
  const pack = createRhinoQProcessorPack({
    name: 'images', requiresWorkspace: true, inspect: () => ready,
    process: (input, received) => { processed += 1; received.metric?.('custom_total', input); return input * 2; },
  });

  await assert.rejects(() => pack.run(2, context()), (error) => error instanceof RhinoQProcessorPackError && error.errorClass === 'capacity');
  const result = await pack.run(2, context({ workspace: {}, metric(name, by) { metrics.push([name, by]); } }));
  assert.equal(result, 4);
  assert.equal(processed, 1);
  assert.equal(pack.module.descriptor.namespace, 'processor');
  assert.equal(pack.module.state(), 'validated');
  assert.deepEqual(metrics, [['rhinoq_processor_pack_started_total', undefined], ['custom_total', 2], ['rhinoq_processor_pack_completed_total', undefined]]);
});

test('processor pack refuses an unready dependency and preserves the primary failure', async () => {
  const notReady = { ...ready, name: 'media', ready: false, missing: ['ffmpeg binary'] };
  const dependency = createRhinoQProcessorPack({ name: 'media', inspect: () => notReady, process: () => 'never' });
  await assert.rejects(() => dependency.run({}, context()), (error) => error instanceof RhinoQProcessorPackError && error.errorClass === 'dependency' && /ffmpeg binary/.test(error.message));

  const cleanupErrors = [];
  const failing = createRhinoQProcessorPack({
    name: 'failing', inspect: () => ({ ...ready, name: 'failing' }),
    process: () => { throw new Error('primary failure'); },
    cleanup: () => { cleanupErrors.push(true); throw new Error('cleanup failure'); },
  });
  await assert.rejects(() => failing.run({}, context()), (error) => error instanceof RhinoQProcessorPackError && error.errorClass === 'unknown' && /processor pack failing failed/.test(error.message));
  assert.deepEqual(cleanupErrors, [true]);
});

test('processor pack cancellation is fail-closed', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  const pack = createRhinoQProcessorPack({ name: 'cancelled', inspect: () => ({ ...ready, name: 'cancelled' }), process: () => 'never' });
  await assert.rejects(() => pack.run({}, { signal: controller.signal }), (error) => error instanceof RhinoQProcessorPackError && error.errorClass === 'cancelled');
});

test('Sharp processor pack uses an injected provider runtime and bounded Task output', async () => {
  const calls = [];
  const pack = createRhinoQSharpProcessorPack({
    version: '0.33.0',
    available: () => true,
    metadata: (inputPath) => ({ inputPath, width: 320, height: 180 }),
    resize: (inputPath, outputPath, options) => { calls.push([inputPath, outputPath, options]); },
  });
  const readiness = await pack.inspect();
  assert.equal(readiness.ready, true);
  const metadata = await pack.run({ operation: 'metadata', inputPath: '/tmp/input.jpg' }, context({ workspace: {} }));
  assert.equal(metadata.width, 320);
  const output = await pack.run({ operation: 'resize', inputPath: '/tmp/input.jpg', outputPath: '/tmp/output.webp', resize: { width: 640, format: 'webp' } }, context({
    workspace: {},
    output: { file: async (path, options) => ({ id: 'artifact-1', taskId: 'task-1', executionId: 'execution-1', name: path.split('/').pop(), contentType: options.contentType }) },
  }));
  assert.equal(output.contentType, 'image/webp');
  assert.deepEqual(calls, [['/tmp/input.jpg', '/tmp/output.webp', { width: 640, format: 'webp' }]]);
});

test('Sharp processor pack stays provider-gated when runtime is unavailable', async () => {
  const pack = createRhinoQSharpProcessorPack({ available: () => false, metadata: () => ({}), resize: () => {} });
  const readiness = await pack.inspect();
  assert.equal(readiness.ready, false);
  await assert.rejects(() => pack.run({ operation: 'metadata', inputPath: '/tmp/input.jpg' }, context({ workspace: {} })), (error) => error instanceof RhinoQProcessorPackError && error.errorClass === 'dependency');
});
