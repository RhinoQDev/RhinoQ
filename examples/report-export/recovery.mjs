/** Application-owned recovery: RhinoQ supplies the guardrails, storage remains the provider. */
export function createReportRecovery({ tasks, storage, GuardedRecovery, ledger }) {
  if (typeof GuardedRecovery !== 'function') throw new TypeError('createReportRecovery requires RhinoQ GuardedRecovery');
  const plans = new Map();
  const port = {
    async proposeRepair(request) {
      if (plans.has(request.id)) throw new Error('repair already exists');
      const now = new Date().toISOString();
      const plan = { ...request, state: 'proposed', proposedBy: request.actor, version: 1, createdAt: now, updatedAt: now };
      plans.set(request.id, plan); return plan;
    },
    async previewRepair(id) {
      const current = requirePlan(plans, id);
      const task = await tasks.getTask(current.parameters.taskId);
      if (task.state !== 'uncertain' || task.hasResult) throw new Error('repair precondition changed');
      const plan = { ...current, state: 'previewed', version: current.version + 1,
        preview: `Create ${current.parameters.key}, attach its private result reference and verify readback`,
        precondition: 'Task remains uncertain and has no result reference' };
      plans.set(id, plan); return plan;
    },
    async approveRepair(id, actor, reason) {
      const current = requirePlan(plans, id);
      const plan = { ...current, state: 'approved', approvedBy: actor, approvalReason: reason, version: current.version + 1 };
      plans.set(id, plan); return plan;
    },
    async executeRepair(id) {
      const current = requirePlan(plans, id);
      const { taskId, key } = current.parameters;
      const task = await tasks.getTask(taskId);
      if (task.state !== 'uncertain' || task.hasResult) throw new Error('repair precondition changed');
      const written = await storage.put(key, { reportId: taskId, recoveredAt: new Date().toISOString() });
      const observed = await storage.inspect(key);
      if (observed.status !== 'present' || observed.sha256 !== written.sha256) {
        throw new Error(observed.status === 'unknown' ? `readback unknown: ${observed.reason}` : 'readback did not confirm output');
      }
      await tasks.attachTaskResult(taskId, task.entityVersion, `report://${key}`);
      await tasks.recordTaskVerification(taskId, { id: `${taskId}:recovery-output`, verifier: 'report-output-exists', status: 'verified', summary: 'Recovered report exists and checksum matches.', evidence: { sha256: observed.sha256, size: observed.size } });
      const verified = await tasks.getTask(taskId);
      await tasks.transitionTask(taskId, verified.entityVersion, 'succeeded');
      const plan = { ...current, state: 'succeeded', outcome: 'output created and independently read back', version: current.version + 1 };
      plans.set(id, plan); return plan;
    },
  };
  return new GuardedRecovery(port, {
    ...(ledger ? { ledger } : {}),
    async postCheck(plan) {
      const task = await tasks.getTask(plan.parameters.taskId);
      const observed = await storage.inspect(plan.parameters.key);
      return task.state === 'succeeded' && task.hasResult && observed.status === 'present'
        ? { status: 'verified', evidence: `Task succeeded; output checksum ${observed.sha256}` }
        : { status: observed.status === 'missing' ? 'failed' : 'unknown', evidence: `Task=${task.state}; output=${observed.status}` };
    },
  });
}

export function reportRecoveryRequest(taskId, options = {}) {
  return {
    finding: { ruleId: 'report-output-exists', subjectType: 'task', subjectId: taskId, invariantVersion: 1 },
    handler: 'report.create-missing-output', parameters: { taskId, key: `${taskId}.json` },
    idempotencyKey: `report-recovery:${taskId}:v1`, requestedBy: options.requestedBy ?? 'support-agent',
    ...(options.confirm ? { confirm: true, approvedBy: options.approvedBy, approvalReason: options.approvalReason } : {}),
  };
}

function requirePlan(plans, id) {
  const plan = plans.get(id);
  if (!plan) throw new Error('repair plan not found');
  return plan;
}
