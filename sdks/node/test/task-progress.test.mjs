import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRhinoQProgressCoalescer } from '../dist/index.js';

test('progress coalescer writes the first update and the newest pending update on close', async () => {
  const writes = [];
  const coalescer = createRhinoQProgressCoalescer((update) => writes.push(update), {
    minCompletedDelta: 1,
    flushIntervalMs: 60_000,
  });

  await coalescer.report({ completed: 0, total: 100, message: 'start' });
  await coalescer.report({ completed: 0.1, total: 100, message: 'middle-1' });
  await coalescer.report({ completed: 0.2, total: 100, message: 'middle-2' });
  await coalescer.close();

  assert.deepEqual(writes, [
    { completed: 0, total: 100, message: 'start' },
    { completed: 0.2, total: 100, message: 'middle-2' },
  ]);
});

test('progress coalescer ignores stale completed values and serializes writes', async () => {
  const writes = [];
  const gates = [];
  let active = 0;
  let maximumActive = 0;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const coalescer = createRhinoQProgressCoalescer(async (update) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (writes.length === 0) firstStarted();
    await new Promise((resolve) => gates.push(resolve));
    writes.push(update);
    active -= 1;
  }, { flushIntervalMs: 60_000 });

  const first = coalescer.report({ completed: 5, total: 10 });
  await started;
  const second = coalescer.report({ completed: 6, total: 10 });
  const stale = coalescer.report({ completed: 4, total: 10 });
  await Promise.resolve();
  assert.equal(maximumActive, 1);
  assert.equal(writes.length, 0);
  gates.shift()();
  await first;
  await second;
  const closing = coalescer.close();
  await Promise.resolve();
  gates.shift()();
  await closing;
  await stale;

  assert.equal(maximumActive, 1);
  assert.deepEqual(writes.map((update) => update.completed), [5, 6]);
});

test('progress coalescer validates bounds and refuses reports after close', async () => {
  assert.throws(() => createRhinoQProgressCoalescer(() => {}, { flushIntervalMs: 9 }), /flushIntervalMs/);
  const coalescer = createRhinoQProgressCoalescer(() => {}, { flushIntervalMs: 60_000 });
  await assert.rejects(() => coalescer.report({ completed: 2, total: 1 }), /total must be at least completed/);
  await coalescer.close();
  await assert.rejects(() => coalescer.report({ completed: 0 }), /RHINOQ_PROGRESS_CLOSED/);
});

test('timer-triggered progress failures are surfaced at close', async () => {
  let writes = 0;
  const coalescer = createRhinoQProgressCoalescer(async () => {
    writes += 1;
    if (writes === 2) throw new Error('progress sink failed');
  }, { flushIntervalMs: 10 });
  await coalescer.report({ completed: 0, total: 100 });
  await coalescer.report({ completed: 0.1, total: 100 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  await assert.rejects(() => coalescer.close(), /progress sink failed/);
});
