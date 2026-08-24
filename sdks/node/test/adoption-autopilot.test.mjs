import assert from 'node:assert/strict';
import test from 'node:test';

import { compileRhinoQAdoptionPlan, compileRhinoQAdoptionPromotionEvidence, evaluateRhinoQAdoptionPromotion } from '../dist/index.js';

function report(findings) {
  return {
    schemaVersion: 2, mode: 'preview-only', root: '/project', filesScanned: 3, linesScanned: 100,
    skippedLargeFiles: 0, skippedIgnoredFiles: 0, truncated: false, detected: [], findings,
    replaceableEstimate: { files: 1, matchingLines: 1, methodology: 'high-confidence static match lines; not a deletion or savings claim' },
    stillApplicationOwned: ['auth', 'handler', 'business verification'],
    preview: { changes: [], diff: '', rollback: { kind: 'none', reason: 'test' } }, warnings: [],
  };
}

test('native adoption plan blocks automatic effect-policy invention and stays deterministic', () => {
  const input = report([
    { category: 'job-handler', confidence: 'high', file: 'src/jobs.ts', line: 2, evidence: 'new Worker()', replacement: 'Task', consumerOwned: true },
    { category: 'external-effect', confidence: 'high', file: 'src/jobs.ts', line: 8, evidence: 'await stripe.refunds.create()', replacement: 'effect', consumerOwned: true },
  ]);
  const first = compileRhinoQAdoptionPlan(input);
  const second = compileRhinoQAdoptionPlan(input);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.status, 'needs-confirmation');
  assert.equal(first.inventory.handlers, 1);
  assert.equal(first.inventory.externalEffects, 1);
  assert.equal(first.requiredApprovals.length, 1);
  assert.match(first.diagnostics[0].whatRhinoQDid, /no idempotency/i);
  assert.deepEqual(first.stillApplicationOwned, ['auth', 'handler', 'business verification', 'effect policy']);
});

test('promotion requires matching plan, approvals and durable resolved shadow evidence', () => {
  const plan = compileRhinoQAdoptionPlan(report([
    { category: 'retry-timer', confidence: 'high', file: 'src/retry.ts', line: 4, evidence: 'setTimeout(retry)', replacement: 'runtime retry', consumerOwned: true },
  ]));
  const blocked = evaluateRhinoQAdoptionPromotion(plan, {
    planFingerprint: plan.fingerprint, approvals: [],
    shadow: { durable: false, unresolvedEvents: 2, capabilityGaps: ['cancel unsupported'], observedEvents: 0 },
  });
  assert.equal(blocked.status, 'blocked');
  assert.ok(blocked.blockers.some((item) => item.includes('missing approval')));
  assert.ok(blocked.blockers.some((item) => item.includes('identity')));

  const ready = evaluateRhinoQAdoptionPromotion(plan, {
    planFingerprint: plan.fingerprint, approvals: plan.requiredApprovals,
    shadow: { durable: true, unresolvedEvents: 0, capabilityGaps: [], observedEvents: 5 },
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.command, 'npx rhinoq adopt --mode <reviewed-single-or-fanout> --apply');
});

test('real Shadow Adoption reports compile into promotion evidence without manual fact copying', () => {
  const plan = compileRhinoQAdoptionPlan(report([]));
  const evidence = compileRhinoQAdoptionPromotionEvidence(plan, {
    schemaVersion: 1, mode: 'observe', startedAt: '2026-08-24T00:00:00.000Z', generatedAt: '2026-08-24T00:01:00.000Z',
    observedEvents: 3, runtimeReferences: 1, tasksBound: 1, bindingsCreated: 1, unboundEvents: 0,
    unresolvedEvents: 0, uncertainOutcomes: 0, terminalFailures: 0, retryAttemptsObserved: 0,
    guaranteeGaps: [], replicas: 2,
    checklist: [{ id: 'durable_reporting', status: 'configured', guarantee: 'durable' }],
  }, plan.requiredApprovals);
  assert.equal(evidence.shadow.durable, true);
  assert.equal(evidence.shadow.observedEvents, 3);
  assert.deepEqual(evidence.shadow.capabilityGaps, []);
});
