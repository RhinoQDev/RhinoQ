import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RhinoQClient,
  RhinoQError,
} from '../dist/index.js';

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
    name: 'generate-report',
    payload: { title: large },
  });

  assert.equal(id, 'job_01');
  assert.equal(request.url, 'http://gateway.test/v1/jobs');
  assert.equal(request.options.headers.authorization, 'Bearer secret');
  const decoded = Buffer.from(request.body.payload, 'base64').toString('utf8');
  assert.deepEqual(JSON.parse(decoded), { title: large });
});

test('Gateway claim sends handler queues and decodes payload bytes', async () => {
  let body;
  const client = new RhinoQClient({
    url: 'http://gateway.test',
    fetch: async (_url, options) => {
      body = JSON.parse(options.body);
      return Response.json({
        jobs: [{
          job: {
            id: 'job_01',
            name: 'send-email',
            state: 'leased',
            class: 'standard',
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

  assert.deepEqual(body.queues, ['send-email']);
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

  assert.equal(Object.hasOwn(body, 'queues'), false);
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
    client.enqueue({ name: 'reports', payload: {} }),
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
