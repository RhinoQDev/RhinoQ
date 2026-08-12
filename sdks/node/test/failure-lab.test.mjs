import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverFailureLab, runFailureLab } from '../dist/index.js';

test('completed-but-missing-output lab creates deterministic evidence without a result', async () => {
  const client = new LabTaskClient();
  const result = await runFailureLab(client, 'completed-but-missing-output', { id: 'lab-case-1' });
  assert.equal(result.task.id, 'lab-case-1');
  assert.equal(result.task.state, 'uncertain');
  assert.equal(result.task.hasResult, false);
  assert.equal(result.task.executions[0].state, 'succeeded');
  assert.equal(result.explanation.businessOutcome, 'unknown');
  assert.equal(result.proofScope, 'simulated_workflow_only');
  assert.equal(result.externalProviderCalled, false);
  assert.deepEqual(result.explanation.affected, { tasks: 1, items: 1 });
  assert.deepEqual(result.explanation.recommendedActions, [{
    id: 'recheck-output', label: 'Recheck output evidence', eligibility: 'safe', mutatesRuntime: false,
  }]);
});

test('Failure Lab rejects unknown scenarios without writing', async () => {
  const client = new LabTaskClient();
  await assert.rejects(runFailureLab(client, 'duplicate-delivery'), /unsupported Failure Lab scenario/);
  assert.equal(client.task, undefined);
});

test('Failure Lab closes the disposable incident through guarded repair and verification', async () => {
  const client = new LabTaskClient();
  await runFailureLab(client, 'completed-but-missing-output', { id: 'lab-case-recovery' });
  const result = await recoverFailureLab(client, 'lab-case-recovery');

  assert.deepEqual(result.stages, ['break', 'detect', 'explain', 'preview', 'repair', 'recheck', 'verified']);
  assert.equal(result.recovery.stage, 'verified');
  assert.equal(result.task.state, 'succeeded');
  assert.equal(result.task.hasResult, true);
  assert.equal(client.verifications[0].status, 'verified');
  assert.match(result.incidentSummary, /uncertain\/no-output/);
  assert.match(result.incidentSummary, /\"providerOutcomeVerified\":false/);
});

class LabTaskClient {
  task;
  execution;
  verifications = [];
  async createTask(request) {
    this.task = {
      schemaVersion: 1, entityVersion: 1, id: request.id, type: request.type,
      ownerId: request.ownerId, state: 'pending', cancellation: { status: 'none' },
      progress: { completed: 0 }, hasResult: false, executions: [],
      createdAt: '2026-08-12T03:00:00.000Z', updatedAt: '2026-08-12T03:00:00.000Z',
    };
    return this.snapshot();
  }
  async createTaskExecution(taskId, request) {
    this.execution = {
      id: request.id, taskId, itemKey: request.itemKey, attempt: 1, runtime: request.runtime,
      runtimeScope: request.runtimeScope, state: 'pending_dispatch', version: 1,
    };
    this.bump(); return this.snapshot();
  }
  async bindTaskExecution(id, binding) {
    assert.equal(id, this.execution.id);
    Object.assign(this.execution, { externalId: binding.externalId, state: 'dispatched', version: 2 });
    this.bump(); return this.snapshot();
  }
  async getTaskExecution(id) { assert.equal(id, this.execution.id); return structuredClone(this.execution); }
  async transitionTask(id, version, state) {
    assert.equal(id, this.task.id); assert.equal(version, this.task.entityVersion);
    this.task.state = state; this.bump(); return this.snapshot();
  }
  async transitionTaskExecution(id, version, state) {
    assert.equal(id, this.execution.id); assert.equal(version, this.execution.version);
    this.execution.state = state; this.execution.version += 1; this.bump(); return this.snapshot();
  }
  async getTask(id) { assert.equal(id, this.task.id); return this.snapshot(); }
  async attachTaskResult(id, version, reference) {
    assert.equal(id, this.task.id); assert.equal(version, this.task.entityVersion);
    this.task.hasResult = true; this.task.resultReference = reference; this.bump();
    return { taskId: id, reference };
  }
  async recordTaskVerification(taskId, request) {
    assert.equal(taskId, this.task.id);
    const record = { ...request, taskId, createdAt: request.verifiedAt };
    this.verifications.push(record); this.bump(); return record;
  }
  bump() { this.task.entityVersion += 1; }
  snapshot() { return structuredClone({ ...this.task, executions: this.execution ? [this.execution] : [] }); }
}
