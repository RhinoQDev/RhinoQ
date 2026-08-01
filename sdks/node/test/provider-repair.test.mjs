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
