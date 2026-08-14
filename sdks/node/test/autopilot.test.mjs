import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRhinoQAutopilotCanary, planRhinoQAutopilotCanary, recommendRhinoQAutopilot, simulateRhinoQAutopilot } from '../dist/index.js';

test('Autopilot creates deterministic review recommendations with guardrails', () => {
  const report = recommendRhinoQAutopilot({
    schemaVersion: 1,
    observedAt: '2026-08-14T00:00:00.000Z',
    source: 'test-observer',
    metrics: { queueLagMs: 900, diskFreeBytes: 10, provider429Rate: 0.3 },
    envelope: { maxQueueLagMs: 500, minDiskFreeBytes: 100, maxProvider429Rate: 0.1 },
  });
  assert.equal(report.phase, 'recommend');
  assert.deepEqual(report.recommendations.map((item) => item.id), [
    'review-admission-and-worker-capacity', 'pause-large-media-admission', 'backoff-provider-calls',
  ]);
  assert.equal(report.recommendations.every((item) => item.action === 'review' && item.autoApply === false), true);
  assert.match(report.recommendations[0].guardrail, /Task state/);
  assert.match(report.recommendations[2].rollback, /previous call rate/);
});

test('Autopilot observes without inventing missing metrics and validates input', () => {
  const report = recommendRhinoQAutopilot({
    schemaVersion: 1,
    observedAt: '2026-08-14T00:00:00.000Z',
    source: 'test-observer', metrics: {}, envelope: {},
  });
  assert.equal(report.phase, 'observe');
  assert.ok(report.missingMetrics.includes('queueLagMs'));
  assert.equal(report.recommendations.length, 0);
  assert.throws(() => recommendRhinoQAutopilot({ schemaVersion: 1, observedAt: 'bad', source: 'test', metrics: {}, envelope: {} }), /ISO timestamp/);
  assert.throws(() => recommendRhinoQAutopilot({ schemaVersion: 1, observedAt: '2026-08-14T00:00:00.000Z', source: 'test', metrics: { cpuPercent: -1 }, envelope: {} }), /non-negative/);
});

test('Autopilot simulation and canary phases emit approval artifacts without mutation', () => {
  const report = recommendRhinoQAutopilot({
    schemaVersion: 1, observedAt: '2026-08-14T00:00:00.000Z', source: 'test-observer',
    metrics: { cpuPercent: 95 }, envelope: { maxCpuPercent: 80 },
  });
  const simulation = simulateRhinoQAutopilot({ report, proposedChanges: [{ recommendationId: report.recommendations[0].id, change: 'reduce concurrency by one' }] });
  assert.equal(simulation.phase, 'simulate');
  assert.equal(simulation.recommendations[0].wouldMutate, false);
  const canary = planRhinoQAutopilotCanary({ report, windowMs: 60_000, maxTasks: 10 });
  assert.deepEqual(canary.recommendationIds, [report.recommendations[0].id]);
  assert.equal(canary.approvalRequired, true);
  assert.equal(canary.autoApply, false);
});

test('Autopilot canary requires explicit approval and rolls back an unhealthy bounded change', async () => {
  const report = recommendRhinoQAutopilot({
    schemaVersion: 1, observedAt: '2026-08-14T00:00:00.000Z', source: 'test-observer',
    metrics: { cpuPercent: 95 }, envelope: { maxCpuPercent: 80 },
  });
  const plan = planRhinoQAutopilotCanary({ report, maxTasks: 3, windowMs: 60_000 });
  const calls = [];
  const result = await executeRhinoQAutopilotCanary({
    plan,
    approve: () => ({ approvalId: 'approval-1', approvedBy: 'operator', approvedAt: '2026-08-14T00:00:00.000Z' }),
    apply: (recommendationId, context) => { calls.push(['apply', recommendationId, context.maxTasks]); return { recommendationId, rollbackToken: 'rollback-1' }; },
    observe: (context) => { calls.push(['observe', context.windowMs]); return { healthy: false, reason: 'error rate increased' }; },
    rollback: (change) => { calls.push(['rollback', change.rollbackToken]); },
  });
  assert.equal(result.phase, 'rolled_back');
  assert.equal(result.rolledBack, true);
  assert.deepEqual(calls, [
    ['apply', report.recommendations[0].id, 3],
    ['observe', 60_000],
    ['rollback', 'rollback-1'],
  ]);
});

test('Autopilot canary never applies when approval is rejected', async () => {
  const report = recommendRhinoQAutopilot({
    schemaVersion: 1, observedAt: '2026-08-14T00:00:00.000Z', source: 'test-observer',
    metrics: { cpuPercent: 95 }, envelope: { maxCpuPercent: 80 },
  });
  const plan = planRhinoQAutopilotCanary({ report });
  let applied = false;
  const result = await executeRhinoQAutopilotCanary({
    plan,
    approve: () => { throw new Error('operator declined'); },
    apply: () => { applied = true; return { recommendationId: plan.recommendationIds[0], rollbackToken: 'never' }; },
    observe: () => ({ healthy: true }),
    rollback: () => {},
  });
  assert.equal(result.phase, 'rejected');
  assert.equal(applied, false);
  assert.match(result.error, /operator declined/);
});

test('Autopilot canary bounds an unresponsive observation window', async () => {
  const report = recommendRhinoQAutopilot({
    schemaVersion: 1, observedAt: '2026-08-14T00:00:00.000Z', source: 'test-observer',
    metrics: { cpuPercent: 95 }, envelope: { maxCpuPercent: 80 },
  });
  const plan = planRhinoQAutopilotCanary({ report, windowMs: 1_000, maxTasks: 1 });
  let rolledBack = false;
  const result = await executeRhinoQAutopilotCanary({
    plan,
    approve: () => ({ approvalId: 'approval-1', approvedBy: 'operator', approvedAt: '2026-08-14T00:00:00.000Z' }),
    apply: (recommendationId) => ({ recommendationId, rollbackToken: 'rollback-1' }),
    observe: () => new Promise(() => {}),
    rollback: () => { rolledBack = true; },
  });
  assert.equal(result.phase, 'rolled_back');
  assert.equal(rolledBack, true);
  assert.match(result.error, /window expired/);
});
