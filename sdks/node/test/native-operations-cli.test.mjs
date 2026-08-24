import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli/rhinoq.js', import.meta.url));

test('adopt --plan writes a fingerprinted safety artifact and promotion evaluates explicit shadow evidence', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-native-adopt-'));
  try {
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'refund.ts'), `new Worker('refunds', async job => { await stripe.refunds.create({ id: job.data.id }); });\n`);
    const planPath = join(cwd, '.rhinoq', 'plan.json');
    const planned = spawnSync(process.execPath, [cli, 'adopt', '--plan', '--out', planPath, '--json'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.equal(plan.kind, 'rhinoq-native-adoption-plan');
    assert.equal(plan.status, 'needs-confirmation');
    assert.equal(plan.inventory.externalEffects, 1);

    const evidencePath = join(cwd, '.rhinoq', 'shadow.json');
    writeFileSync(evidencePath, JSON.stringify({
      schemaVersion: 1, mode: 'observe', startedAt: '2026-08-24T00:00:00.000Z', generatedAt: '2026-08-24T00:01:00.000Z',
      observedEvents: 3, runtimeReferences: 1, tasksBound: 1, bindingsCreated: 1, unboundEvents: 0,
      unresolvedEvents: 0, uncertainOutcomes: 0, terminalFailures: 0, retryAttemptsObserved: 0,
      guaranteeGaps: [], replicas: 2,
      checklist: [{ id: 'durable_reporting', status: 'configured', guarantee: 'durable' }],
    }));
    const promoted = spawnSync(process.execPath, [
      cli, 'adopt', '--promote', '--from', planPath, '--evidence', evidencePath,
      ...plan.requiredApprovals.flatMap((approval) => ['--approve', approval]),
    ], { cwd, encoding: 'utf8', env: {} });
    assert.equal(promoted.status, 0, promoted.stderr);
    assert.equal(JSON.parse(promoted.stdout).status, 'ready');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('open --print creates a direct encoded Workbench Task link without launching a browser', () => {
  const result = spawnSync(process.execPath, [cli, 'open', 'task/a', '--base-url', 'http://127.0.0.1:8788/rhinoq', '--print'], { encoding: 'utf8', env: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'http://127.0.0.1:8788/rhinoq?task=task%2Fa');
});
