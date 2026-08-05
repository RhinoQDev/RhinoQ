import assert from 'node:assert/strict';
import test from 'node:test';

import { RhinoQClient } from '../dist/index.js';

test('providerOperation reserves first and never repeats an uncertain mutation', async () => {
  let stored = {
    id: 'provider_op_1', taskId: 'task-1', provider: 'stripe', operation: 'refund',
    idempotencyKey: 'refund:1', confirmation: 'readback', retryPolicy: 'when-not-happened',
    state: 'pending', version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const requests = [];
  const client = new RhinoQClient({ url: 'http://agent.test', token: 'x'.repeat(32), fetch: async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method: init?.method, path: url.pathname, body });
    if (url.pathname === '/v1/provider-operations' && init?.method === 'POST') return Response.json(stored);
    if (url.pathname.endsWith('/resolve')) {
      assert.equal(body.decision, 'unknown');
      stored = { ...stored, state: 'uncertain', reason: body.reason, version: 2 };
      return Response.json(stored);
    }
    throw new Error(`unexpected ${init?.method} ${url.pathname}`);
  }});
  let calls = 0;
  const options = {
    taskId: 'task-1', name: 'stripe.refund', idempotencyKey: 'refund:1',
    execute: async () => { calls++; throw new Error('response timeout'); },
    confirm: async () => ({ decision: 'pending', evidence: 'Stripe lookup still pending' }),
  };
  const first = await client.providerOperation(options);
  const second = await client.providerOperation(options);
  assert.equal(first.state, 'uncertain');
  assert.equal(second.state, 'uncertain');
  assert.equal(calls, 1);
  assert.equal(requests.filter((item) => item.path.endsWith('/resolve')).length, 1);
});

test('Effect Lite derives a stable key and fingerprints request shape', async () => {
  const requests = [];
  const operation = {
    id: 'provider_op_effect', taskId: 'task-1', provider: 'storage', operation: 'upload',
    idempotencyKey: 'effect:storage:upload:command-1', confirmation: 'on-return',
    retryPolicy: 'when-not-happened', state: 'pending', version: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const client = new RhinoQClient({ url: 'http://agent.test', token: 'x'.repeat(32), fetch: async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path: url.pathname, body });
    if (url.pathname === '/v1/provider-operations' && init?.method === 'POST') {
      if (body.requestFingerprint !== requests[0].body.requestFingerprint) {
        return Response.json({ error: { code: 'RHINOQ_REQUEST_FINGERPRINT_MISMATCH', message: 'different request' } }, { status: 409 });
      }
      return Response.json(operation);
    }
    if (url.pathname.endsWith('/accept')) return Response.json({ ...operation, state: 'accepted', version: 2, providerId: 'obj-1' });
    if (url.pathname.endsWith('/resolve')) return Response.json({ ...operation, state: 'confirmed', version: 3, providerId: 'obj-1' });
    throw new Error(`unexpected ${init?.method} ${url.pathname}`);
  }});

  const result = await client.effect({
    taskId: 'task-1', provider: 'storage', operation: 'upload', commandId: 'command-1',
    request: { key: 'video.mp4', size: 10 },
    execute: async (key) => ({ id: key }),
  });
  assert.equal(result.state, 'confirmed');
  const firstBegin = requests.find((request) => request.path === '/v1/provider-operations');
  assert.equal(firstBegin.body.idempotencyKey, 'effect:storage:upload:command-1');
  assert.match(firstBegin.body.requestFingerprint, /^[0-9a-f]{64}$/);

  await assert.rejects(
    client.effect({
      taskId: 'task-1', provider: 'storage', operation: 'upload', commandId: 'command-1',
      request: { key: 'different.mp4', size: 10 }, execute: async () => ({ id: 'never' }),
    }),
    /different request/,
  );
  const begins = requests.filter((request) => request.path === '/v1/provider-operations');
  assert.notEqual(begins[0].body.requestFingerprint, begins[1].body.requestFingerprint);
});

test('repair client exposes propose preview approval and execute without callback logic', async () => {
  const paths = [];
  const client = new RhinoQClient({ url: 'http://agent.test', token: 'x'.repeat(32), fetch: async (input, init) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    const states = ['/v1/repairs','/preview','/approve','/execute'];
    const index = url.pathname === states[0] ? 0 : states.findIndex((suffix) => url.pathname.endsWith(suffix));
    const state = ['proposed','previewed','approved','succeeded'][index];
    return Response.json({ id:'repair_1', finding:{ruleId:'r',subjectType:'order',subjectId:'1',invariantVersion:1}, handler:'order.sync', state, proposedBy:'operator', version:index+1, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() }, { status: index === 0 ? 201 : 200 });
  }});
  const proposed = await client.proposeRepair({ id:'repair_1', finding:{ruleId:'r',subjectType:'order',subjectId:'1',invariantVersion:1}, handler:'order.sync', actor:'operator' });
  assert.equal(proposed.state, 'proposed');
  assert.equal((await client.previewRepair(proposed.id)).state, 'previewed');
  assert.equal((await client.approveRepair(proposed.id, 'reviewer', 'evidence checked')).state, 'approved');
  assert.equal((await client.executeRepair(proposed.id)).state, 'succeeded');
  assert.deepEqual(paths, ['/v1/repairs','/v1/repairs/repair_1/preview','/v1/repairs/repair_1/approve','/v1/repairs/repair_1/execute']);
});
