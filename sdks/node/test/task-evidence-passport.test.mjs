import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskEvidencePassport } from '../dist/index.js';

const now = '2026-08-14T00:00:00.000Z';

function task(state = 'succeeded') {
  return {
    schemaVersion: 1,
    entityVersion: 7,
    id: 'task-1',
    type: 'report.export',
    ownerId: 'owner-a',
    state,
    cancellation: { status: 'none' },
    progress: { completed: 2, total: 2 },
    hasResult: false,
    executions: [
      { id: 'e1', itemKey: 'report', attempt: 1, runtime: 'bullmq', state: 'failed', version: 1, hasResult: false, failureReason: 'timeout' },
      { id: 'e2', itemKey: 'report', attempt: 2, runtime: 'bullmq', state: 'succeeded', version: 2, hasResult: false },
      { id: 'e3', itemKey: 'cover', attempt: 1, runtime: 'bullmq', state: 'succeeded', version: 1, hasResult: true },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

test('TaskEvidencePassport separates technical, external and business evidence', () => {
  const passport = taskEvidencePassport({
    task: task(),
    providerOperations: [{
      id: 'provider-1', taskId: 'task-1', provider: 'stripe', operation: 'capture',
      idempotencyKey: 'order-1', confirmation: 'readback', retryPolicy: 'when-not-happened',
      state: 'confirmed', version: 1, updatedAt: now, createdAt: now,
    }],
    verifications: [{
      schemaVersion: 1, id: 'verification-1', taskId: 'task-1', verifier: 'billing.readback',
      status: 'mismatch', summary: 'Invoice total differs', verifiedAt: now, createdAt: now,
    }],
    artifacts: [{
      schemaVersion: 1, entityVersion: 1, id: 'artifact-1', taskId: 'task-1', name: 'report.pdf',
      contentType: 'application/pdf', sizeBytes: 12, checksumSha256: 'a'.repeat(64),
      expiresAt: '2026-08-15T00:00:00.000Z', lineage: [], createdAt: now, updatedAt: now,
    }],
    recoveryHistory: [{ id: 'repair-1', state: 'previewed', observedAt: now }],
    now: () => new Date(now),
  });

  assert.equal(passport.schemaVersion, 1);
  assert.equal(passport.technicalExecution.status, 'succeeded');
  assert.deepEqual(passport.technicalExecution.missingResultExecutionIds, ['e2']);
  assert.equal(passport.externalEffect.status, 'confirmed');
  assert.equal(passport.businessOutcome.status, 'mismatch');
  assert.equal(passport.recovery.required, true);
  assert.ok(passport.recovery.reasons.includes('business verification found a mismatch'));
  assert.ok(passport.recovery.reasons.includes('one or more succeeded attempts have no result evidence'));
  assert.deepEqual(passport.evidenceRefs.executionIds, ['e2', 'e3']);
  assert.equal(passport.artifacts[0].available, true);
  assert.equal(JSON.stringify(passport).includes('storage://'), false);
});

test('TaskEvidencePassport keeps unknown external and business results fail-closed', () => {
  const passport = taskEvidencePassport({
    task: task('uncertain'),
    providerOperations: [{
      id: 'provider-2', taskId: 'task-1', provider: 'stripe', operation: 'capture',
      idempotencyKey: 'order-2', confirmation: 'readback', retryPolicy: 'when-not-happened',
      state: 'pending', version: 1, updatedAt: now, createdAt: now,
    }],
    now: () => new Date(now),
  });

  assert.equal(passport.technicalExecution.status, 'unknown');
  assert.equal(passport.externalEffect.status, 'uncertain');
  assert.equal(passport.businessOutcome.status, 'unknown');
  assert.equal(passport.recovery.required, true);
  assert.ok(passport.recovery.reasons.includes('external effect result is not confirmed'));
  assert.ok(passport.recovery.reasons.includes('business outcome is not independently verified'));
});
