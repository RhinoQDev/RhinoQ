import assert from 'node:assert/strict';
import test from 'node:test';

import { listRhinoQCapabilities } from '../dist/index.js';

test('capability ledger is stable, uniquely keyed and evidence-aware', () => {
  const entries = listRhinoQCapabilities();
  assert.ok(entries.length >= 8);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  assert.ok(entries.some((entry) => entry.status === 'not-built' && entry.id === 'control-plane'));
  assert.ok(entries.every((entry) => entry.claim && entry.limit && entry.evidence));
  assert.ok(Object.isFrozen(entries));
});
