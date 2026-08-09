import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskGroupController, failedTaskItems, taskGroupManifest, taskGroupView } from '../dist/index.js';

const task = { schemaVersion: 1, entityVersion: 9, id: 'batch-1', type: 'thumbs', ownerId: 'owner', state: 'running', cancellation: { status: 'none' }, progress: { completed: 3, total: 3 }, hasResult: false,
  executions: [
    { id: 'a1', itemKey: 'a', attempt: 1, runtime: 'bullmq', state: 'failed', version: 2, hasResult: false, failureReason: 'old' },
    { id: 'a2', itemKey: 'a', attempt: 2, runtime: 'bullmq', state: 'succeeded', version: 2, hasResult: true },
    { id: 'b1', itemKey: 'b', attempt: 1, runtime: 'bullmq', state: 'failed', version: 2, hasResult: false, failureReason: 'bad,input' },
    { id: 'c1', itemKey: 'c', attempt: 1, runtime: 'bullmq', state: 'pending_dispatch', version: 1, hasResult: false },
  ], createdAt: '2026-08-09T00:00:00Z', updatedAt: '2026-08-09T00:01:00Z' };

test('TaskGroup uses latest attempt and bulk actions never cancel active work', async () => {
  const view = taskGroupView(task); assert.equal(view.counts.total, 3); assert.equal(view.counts.succeeded, 1); assert.equal(view.counts.failed, 1);
  const controller = new TaskGroupController(task, 2); const retried = []; const cancelled = [];
  await controller.retryFailed('retry-1', async command => { retried.push(command); return { ...task, entityVersion: command.expectedVersion + 1 }; });
  await controller.cancelPending('cancel-1', async command => cancelled.push(command));
  assert.deepEqual(retried.map(x => x.item.itemKey), ['b']); assert.deepEqual(cancelled.map(x => x.item.itemKey), ['c']);
  assert.match(retried[0].commandId, /^retry-1\./); assert.match(cancelled[0].commandId, /^cancel-1\./);
  assert.equal(retried[0].expectedVersion, 9); assert.equal(retried[0].sourceExecutionId, 'b1'); assert.match(retried[0].nextExecutionId, /^b1\.retry\./);
});

test('TaskGroup composes durable retries through committed aggregate versions', async () => {
  const batch = { ...task, executions: [...task.executions, { id: 'd1', itemKey: 'd', attempt: 1, runtime: 'bullmq', state: 'stalled', version: 2, hasResult: false }] };
  const commands = [];
  const snapshots = await new TaskGroupController(batch, 100).retryFailed('retry-batch', async command => { commands.push(command); return { ...batch, entityVersion: command.expectedVersion + 1 }; });
  assert.deepEqual(commands.map(command => [command.item.itemKey, command.expectedVersion]), [['b', 9], ['d', 10]]);
  assert.equal(snapshots.at(-1).entityVersion, 11); assert.notEqual(commands[0].nextExecutionId, commands[1].nextExecutionId);
});

test('TaskGroup fails closed without a committed retry snapshot', async () => {
  await assert.rejects(new TaskGroupController(task).retryFailed('retry-bad', async () => task), /invalid committed snapshot/);
});

test('TaskGroup exports bounded manifest shapes without exposing unrelated data', () => {
  assert.match(failedTaskItems(task, 'csv'), /"bad,input"/);
  assert.equal(JSON.parse(failedTaskItems(task)).failed.length, 1);
  const manifest = taskGroupManifest(task, [{ executionId: 'a2', itemKey: 'a', attempt: 2, state: 'succeeded', reference: 's3:\/\/a', updatedAt: task.updatedAt }]);
  assert.equal(manifest.items.find(item => item.itemKey === 'a').reference, 's3://a');
});
