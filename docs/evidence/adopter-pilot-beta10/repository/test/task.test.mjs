import assert from 'node:assert/strict';
import test from 'node:test';

import { handleRequest, reportProgress } from '../src/http.mjs';

test('manual task API exposes progress, cancel and result routes', async () => {
  const created = await handleRequest(
    new Request('http://fixture.test/api/imports', {
      method: 'POST',
      body: JSON.stringify({ total: 2 }),
      headers: { 'content-type': 'application/json' },
    }),
    'owner-a',
  );
  const task = await created.json();
  assert.equal(task.state, 'queued');
  assert.equal(reportProgress(task.id, 'owner-a', 1).completed, 1);

  const cancelled = await handleRequest(
    new Request(`http://fixture.test/api/imports/${task.id}/cancel`, { method: 'POST' }),
    'owner-a',
  );
  assert.equal((await cancelled.json()).state, 'cancelled');

  const result = await handleRequest(
    new Request(`http://fixture.test/api/imports/${task.id}/result`, {
      method: 'POST',
      body: JSON.stringify({ result: 'report.csv' }),
      headers: { 'content-type': 'application/json' },
    }),
    'owner-a',
  );
  assert.equal((await result.json()).result, 'report.csv');
});
