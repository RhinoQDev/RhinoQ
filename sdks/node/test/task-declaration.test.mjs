import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineRhinoQTask } from '../dist/index.js';

test('one Task declaration drives stable dispatch identity and the worker handler', async () => {
  const calls = [];
  const integration = {
    async dispatch(adapter, command) {
      calls.push({ adapter, command });
      return { id: command.task.id, type: command.task.type, ownerId: command.task.ownerId,
        state: 'queued', entityVersion: 2, schemaVersion: 1, progress: { completed: 0 },
        hasResult: false, executions: [], createdAt: '2026-08-12T00:00:00Z', updatedAt: '2026-08-12T00:00:00Z' };
    },
  };
  const task = defineRhinoQTask(integration, {
    name: 'report.export', adapter: 'bullmq', runtime: 'bullmq', scope: 'reports',
    retry: { mode: 'runtime', maxAttempts: 3, backoff: { type: 'exponential', delayMs: 1000 } },
    run: async ({ reportId }) => ({ ref: `${reportId}.pdf` }),
    result: (output) => ({ ref: output.ref, mediaType: 'application/pdf' }),
  });
  const snapshot = await task.dispatch({ id: 'report-42', ownerId: 'owner-a', payload: { reportId: '42' } });
  assert.equal(snapshot.state, 'queued');
  assert.equal(calls[0].adapter, 'bullmq');
  assert.equal(calls[0].command.idempotencyKey, 'report-42');
  assert.equal(calls[0].command.executionId, 'report-42:attempt:1');
  assert.deepEqual(calls[0].command.retry, { maxAttempts: 3, backoff: { type: 'exponential', delayMs: 1000 } });
  assert.deepEqual(calls[0].command.payload, {
    taskName: 'report.export', taskId: 'report-42', executionId: 'report-42:attempt:1', definitionVersion: 1,
    retry: { mode: 'runtime', maxAttempts: 3, backoff: { type: 'exponential', delayMs: 1000 } },
    payload: { reportId: '42' },
  });
  const output = await task.execute({ reportId: '42' }, { taskId: 'report-42', executionId: 'one', progress() {} });
  assert.deepEqual(task.resultMetadata(output), { ref: '42.pdf', mediaType: 'application/pdf' });
  const progress = [];
  const workerOutput = await task.workerHandler()({ data: calls[0].command.payload, updateProgress(value) { progress.push(value); } });
  assert.deepEqual(workerOutput, { ref: '42.pdf' });
  assert.deepEqual(progress, []);
  await assert.rejects(() => task.workerHandler()({ data: { ...calls[0].command.payload, taskName: 'other' } }), /refuses an undeclared Task envelope/);
});

test('Task declaration defaults to no retry and refuses undeclared external effects', () => {
  const integration = { async dispatch() { throw new Error('not reached'); } };
  const safe = defineRhinoQTask(integration, {
    name: 'local.compute', adapter: 'manual', runtime: 'manual', scope: 'local', run: async () => undefined,
  });
  assert.deepEqual(safe.retry, { mode: 'never' });
  assert.throws(() => defineRhinoQTask(integration, {
    name: 'payment.refund', adapter: 'manual', runtime: 'manual', scope: 'payments',
    externalEffect: true, run: async () => undefined,
  }), /explicit idempotency and confirmation policy/);
});

test('worker artifact helper uploads, hashes and registers one owner-safe artifact', async () => {
  const uploads = [];
  const registrations = [];
  const task = defineRhinoQTask({ async dispatch() {} }, {
    name: 'report.export', adapter: 'manual', runtime: 'manual', scope: 'reports',
    run: async (_input, context) => context.artifact.file('report body', {
      name: 'report.txt', contentType: 'text/plain', expiresInMs: 60_000,
    }),
  }, { artifacts: {
    storage: { async put(input) { uploads.push(input); return { reference: `storage://${input.id}`, expiresAt: '2026-08-13T01:00:00.000Z' }; } },
    async register(taskId, request) { registrations.push({ taskId, request }); return { schemaVersion: 1, entityVersion: 1, taskId, ...request }; },
  } });
  const result = await task.workerHandler()({ data: {
    taskName: 'report.export', definitionVersion: 1, taskId: 'task-1', executionId: 'execution-1', payload: {},
  } });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].checksumSha256, 'fc54daf6865cec6354a8ada602faade2a408b3acbe4d2357274d21f7cd0cb9e1');
  assert.equal(registrations[0].request.reference, `storage://${result.id}`);
  assert.equal(registrations[0].request.sizeBytes, 11);
  assert.equal(result.name, 'report.txt');
});

