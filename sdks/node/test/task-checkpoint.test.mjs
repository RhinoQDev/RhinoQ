import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PostgresTaskClient,
  defineRhinoQTask,
  sha256RhinoQCheckpointInput,
} from '../dist/index.js';

const checksum = 'a'.repeat(64);

test('checkpoint helper exposes bounded resume state without becoming Task state', async () => {
  const rows = new Map();
  const client = {
    async saveTaskCheckpoint(executionId, key, request) {
      const current = rows.get(`${executionId}:${key}`);
      if (current && request.expectedVersion !== current.version && JSON.stringify(request.state) !== JSON.stringify(current.state)) {
        throw new Error('version conflict');
      }
      const next = {
        schemaVersion: 1, id: `cp-${key}`, taskId: request.taskId, executionId, key,
        handlerVersion: request.handlerVersion, inputChecksum: request.inputChecksum,
        state: request.state, completed: request.completed === true,
        version: current ? current.version + 1 : 1,
        createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:01.000Z',
      };
      rows.set(`${executionId}:${key}`, next);
      return next;
    },
    async getTaskCheckpoint(executionId, key) { return rows.get(`${executionId}:${key}`); },
    async deleteTaskCheckpoints(executionId) {
      let count = 0;
      for (const key of rows.keys()) if (key.startsWith(`${executionId}:`)) { rows.delete(key); count += 1; }
      return count;
    },
  };
  const task = defineRhinoQTask({ async dispatch() {} }, {
    name: 'media.resume', adapter: 'manual', runtime: 'manual', scope: 'media', version: 3,
    run: async (_input, context) => {
      const saved = await context.checkpoint.save('segment-1', { offset: 128 }, { inputChecksum: checksum });
      const loaded = await context.checkpoint.load('segment-1');
      return { savedVersion: saved.version, loadedState: loaded.state };
    },
  }, { checkpoints: client });

  const result = await task.workerHandler()({
    data: { taskName: 'media.resume', definitionVersion: 3, taskId: 'task-1', executionId: 'execution-1', payload: {} },
  });
  assert.deepEqual(result, { savedVersion: 1, loadedState: { offset: 128 } });
  assert.equal(await client.deleteTaskCheckpoints('execution-1'), 1);
});

test('checkpoint input checksum is deterministic for explicit JSON input', async () => {
  assert.equal(
    await sha256RhinoQCheckpointInput('{"file":"input.bin"}'),
    'e50312770d60d0fad0db33f0d920832fdcea006f91c9dd7431660e383be41457',
  );
  await assert.rejects(() => sha256RhinoQCheckpointInput(undefined), /JSON serializable/);
});

test('Postgres checkpoint client keeps SQL command authority and bounds state', async () => {
  const calls = [];
  const row = {
    id: 'checkpoint-123', task_id: 'task-1', execution_id: 'execution-1', checkpoint_key: 'segment-1',
    handler_version: 2, input_checksum: checksum, state: { offset: 128 }, completed: false,
    version: '1', created_at: '2026-08-14T00:00:00.000Z', updated_at: '2026-08-14T00:00:00.000Z',
  };
  const client = new PostgresTaskClient({
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes('FROM rhinoq_task.checkpoints')) return { rows: [row] };
      if (text.includes('delete_execution_checkpoints')) return { rows: [{ count: '1' }] };
      return { rows: [{ version: 1 }] };
    },
  });
  const saved = await client.saveTaskCheckpoint('execution-1', 'segment-1', {
    taskId: 'task-1', handlerVersion: 2, inputChecksum: checksum, state: { offset: 128 },
  });
  assert.equal(saved.executionId, 'execution-1');
  assert.ok(calls.some((call) => call.text.includes('upsert_checkpoint')));
  assert.equal(await client.deleteTaskCheckpoints('execution-1'), 1);
  await assert.rejects(() => client.saveTaskCheckpoint('execution-1', 'segment-1', {
    taskId: 'task-1', handlerVersion: 2, inputChecksum: checksum, state: 'x'.repeat(70_000),
  }), /64 KiB/);
});
