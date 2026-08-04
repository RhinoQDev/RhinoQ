// listTaskExecutionRuntimeRefs exists so that cancelling a fan-out costs one
// query instead of one per Execution. It carries runtime job IDs, which is
// exactly why it must never become reachable from a browser: the request
// handler below is mounted on an application's own HTTP surface and serves
// end users. This pins that no route reaches it, and that the polled snapshot
// keeps its runtime identity out.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskRequestHandler, taskRoutePatterns } from '../dist/index.js';

function snapshot() {
  return {
    schemaVersion: 1,
    entityVersion: 3,
    id: 'task-1',
    type: 'bulk-download',
    ownerId: 'owner-a',
    state: 'running',
    cancellation: { status: 'none' },
    progress: { completed: 1, total: 3 },
    hasResult: false,
    executions: [
      { id: 'task-1:a', itemKey: 'item-a', attempt: 1, runtime: 'bullmq', state: 'running', version: 2, hasResult: false },
    ],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:01.000Z',
  };
}

function tasksThatFailOnRuntimeRefs(reached) {
  return {
    async listTasks() {
      return [snapshot()];
    },
    async getTaskForOwner() {
      return snapshot();
    },
    async getTaskSummaryForOwner() {
      const { executions, ...summary } = snapshot();
      return summary;
    },
    async listTaskExecutionsForOwner(taskId) {
      return { schemaVersion: 1, entityVersion: 3, taskId, executions: [] };
    },
    async getTaskExecutionResultsForOwner(taskId) {
      return { schemaVersion: 1, entityVersion: 3, taskId, executions: [] };
    },
    async getTaskResultForOwner(taskId) {
      return { schemaVersion: 1, entityVersion: 3, taskId, reference: 's3://x', updatedAt: '2026-07-30T00:00:01.000Z' };
    },
    async requestTaskCancellationForOwner() {
      return snapshot();
    },
    // If any route ever calls this, the job IDs are one HTTP hop from a browser.
    async listTaskExecutionRuntimeRefs(taskId) {
      reached.push(taskId);
      return {
        schemaVersion: 1,
        entityVersion: 3,
        taskId,
        executions: [{ executionId: 'task-1:a', itemKey: 'item-a', attempt: 1, runtime: 'bullmq', externalId: 'bull-job-01', state: 'running' }],
      };
    },
  };
}

test('no browser-facing route reaches the runtime job identities', async () => {
  const reached = [];
  const handler = createTaskRequestHandler({
    tasks: tasksThatFailOnRuntimeRefs(reached),
    ownerFromRequest: () => 'owner-a',
  });

  // Every documented route, plus the shapes an attacker would try next.
  const paths = [
    '/tasks',
    '/tasks/task-1',
    '/tasks/task-1/summary',
    '/tasks/task-1/executions',
    '/tasks/task-1/executions/page?limit=100',
    '/tasks/task-1/executions/runtime-refs',
    '/tasks/task-1/runtime-refs',
    '/tasks/task-1/result',
  ];
  for (const path of paths) {
    const response = await handler(new Request(`http://app.test${path}`));
    const body = await response.text();
    assert.ok(
      !body.includes('bull-job-01') && !body.includes('externalId'),
      `${path} exposed runtime job identity: ${body}`,
    );
  }

  assert.deepEqual(reached, [], 'a route called listTaskExecutionRuntimeRefs');
});

// The adapters mount a wildcard — `/tasks` and `/tasks/*` — so containment is
// the handler's business, not the mount pattern's. An invented subpath has to
// come back 404 rather than fall through to something that answers.
test('an unknown subpath under the mounted wildcard is refused', async () => {
  const reached = [];
  const handler = createTaskRequestHandler({
    tasks: tasksThatFailOnRuntimeRefs(reached),
    ownerFromRequest: () => 'owner-a',
  });
  const [base, wildcard] = taskRoutePatterns('/tasks');
  assert.deepEqual([base, wildcard], ['/tasks', '/tasks/*']);

  for (const path of ['/tasks/task-1/runtime-refs', '/tasks/task-1/executions/runtime-refs']) {
    const response = await handler(new Request(`http://app.test${path}`));
    assert.equal(response.status, 404, `${path} must not resolve`);
  }
});
