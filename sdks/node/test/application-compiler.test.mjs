import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createManualRuntimeAdapter,
  defineRhinoQApplication,
  defineRhinoQExecutionProfile,
  compileRhinoQPlan,
} from '../dist/index.js';

test('application compiler applies one profile and emits a stable Task manifest', () => {
  const adapter = createManualRuntimeAdapter('manual', 'reports');
  const application = defineRhinoQApplication({
    profile: defineRhinoQExecutionProfile({ name: 'reports', adapters: [adapter] }),
    tasks: (task) => ({
      exportReport: task({
        name: 'report.export',
        retry: { mode: 'runtime', maxAttempts: 3 },
        run: async ({ reportId }) => ({ ref: `${reportId}.pdf` }),
      }),
      refreshCache: task({ name: 'cache.refresh', run: async () => undefined }),
      resizeImages: task.batch({ name: 'image.resize', maxItems: 50, run: async (input) => input }),
    }),
  });

  assert.deepEqual(application.manifest(), {
    schemaVersion: 1,
    profile: 'reports',
    tasks: [
      { key: 'exportReport', name: 'report.export', version: 1, adapter: 'manual', runtime: 'manual', scope: 'reports', retry: { mode: 'runtime', maxAttempts: 3 }, externalEffect: false },
      { key: 'refreshCache', name: 'cache.refresh', version: 1, adapter: 'manual', runtime: 'manual', scope: 'reports', retry: { mode: 'never' }, externalEffect: false },
      { key: 'resizeImages', name: 'image.resize', version: 1, adapter: 'manual', runtime: 'manual', scope: 'reports', retry: { mode: 'never' }, externalEffect: false, batch: { maxItems: 50 } },
    ],
  });
  assert.ok(Object.isFrozen(application.definitions));
  assert.ok(Object.isFrozen(application.manifest().tasks));
});

test('application compiler exposes one deterministic canonical plan without changing the manifest contract', () => {
  const adapter = createManualRuntimeAdapter('manual', 'reports');
  const create = () => defineRhinoQApplication({
    profile: { name: 'reports', adapters: [adapter] },
    tasks: (rhinoq) => ({
      exportReport: rhinoq.task('report.export', async (input) => input, {
        dataPath: { payloadBytes: 1024 },
      }),
      resizeImages: rhinoq.task('image.resize', async (input) => input, {
        resources: { workspaceBytes: 1024, codec: 'png' },
        dataPath: { payloadBytes: 1024, diskFreeBytes: 2048, provider: { codecs: ['png'] } },
      }),
    }),
  });
  const first = create().plan();
  const second = create().plan();
  assert.equal(first.kind, 'rhinoq-plan');
  assert.equal(first.status, 'ready');
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.capabilities, ['task']);
  assert.deepEqual(first.requirements, ['adapter:manual', 'codec:png', 'output:checksum', 'runtime:manual', 'scope:reports', 'workspace:1024']);
  assert.match(first.fingerprint, /^fnv1a32:[0-9a-f]{8}$/);
  assert.equal(compileRhinoQPlan(JSON.parse(JSON.stringify(first))).fingerprint, first.fingerprint);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.tasks));
});

test('application compiler rejects duplicate names, unknown adapters and unsafe effects', () => {
  const adapter = createManualRuntimeAdapter('manual', 'application');
  const profile = { name: 'default', adapters: [adapter] };
  assert.throws(() => defineRhinoQApplication({ profile, tasks: (task) => ({
    first: task({ name: 'same', run: async () => undefined }),
    second: task({ name: 'same', run: async () => undefined }),
  }) }), /duplicate Task name/);
  assert.throws(() => defineRhinoQApplication({ profile, tasks: (task) => ({
    wrong: task({ name: 'wrong', adapter: 'missing', run: async () => undefined }),
  }) }), /unregistered adapter/);
  assert.throws(() => defineRhinoQApplication({ profile, tasks: (task) => ({
    refund: task({ name: 'payment.refund', externalEffect: true, run: async () => undefined }),
  }) }), /explicit idempotency and confirmation policy/);
});

