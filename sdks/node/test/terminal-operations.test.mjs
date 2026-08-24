import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRhinoQWorkbenchTaskURL,
  formatRhinoQTerminalGroup,
  groupRhinoQTerminalEvents,
  projectRhinoQTerminalEvent,
  watchRhinoQTasks,
} from '../dist/index.js';

function summary(overrides = {}) {
  return {
    schemaVersion: 1, entityVersion: 1, id: 'task-1', type: 'report.export', state: 'running',
    cancellation: { status: 'none' }, progress: { completed: 1, total: 10 }, hasResult: false,
    executionCounts: { total: 1, pendingDispatch: 0, dispatched: 0, running: 1, succeeded: 0, failed: 0, stalled: 0, cancelled: 0 },
    itemCounts: { total: 1, pendingDispatch: 0, dispatched: 0, running: 1, succeeded: 0, failed: 0, stalled: 0, cancelled: 0, retries: 0 },
    createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:01.000Z', ...overrides,
  };
}

test('terminal projection explains uncertain work and provides a next action', () => {
  const event = projectRhinoQTerminalEvent(summary({ state: 'uncertain', entityVersion: 2 }));
  assert.equal(event.severity, 'error');
  assert.equal(event.kind, 'uncertain');
  assert.equal(event.nextAction, 'rhinoq inspect task-1');
  assert.match(event.summary, /blind retry is unsafe/i);
});

test('terminal grouping collapses repeated symptoms and quiet formatting removes info', () => {
  const events = ['a', 'b', 'c'].map((id) => projectRhinoQTerminalEvent(summary({ id, state: 'failed', entityVersion: 2 })));
  const groups = groupRhinoQTerminalEvents(events);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 3);
  assert.match(formatRhinoQTerminalGroup(groups[0]), /×3/);
  const info = groupRhinoQTerminalEvents([projectRhinoQTerminalEvent(summary())])[0];
  assert.equal(formatRhinoQTerminalGroup(info, { quiet: true }), '');
});

test('watch reads authoritative summaries, filters initial attention and supports one-shot CI use', async () => {
  const source = { async listTasksByState() { return [summary(), summary({ id: 'failed-1', state: 'failed' })]; } };
  const batches = [];
  for await (const batch of watchRhinoQTasks(source, { once: true })) batches.push(batch);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map((item) => item.taskIds[0]), ['failed-1']);
});

test('Workbench deep links are encoded and refuse plaintext remote origins', () => {
  assert.equal(buildRhinoQWorkbenchTaskURL('http://127.0.0.1:8788/rhinoq', 'task/a'), 'http://127.0.0.1:8788/rhinoq?task=task%2Fa');
  assert.throws(() => buildRhinoQWorkbenchTaskURL('http://example.com/rhinoq', 'task-1'), /HTTPS/);
});
