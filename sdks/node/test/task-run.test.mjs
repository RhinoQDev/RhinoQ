import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskRunHandle } from '../dist/index.js';

function snapshot(state, version) {
  return {
    id: 'task-report-42', state, entityVersion: version, type: 'report.export',
    ownerId: 'owner-a', tenantId: 'tenant-a', progress: { completed: state === 'succeeded' ? 1 : 0, total: 1 },
    executions: [], updatedAt: new Date().toISOString(),
  };
}

test('TaskRunHandle composes refresh, wait, cancel/result and owner URL', async () => {
  let reads = 0;
  let cancelled = false;
  const client = {
    async getTask() {
      reads += 1;
      if (cancelled) return snapshot('cancelled', reads);
      return reads < 2 ? snapshot('running', reads) : snapshot('succeeded', reads);
    },
    async cancelTask(_id, version) { cancelled = true; return snapshot('cancelled', version + 1); },
    async getTaskResult() { return { url: 'http://127.0.0.1/result/report-42' }; },
  };
  const run = new TaskRunHandle(client, 'task-report-42', { pollIntervalMs: 5 });
  assert.equal(run.url(), '/task-center/task-report-42');
  assert.equal(run.url('https://app.example.test'), 'https://app.example.test/task-center/task-report-42');
  const terminal = await run.wait({ timeoutMs: 1_000 });
  assert.equal(terminal.state, 'succeeded');
  assert.equal(run.state, 'succeeded');
  assert.deepEqual(await run.result(), { url: 'http://127.0.0.1/result/report-42' });
  const cancelledSnapshot = await run.cancel();
  assert.equal(cancelledSnapshot.state, 'cancelled');
});

test('TaskRunHandle rejects unsafe owner paths', () => {
  const client = { async getTask() { return snapshot('pending', 1); } };
  assert.throws(() => new TaskRunHandle(client, 'task-1', { taskCenterPath: 'task-center' }), /relative path/);
  assert.throws(() => new TaskRunHandle(client, 'task-1', { taskCenterPath: '/task-center?token=secret' }), /query/);
});
