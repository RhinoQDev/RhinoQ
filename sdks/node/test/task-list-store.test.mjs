import assert from 'node:assert/strict';
import test from 'node:test';

import { TaskListStore } from '../dist/index.js';

test('TaskListStore filters an inbox and never regresses entity versions', async () => {
  const pages = [[task('a', 2, 'running', 'report')], [task('a', 1, 'queued', 'report'), task('b', 1, 'failed', 'email')]];
  const store = new TaskListStore({ async listTasks() { return pages.shift() ?? []; } }, { states: ['running'], types: ['report'] });
  await store.refresh(); await store.refresh();
  assert.equal(store.getSnapshot().tasks.length, 1);
  assert.equal(store.getSnapshot().tasks[0].entityVersion, 2);
  assert.match(store.getSnapshot().lastAuthoritativeAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('TaskListStore removes a task when a newer state leaves the filter', async () => {
  const pages = [[task('a', 1, 'running', 'report')], [task('a', 2, 'succeeded', 'report')]];
  const store = new TaskListStore({ async listTasks() { return pages.shift() ?? []; } }, { states: ['running'] });
  await store.refresh(); await store.refresh();
  assert.deepEqual(store.getSnapshot().tasks, []);
});

function task(id, entityVersion, state, type) {
  return { schemaVersion: 1, entityVersion, id, type, state, progress: { completed: 0 }, hasResult: false, executions: [],
    createdAt: '2026-08-01T00:00:00Z', updatedAt: `2026-08-01T00:00:0${entityVersion}Z` };
}
