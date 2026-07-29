import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RhinoQClient,
  RhinoQError,
} from '../dist/index.js';

test('Gateway client exposes the versioned Task polling contract', async () => {
  const requests = [];
  const snapshot = {
    schemaVersion: 1,
    entityVersion: 2,
    id: 'task_01',
    type: 'report.export',
    state: 'queued',
    progress: { completed: 0 },
    hasResult: false,
    executions: [],
    createdAt: '2026-07-29T00:00:00Z',
    updatedAt: '2026-07-29T00:00:01Z',
  };
  const client = new RhinoQClient({
    url: 'http://gateway.test',
    fetch: async (url, options) => {
      requests.push({
        url,
        method: options.method,
        body: options.body ? JSON.parse(options.body) : undefined,
      });
      return Response.json(snapshot);
    },
  });

  await client.createTask({
    id: 'task_01',
    type: 'report.export',
    ownerId: 'user_01',
    definitionVersion: 1,
  });
  await client.createTaskExecution('task_01', {
    id: 'exec_01',
    runtime: 'bullmq',
  });
  await client.bindTaskExecution('exec_01', {
    runtime: 'bullmq',
    externalId: 'bull_job_01',
  });
  const polled = await client.getTask('task_01');
  await client.transitionTask('task_01', polled.entityVersion, 'running');
  await client.reportTaskProgress('task_01', polled.entityVersion, {
    completed: 1,
    total: 4,
  });
  await client.attachTaskResult(
    'task_01',
    polled.entityVersion,
    's3://reports/task_01.pdf',
  );
  await client.getTaskResult('task_01');

  assert.deepEqual(requests.map((request) => [request.method, request.url]), [
    ['POST', 'http://gateway.test/v1/tasks'],
    ['POST', 'http://gateway.test/v1/tasks/task_01/executions'],
    ['POST', 'http://gateway.test/v1/task-executions/exec_01/bind'],
    ['GET', 'http://gateway.test/v1/tasks/task_01'],
    ['POST', 'http://gateway.test/v1/tasks/task_01/state'],
    ['POST', 'http://gateway.test/v1/tasks/task_01/progress'],
    ['POST', 'http://gateway.test/v1/tasks/task_01/result'],
    ['GET', 'http://gateway.test/v1/tasks/task_01/result'],
  ]);
  assert.deepEqual(requests[4].body, {
    expectedVersion: 2,
    state: 'running',
  });
  assert.deepEqual(requests[5].body, {
    expectedVersion: 2,
    progress: { completed: 1, total: 4 },
  });
  assert.deepEqual(requests[6].body, {
    expectedVersion: 2,
    reference: 's3://reports/task_01.pdf',
  });
});

test('Gateway client sends UTF-8 JSON safely without argument spreading limits', async () => {
  let request;
  const client = new RhinoQClient({
    url: 'http://gateway.test/',
    token: 'secret',
    fetch: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return Response.json({ jobId: 'job_01' }, { status: 201 });
    },
  });
  const large = `Báo cáo 🦏 ${'x'.repeat(300_000)}`;

  const id = await client.enqueue({
    queueName: 'generate-report',
    jobName: 'generate-report',
    payload: { title: large },
  });

  assert.equal(id, 'job_01');
  assert.equal(request.url, 'http://gateway.test/v1/jobs');
  assert.equal(request.options.headers.authorization, 'Bearer secret');
  const decoded = Buffer.from(request.body.payload, 'base64').toString('utf8');
  assert.deepEqual(JSON.parse(decoded), { title: large });
});

test('Gateway claim sends subscribed queues and decodes payload bytes', async () => {
  let body;
  const client = new RhinoQClient({
    url: 'http://gateway.test',
    fetch: async (_url, options) => {
      body = JSON.parse(options.body);
      return Response.json({
        jobs: [{
          job: {
            id: 'job_01',
            queueName: 'send-email',
            jobName: 'send-email',
            state: 'leased',
            resourceClass: 'standard',
            priority: 0,
            attempts: 1,
            crashCount: 0,
            createdAt: '2026-01-01T00:00:00Z',
            notBefore: '2026-01-01T00:00:00Z',
            cancelRequested: false,
          },
          payload: Buffer.from('{"userId":"u1"}').toString('base64'),
          lease: { jobId: 'job_01', owner: 'email-1', epoch: 1 },
          expiresAt: '2026-01-01T00:01:00Z',
        }],
      });
    },
  });

  const jobs = await client.claim('email-1', 4, 60_000, ['send-email']);

  assert.deepEqual(body.queueNames, ['send-email']);
  assert.equal(new TextDecoder().decode(jobs[0].payload), '{"userId":"u1"}');
});

test('Gateway claim omits queue filter for a compatible older server', async () => {
  let body;
  const client = new RhinoQClient({
    url: 'http://gateway.test',
    fetch: async (_url, options) => {
      body = JSON.parse(options.body);
      return Response.json({ jobs: [] });
    },
  });

  await client.claim('legacy-worker', 1);

  assert.equal(Object.hasOwn(body, 'queueNames'), false);
});

test('Gateway client records external effect confirmation evidence', async () => {
  let request;
  const client = new RhinoQClient({
    url: 'http://gateway.test',
    fetch: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return Response.json({
        id: 'effect_01',
        name: 'create-video',
        state: 'confirmed',
        externalRef: 'event_01',
        irreversible: false,
      });
    },
  });

  const effect = await client.confirmEffect('job_01', {
    name: 'create-video',
    key: 'video:01',
    reference: 'event_01',
  });

  assert.equal(request.url, 'http://gateway.test/v1/effects/confirm');
  assert.deepEqual(request.body, {
    jobId: 'job_01',
    name: 'create-video',
    key: 'video:01',
    reference: 'event_01',
  });
  assert.equal(effect.state, 'confirmed');
});

test('Gateway client preserves typed retry information', async () => {
  const client = new RhinoQClient({
    url: 'http://gateway.test',
    fetch: async () => Response.json({
      error: {
        code: 'RHINOQ_QUEUE_OVER_CAPACITY',
        message: 'queue is full',
        retryable: true,
        retryAfterMs: 5000,
      },
    }, { status: 429 }),
  });

  await assert.rejects(
    client.enqueue({ queueName: 'reports', jobName: 'reports', payload: {} }),
    (error) => {
      assert.ok(error instanceof RhinoQError);
      assert.equal(error.code, 'RHINOQ_QUEUE_OVER_CAPACITY');
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterMs, 5000);
      assert.equal(error.status, 429);
      return true;
    },
  );
});
