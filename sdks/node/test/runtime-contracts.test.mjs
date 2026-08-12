import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateRuntimeEvent,
  validateRuntimeObservation,
  validateRuntimeAdapter,
  checkRuntimeAdapterContract,
  validateRuntimeRef,
} from '../dist/index.js';

const ref = { runtime: 'custom', scope: 'reports', externalId: 'job-42' };
const now = '2026-08-12T03:00:00.000Z';

test('runtime identity is the complete runtime/scope/externalId tuple', () => {
  assert.equal(validateRuntimeRef(ref), ref);
  assert.throws(() => validateRuntimeRef({ ...ref, scope: ' ' }), /ref\.scope/);
  assert.throws(() => validateRuntimeRef({ ...ref, externalId: '' }), /ref\.externalId/);
});

test('adapter capability claims require matching methods', () => {
  assert.throws(() => validateRuntimeAdapter({
    name: 'custom', scope: 'jobs',
    capabilities: { events: 'push', dispatch: false, inspect: false, cancel: 'unsupported', progress: false, stableAttempts: false },
  }), /without subscribe/);
  assert.throws(() => validateRuntimeAdapter({
    name: 'custom', scope: 'jobs',
    capabilities: { events: 'none', dispatch: false, inspect: true, cancel: 'unsupported', progress: false, stableAttempts: false },
  }), /without inspect/);
});

test('adapter testkit verifies read-only inspection identity and health shape', async () => {
  const adapter = {
    name: 'custom', scope: 'jobs',
    capabilities: { events: 'poll', dispatch: false, inspect: true, cancel: 'unsupported', progress: false, stableAttempts: true },
    async inspect(runtimeRef) {
      return { ref: runtimeRef, state: 'running', terminal: false, observedAt: now };
    },
    async health() { return { status: 'healthy', checkedAt: now }; },
  };
  const result = await checkRuntimeAdapterContract(adapter, {
    runtime: 'custom', scope: 'jobs', externalId: 'job-1',
  });
  assert.deepEqual(result.checks, ['capability shape', 'inspect identity', 'observation shape', 'health shape']);
});

test('portable events accept runtime-neutral lifecycle facts', () => {
  const event = {
    type: 'progressed', ref, occurredAt: now, attempt: 2,
    progress: { completed: 3, total: 5, message: 'rendering' },
  };
  assert.equal(validateRuntimeEvent(event), event);
});

test('failed and uncertain events fail closed without adapter evidence', () => {
  assert.throws(
    () => validateRuntimeEvent({ type: 'failed', ref, occurredAt: now, reason: 'timeout' }),
    /terminal must be supplied/,
  );
  assert.throws(
    () => validateRuntimeEvent({ type: 'uncertain', ref, occurredAt: now, reason: '' }),
    /reason must be a non-empty string/,
  );
});

test('portable progress and attempts reject ambiguous values', () => {
  assert.throws(
    () => validateRuntimeEvent({ type: 'started', ref, occurredAt: now, attempt: 0 }),
    /positive integer/,
  );
  assert.throws(
    () => validateRuntimeEvent({
      type: 'progressed', ref, occurredAt: now, progress: { completed: 4, total: 3 },
    }),
    /greater than or equal/,
  );
});

test('unknown observations require a reason and explicit terminality', () => {
  assert.throws(
    () => validateRuntimeObservation({ ref, state: 'unknown', terminal: false, observedAt: now }),
    /reason must be supplied/,
  );
  assert.throws(
    () => validateRuntimeObservation({ ref, state: 'running', observedAt: now }),
    /terminal must be supplied/,
  );
  const observation = {
    ref, state: 'unknown', terminal: false, observedAt: now, reason: 'event_gap',
  };
  assert.equal(validateRuntimeObservation(observation), observation);
});
