import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorizeDemoTenant, demoSession, loginSession } from './auth.mjs';
import { ReportStorage } from './storage.mjs';
import { createReportRecovery, reportRecoveryRequest } from './recovery.mjs';
import { GuardedRecovery } from '../../sdks/node/dist/index.js';

test('demo sessions resolve stable owner and tenant identities', () => {
  const request = { headers: { cookie: `rhinoq_demo_session=${loginSession('alice')}` } };
  assert.deepEqual(demoSession(request), { ownerId: 'owner-alice', tenantId: 'tenant-demo' });
  assert.equal(authorizeDemoTenant({ request, ownerId: 'owner-alice', tenantId: 'tenant-demo' }), true);
  assert.equal(authorizeDemoTenant({ request, ownerId: 'owner-bob', tenantId: 'tenant-demo' }), false);
});

test('report recovery requires preview, separate approval, readback and idempotent replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rhinoq-recovery-'));
  const state = { entityVersion: 4, state: 'uncertain', hasResult: false };
  const verifications = [];
  const tasks = {
    async getTask() { return { id: 'report-missing', ...state }; },
    async attachTaskResult(_id, version) { assert.equal(version, state.entityVersion); state.entityVersion++; state.hasResult = true; },
    async recordTaskVerification(_id, verification) { verifications.push(verification); },
    async transitionTask(_id, version, next) { assert.equal(version, state.entityVersion); state.entityVersion++; state.state = next; return this.getTask(); },
  };
  try {
    const recovery = createReportRecovery({ tasks, storage: new ReportStorage(root), GuardedRecovery });
    const preview = await recovery.execute(reportRecoveryRequest('report-missing'));
    assert.equal(preview.stage, 'previewed'); assert.equal(state.state, 'uncertain');
    await assert.rejects(recovery.execute(reportRecoveryRequest('report-missing', { confirm: true, approvedBy: 'support-agent', approvalReason: 'same actor' })), /different actor/);
    const request = reportRecoveryRequest('report-missing', { confirm: true, approvedBy: 'ops-approver', approvalReason: 'output is safe to recreate' });
    const result = await recovery.execute(request);
    assert.equal(result.stage, 'verified'); assert.equal(state.state, 'succeeded'); assert.equal(verifications[0].status, 'verified');
    const replay = await recovery.execute(request);
    assert.equal(replay.replayed, true); assert.equal(verifications.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unknown provider readback consumes recovery fence as uncertain', async () => {
  const task = { id: 'report-unknown', entityVersion: 2, state: 'uncertain', hasResult: false };
  let writes = 0;
  const recovery = createReportRecovery({
    tasks: { async getTask() { return task; } },
    storage: { async put() { writes++; return { sha256: 'written' }; }, async inspect() { return { status: 'unknown', reason: 'provider timeout' }; } },
    GuardedRecovery,
  });
  const request = reportRecoveryRequest(task.id, { confirm: true, approvedBy: 'ops-approver', approvalReason: 'approved test recovery' });
  const first = await recovery.execute(request);
  assert.equal(first.stage, 'uncertain'); assert.match(first.postCheck.evidence, /provider timeout/);
  const replay = await recovery.execute(request);
  assert.equal(replay.replayed, true); assert.equal(writes, 1, 'unknown result must not repeat provider mutation');
});

test('storage verifier distinguishes present, missing and rejects unsafe keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rhinoq-report-'));
  try {
    const storage = new ReportStorage(root);
    const written = await storage.put('report-1.json', { ok: true });
    const present = await storage.inspect('report-1.json');
    assert.equal(present.status, 'present');
    assert.equal(present.sha256, written.sha256);
    assert.deepEqual(JSON.parse(await storage.read('report-1.json')), { ok: true });
    assert.deepEqual(await storage.inspect('missing.json'), { status: 'missing' });
    assert.throws(() => storage.path('../secret.json'), /invalid report storage key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