test('application compiler binds every declaration to the started application', async () => {
  const adapter = createManualRuntimeAdapter('manual', 'reports');
  const compiler = defineRhinoQApplication({
    profile: { name: 'reports', adapters: [adapter] },
    tasks: (task) => ({ exportReport: task({ name: 'report.export', run: async (input) => input }) }),
  });
  const started = await compiler.start({
    pool: { async query() { throw new Error('profile was declared installed for this composition test'); } },
    tasks: {},
    ownerFromNodeRequest: () => 'owner-a',
  });
  assert.equal(started.tasks.exportReport.name, 'report.export');
  assert.equal(typeof started.tasks.exportReport.workerHandler(), 'function');
  assert.deepEqual(Object.keys(started.workerHandlers()), ['report.export']);
  const routed = await started.workerHandler()({
    data: { taskName: 'report.export', definitionVersion: 1, taskId: 'task-1', executionId: 'execution-1', payload: { reportId: '42' } },
  });
  assert.deepEqual(routed, { reportId: '42' });
  await assert.rejects(() => started.workerHandler()({ data: { taskName: 'unknown' } }), /refuses unregistered Task/);
  assert.equal(started.http, undefined);
  assert.equal(typeof started.mount, 'function');

  const stop = new AbortController();
  let receivedHandler;
  let closed = 0;
  const running = started.runWorker({
    signal: stop.signal, processSignals: false,
    create(handler) { receivedHandler = handler; return { async close() { closed += 1; } }; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof receivedHandler, 'function');
  stop.abort();
  await running;
  assert.equal(closed, 1);
  await started.close();
});

test('short capability factories compile markers and safe data-path plans', () => {
  const adapter = createManualRuntimeAdapter('manual', 'reports');
  const compiler = defineRhinoQApplication({
    profile: { name: 'reports', adapters: [adapter] },
    tasks: (rhinoq) => ({
      exportReport: rhinoq.task('report.export', async (input) => input),
      resizeImages: rhinoq.batch('image.resize', async (input) => input, { maxItems: 20 }),
      webVideo: rhinoq.media('video.web', async (input) => input),
      capturePayment: rhinoq.effect('payment.capture', async (input) => input, {
        effect: { idempotency: 'provider', confirmation: 'readback' },
      }),
    }),
  });

  const entries = compiler.manifest().tasks;
  assert.deepEqual(entries.map((entry) => [entry.name, entry.capability]), [
    ['report.export', 'task'], ['image.resize', 'batch'], ['video.web', 'media'], ['payment.capture', 'effect'],
  ]);
  assert.equal(entries[2].dataPath.input.transport, 'private-reference');
  assert.equal(entries[2].dataPath.output.transport, 'stream-to-storage');
  assert.equal(entries[3].externalEffect, true);
});

test('schedule factory compiles resource and occurrence metadata into the capsule', () => {
  const adapter = createManualRuntimeAdapter('manual', 'reports');
  const compiler = defineRhinoQApplication({
    profile: { name: 'reports', adapters: [adapter] },
    tasks: (rhinoq) => ({
      nightly: rhinoq.schedule('report.nightly', async () => undefined, {
        schedule: { expression: '0 2 * * *', timezone: 'Asia/Ho_Chi_Minh' },
        resources: { timeoutMs: 30_000, workspaceBytes: 1024, minDiskFreeBytes: 2048, gpu: 'none', region: 'ap-southeast-1', codec: 'pdf' },
      }),
    }),
  });
  const entry = compiler.manifest().tasks[0];
  assert.equal(entry.capability, 'schedule');
  assert.deepEqual(entry.schedule, { expression: '0 2 * * *', timezone: 'Asia/Ho_Chi_Minh' });
  assert.equal(entry.resources.codec, 'pdf');
  assert.equal(entry.dataPath.admission.workspaceBytes, 1024);
  assert.equal(entry.dataPath.admission.minDiskFreeBytes, 2048);
  assert.equal(entry.dataPath.admission.codec, 'pdf');
  assert.throws(() => defineRhinoQApplication({
    profile: { name: 'reports', adapters: [adapter] },
    tasks: (task) => ({ broken: task.schedule('broken', async () => undefined, { schedule: { expression: '' } }) }),
  }), /schedule expression is required/);
});