test('worker artifact helper streams without buffering and reports byte progress', async () => {
  const chunks = [], registered = [], progress = [];
  const task = defineRhinoQTask({ dispatch() {}, close() {} }, {
    name: 'video.export', adapter: 'manual', runtime: 'manual', scope: 'video',
    run: async (_input, context) => context.artifact.stream((async function* () {
      yield new Uint8Array([1, 2]); yield new Uint8Array([3, 4]);
    })(), { name: 'video.mp4', contentType: 'video/mp4', sizeBytes: 4, reportProgress: true }),
  }, { artifacts: {
    storage: { async put() { throw new Error('buffered path must not run'); }, async putStream(input) { for await (const chunk of input.source) chunks.push(...chunk); return { reference: 's3://bucket/video' }; } },
    async register(_taskId, request) { registered.push(request); return request; },
  } });
  const output = await task.workerHandler()({ data: { taskName: 'video.export', definitionVersion: 1, taskId: 't1', executionId: 'e1', payload: {} }, updateProgress(value) { progress.push(value); } });
  assert.deepEqual(chunks, [1, 2, 3, 4]);
  assert.equal(registered[0].sizeBytes, 4);
  assert.equal(registered[0].checksumSha256, '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a');
  assert.deepEqual(progress.map((value) => value.completed), [2, 4]);
  assert.equal(output.reference, 's3://bucket/video');
});

test('worker context binds durable approval to the current Task automatically', async () => {
  const calls = [];
  const task = defineRhinoQTask({ async dispatch() {} }, {
    name: 'invoice.publish', adapter: 'manual', runtime: 'manual', scope: 'billing',
    run: async (_input, context) => context.waitForApproval({ id: 'approval-1', key: 'finance', payloadVersion: 1, deadline: '2026-08-14T00:00:00.000Z' }),
  }, { waitpoints: { async createTaskWaitpoint(taskId, request) {
    calls.push({ taskId, request });
    return { id: request.id, taskId, kind: request.kind, state: 'resolved', resolution: { approved: true }, entityVersion: 2 };
  } } });
  const outcome = await task.workerHandler()({ data: {
    taskName: 'invoice.publish', definitionVersion: 1, taskId: 'task-approval', executionId: 'execution-1', payload: {},
  } });
  assert.deepEqual(outcome.status, 'resolved');
  assert.equal(outcome.value, true);
  assert.equal(calls[0].taskId, 'task-approval');
  assert.equal(calls[0].request.kind, 'approval');
});

test('optional trace hooks propagate a bounded carrier from dispatch to handler', async () => {
  let command;
  const spans = [];
  const trace = {
    inject: () => ({ traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' }),
    async run(name, attributes, carrier, operation) { spans.push({ name, attributes, carrier }); return operation(); },
  };
  const task = defineRhinoQTask({ async dispatch(_adapter, value) { command = value; return {}; } }, {
    name: 'trace.task', adapter: 'manual', runtime: 'manual', scope: 'trace', run: async () => 'ok',
  }, { trace });
  await task.dispatch({ id: 'task-trace', ownerId: 'owner', payload: {} });
  assert.equal(command.payload.trace.traceparent, trace.inject().traceparent);
  await task.workerHandler()({ data: command.payload });
  assert.deepEqual(spans.map((span) => span.name), ['rhinoq.task.dispatch', 'rhinoq.task.run']);
  assert.equal(spans[1].carrier.traceparent, trace.inject().traceparent);
});

test('Task declaration dispatches a bounded fan-out with stable item identity', async () => {
  const calls = [];
  const integration = { async dispatch(adapter, command) {
    calls.push({ adapter, command });
    return { id: command.task.id, type: command.task.type, ownerId: command.task.ownerId,
      state: 'queued', entityVersion: calls.length, schemaVersion: 1, progress: { completed: 0 },
      hasResult: false, executions: [], createdAt: '2026-08-12T00:00:00Z', updatedAt: '2026-08-12T00:00:00Z' };
  } };
  const task = defineRhinoQTask(integration, {
    name: 'image.resize', adapter: 'manual', runtime: 'manual', scope: 'images', batch: { maxItems: 2 },
    execution: { delayMs: 500, priority: 3 },
    run: async (input) => input,
  });
  const result = await task.dispatchBatch({ id: 'batch-1', ownerId: 'owner-a', items: [
    { itemKey: 'small', payload: { size: 320 } }, { itemKey: 'large', payload: { size: 1280 } },
  ] });
  assert.equal(result.entityVersion, 2);
  assert.deepEqual(calls.map(({ command }) => ({ executionId: command.executionId, itemKey: command.itemKey, idempotencyKey: command.idempotencyKey })), [
    { executionId: 'batch-1:small:attempt:1', itemKey: 'small', idempotencyKey: 'batch-1:small' },
    { executionId: 'batch-1:large:attempt:1', itemKey: 'large', idempotencyKey: 'batch-1:large' },
  ]);
  assert.ok(calls.every(({ command }) => command.delayMs === 500 && command.priority === 3));
  await assert.rejects(() => task.dispatchBatch({ id: 'batch-2', ownerId: 'owner-a', items: [
    { itemKey: 'a', payload: {} }, { itemKey: 'b', payload: {} }, { itemKey: 'c', payload: {} },
  ] }), /maxItems is 2/);
  await task.dispatchAt(
    { id: 'scheduled-1', ownerId: 'owner-a', payload: { size: 640 }, execution: { priority: 9 } },
    '2026-08-13T00:01:00.000Z',
    new Date('2026-08-13T00:00:00.000Z'),
  );
  assert.equal(calls.at(-1).command.delayMs, 60_000);
  assert.equal(calls.at(-1).command.priority, 9);
});
