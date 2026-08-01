import assert from 'node:assert/strict';
import test from 'node:test';

import { TaskStore } from '../dist/index.js';

test('TaskStore preserves the maximum revision across randomized duplicates and reordering', async () => {
  const random = xorshift32(0x5248494e);
  const versions = Array.from({ length: 10_000 }, () => 1 + Math.floor(random() * 500));
  let index = 0;
  const store = new TaskStore({
    async getTask() { return snapshot(versions[index++]); },
    async cancelTask() { throw new Error('unused'); },
    async getTaskResult() { throw new Error('unused'); },
  }, 'fault-task');

  for (const _version of versions) await store.refresh();

  assert.equal(store.getSnapshot().snapshot.entityVersion, Math.max(...versions));
});

test('TaskStore converges under concurrent delivery, duplicates and transport loss across seeds', async () => {
  for (let seed = 1; seed <= 32; seed++) {
    const random = xorshift32(0x52480000 ^ seed);
    const pending = [];
    const store = new TaskStore({
      getTask() {
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      },
      async cancelTask() { throw new Error('unused'); },
      async getTaskResult() { throw new Error('unused'); },
    }, `fault-task-${seed}`);
    const requests = Array.from({ length: 128 }, () => store.refresh());
    const outcomes = pending.map((request) => ({
      request,
      version: 1 + Math.floor(random() * 1_000),
      fails: random() < 0.15,
      order: random(),
    })).sort((left, right) => left.order - right.order);
    const successful = [];
    for (const outcome of outcomes) {
      if (outcome.fails) {
        outcome.request.reject(new Error('injected transport loss'));
      } else {
        successful.push(outcome.version);
        outcome.request.resolve(snapshot(outcome.version, `fault-task-${seed}`));
      }
    }
    await Promise.allSettled(requests);
    assert.equal(
      store.getSnapshot().snapshot.entityVersion,
      Math.max(...successful),
      `seed ${seed}`,
    );
  }
});

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function snapshot(entityVersion, id = 'fault-task') {
  return {
    schemaVersion: 1, entityVersion, id, type: 'fault',
    state: 'running', progress: { completed: entityVersion }, hasResult: false,
    executions: [], createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:01Z',
  };
}
