import assert from 'node:assert/strict';
import test from 'node:test';

import { createRhinoQAtomicOperationalConfigStore } from '../dist/index.js';

const approval = { approvalId: 'approval-1', approvedBy: 'operator-1', approvedAt: '2026-08-14T00:00:00.000Z' };

test('operational config stages, commits and rolls back with approval and version fencing', () => {
  const store = createRhinoQAtomicOperationalConfigStore({ concurrency: 2, paused: false });
  const staged = store.stage({ concurrency: 3, paused: false });
  assert.equal(store.current().revision, 1);
  assert.throws(() => store.commit(staged, { ...approval, approvedAt: 'invalid' }), /approval requires/);
  const committed = store.commit(staged, approval);
  assert.equal(committed.revision, 2);
  assert.equal(committed.settings.concurrency, 3);
  assert.throws(() => store.commit(staged, approval), /stale/);
  const rolledBack = store.rollback(staged, { ...approval, approvalId: 'approval-2' });
  assert.equal(rolledBack.revision, 3);
  assert.equal(rolledBack.settings.concurrency, 2);
});

test('operational config refuses an unbounded setting shape', () => {
  const store = createRhinoQAtomicOperationalConfigStore();
  assert.throws(() => store.stage({ nested: { value: true } }), /primitive/);
  assert.throws(() => store.stage({ 'bad key': 1 }), /key is invalid/);
});
