export type RhinoQAutopilotMetricName =
  | 'queueLagMs'
  | 'serviceTimeMs'
  | 'cpuPercent'
  | 'rssBytes'
  | 'eventLoopLagMs'
  | 'diskFreeBytes'
  | 'provider429Rate'
  | 'retryRate'
  | 'leaseExpiryRate';

export interface RhinoQAutopilotObservation {
  schemaVersion: 1;
  observedAt: string;
  source: string;
  metrics: Partial<Record<RhinoQAutopilotMetricName, number>>;
  envelope: RhinoQAutopilotEnvelope;
}

export interface RhinoQAutopilotEnvelope {
  maxQueueLagMs?: number;
  maxServiceTimeMs?: number;
  maxCpuPercent?: number;
  maxRssBytes?: number;
  maxEventLoopLagMs?: number;
  minDiskFreeBytes?: number;
  maxProvider429Rate?: number;
  maxRetryRate?: number;
  maxLeaseExpiryRate?: number;
}

export interface RhinoQAutopilotRecommendation {
  id: string;
  metric: RhinoQAutopilotMetricName;
  value: number;
  threshold: number;
  unit: 'ms' | 'bytes' | 'percent' | 'rate';
  evidence: string;
  expectedEffect: string;
  guardrail: string;
  rollback: string;
  action: 'review';
  autoApply: false;
}

export interface RhinoQAutopilotReport {
  schemaVersion: 1;
  phase: 'observe' | 'recommend';
  observedAt: string;
  source: string;
  recommendations: readonly RhinoQAutopilotRecommendation[];
  missingMetrics: readonly RhinoQAutopilotMetricName[];
  note: 'deterministic observations only; no Task state or business outcome mutation';
}

export interface RhinoQAutopilotSimulationInput {
  report: RhinoQAutopilotReport;
  proposedChanges?: readonly { recommendationId: string; change: string }[];
}

export interface RhinoQAutopilotSimulation {
  schemaVersion: 1;
  phase: 'simulate';
  observedAt: string;
  source: string;
  recommendations: readonly {
    recommendationId: string;
    change: string;
    expectedEffect: string;
    guardrail: string;
    rollback: string;
    wouldMutate: false;
  }[];
  note: 'simulation only; no runtime, Task or business outcome mutation';
}

export interface RhinoQAutopilotCanaryPlan {
  schemaVersion: 1;
  phase: 'canary';
  source: string;
  recommendationIds: readonly string[];
  windowMs: number;
  maxTasks: number;
  approvalRequired: true;
  autoApply: false;
  rollback: string;
  note: 'canary contract only; an application-owned controller must approve and execute it';
}

export interface RhinoQAutopilotCanaryApproval {
  approvalId: string;
  approvedBy: string;
  approvedAt: string;
}

export interface RhinoQAutopilotCanaryChange {
  recommendationId: string;
  rollbackToken: string;
}

export interface RhinoQAutopilotCanaryObservation {
  healthy: boolean;
  metrics?: Partial<Record<RhinoQAutopilotMetricName, number>>;
  reason?: string;
}

export interface RhinoQAutopilotCanaryResult {
  schemaVersion: 1;
  phase: 'completed' | 'rolled_back' | 'rejected';
  plan: RhinoQAutopilotCanaryPlan;
  approval?: RhinoQAutopilotCanaryApproval;
  applied: readonly string[];
  rolledBack: boolean;
  observed?: RhinoQAutopilotCanaryObservation;
  error?: string;
  note: 'application-owned settings only; no Task state or business outcome mutation';
}

export interface RhinoQAutopilotCanaryExecutorInput {
  plan: RhinoQAutopilotCanaryPlan;
  approve(): Promise<RhinoQAutopilotCanaryApproval> | RhinoQAutopilotCanaryApproval;
  apply(
    recommendationId: string,
    context: { maxTasks: number; windowMs: number; signal: AbortSignal },
  ): Promise<RhinoQAutopilotCanaryChange> | RhinoQAutopilotCanaryChange;
  observe(
    context: { maxTasks: number; windowMs: number; signal: AbortSignal },
  ): Promise<RhinoQAutopilotCanaryObservation> | RhinoQAutopilotCanaryObservation;
  rollback(
    change: RhinoQAutopilotCanaryChange,
    context: { maxTasks: number; windowMs: number; signal: AbortSignal },
  ): Promise<void> | void;
  signal?: AbortSignal;
}

type Rule = {
  metric: RhinoQAutopilotMetricName;
  thresholdKey: keyof RhinoQAutopilotEnvelope;
  direction: 'above' | 'below';
  unit: RhinoQAutopilotRecommendation['unit'];
  id: string;
  evidence: (value: number, threshold: number) => string;
  expectedEffect: string;
  guardrail: string;
  rollback: string;
};

const RULES: readonly Rule[] = [
  rule('queueLagMs', 'maxQueueLagMs', 'above', 'ms', 'review-admission-and-worker-capacity', 'Queue lag is above the project envelope.', 'Review admission and worker capacity before accepting more work.', 'Do not change Task state or retry an uncertain effect.', 'Restore the previous admission/worker setting if queue lag or failure rate worsens.'),
  rule('serviceTimeMs', 'maxServiceTimeMs', 'above', 'ms', 'review-worker-budget', 'Service time is above the project envelope.', 'Review worker budget, external wait time and handler partitioning.', 'Keep the existing lease and retry policy unchanged until evidence is reviewed.', 'Restore the previous worker budget when service time does not improve.'),
  rule('cpuPercent', 'maxCpuPercent', 'above', 'percent', 'review-concurrency', 'CPU utilization is above the project envelope.', 'Review concurrency and admission pressure.', 'Use bounded canary changes only; never apply an unbounded scale-up.', 'Return to the previous concurrency setting if CPU saturation persists.'),
  rule('rssBytes', 'maxRssBytes', 'above', 'bytes', 'review-concurrency-and-workspace', 'RSS is above the project envelope.', 'Review concurrency, workspace sizing and artifact streaming.', 'Do not compensate for memory pressure by moving payload bytes into the queue.', 'Restore the previous concurrency or workspace limit after memory is stable.'),
  rule('eventLoopLagMs', 'maxEventLoopLagMs', 'above', 'ms', 'review-node-workload', 'Event-loop lag is above the project envelope.', 'Review synchronous work and processor placement.', 'Keep correctness decisions in the Go engine and Task handler.', 'Roll back the workload change if event-loop lag increases.'),
  rule('diskFreeBytes', 'minDiskFreeBytes', 'below', 'bytes', 'pause-large-media-admission', 'Free disk is below the project minimum.', 'Review large-media admission and workspace cleanup.', 'This is a recommendation only; it does not cancel or mutate existing Tasks.', 'Resume the previous admission level only after free space is verified.'),
  rule('provider429Rate', 'maxProvider429Rate', 'above', 'rate', 'backoff-provider-calls', 'Provider 429 rate is above the project envelope.', 'Review provider backoff and request concurrency.', 'Never replay an unknown external result; route it to uncertain/readback.', 'Restore the previous call rate after the provider error rate recovers.'),
  rule('retryRate', 'maxRetryRate', 'above', 'rate', 'review-retry-policy', 'Retry rate is above the project envelope.', 'Review failure classification and retry budget.', 'Do not change retry correctness in the SDK or retry uncertain effects.', 'Restore the previous retry setting if failures or uncertainty increase.'),
  rule('leaseExpiryRate', 'maxLeaseExpiryRate', 'above', 'rate', 'investigate-runtime-health', 'Lease expiry rate is above the project envelope.', 'Investigate runtime health, worker pauses and lease ownership.', 'Never infer business success from a lease expiry.', 'Roll back only an operational tuning change; reconcile affected executions first.'),
];

export function recommendRhinoQAutopilot(input: RhinoQAutopilotObservation): RhinoQAutopilotReport {
  validateObservation(input);
  const missingMetrics: RhinoQAutopilotMetricName[] = [];
  const recommendations: RhinoQAutopilotRecommendation[] = [];
  for (const rule of RULES) {
    const value = input.metrics[rule.metric];
    const threshold = input.envelope[rule.thresholdKey];
    if (value === undefined || threshold === undefined) {
      if (value === undefined) missingMetrics.push(rule.metric);
      continue;
    }
    const triggered = rule.direction === 'above' ? value > threshold : value < threshold;
    if (!triggered) continue;
    recommendations.push({
      id: rule.id,
      metric: rule.metric,
      value,
      threshold,
      unit: rule.unit,
      evidence: rule.evidence(value, threshold),
      expectedEffect: rule.expectedEffect,
      guardrail: rule.guardrail,
      rollback: rule.rollback,
      action: 'review',
      autoApply: false,
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    phase: recommendations.length ? 'recommend' : 'observe',
    observedAt: input.observedAt,
    source: input.source,
    recommendations: Object.freeze(recommendations),
    missingMetrics: Object.freeze([...new Set(missingMetrics)]),
    note: 'deterministic observations only; no Task state or business outcome mutation',
  });
}

/** Builds a deterministic what-if result and deliberately performs no mutation. */
export function simulateRhinoQAutopilot(input: RhinoQAutopilotSimulationInput): RhinoQAutopilotSimulation {
  validateReport(input?.report);
  const proposed = input.proposedChanges ?? input.report.recommendations.map((item) => ({ recommendationId: item.id, change: item.expectedEffect }));
  const known = new Map(input.report.recommendations.map((item) => [item.id, item]));
  const recommendations = proposed.slice(0, 100).map((item) => {
    if (!item?.recommendationId?.trim() || !item.change?.trim()) throw new TypeError('Autopilot simulation changes require recommendationId and change');
    const recommendation = known.get(item.recommendationId);
    if (!recommendation) throw new TypeError(`Autopilot simulation references unknown recommendation ${JSON.stringify(item.recommendationId)}`);
    return {
      recommendationId: recommendation.id,
      change: item.change.trim().slice(0, 500),
      expectedEffect: recommendation.expectedEffect,
      guardrail: recommendation.guardrail,
      rollback: recommendation.rollback,
      wouldMutate: false as const,
    };
  });
  return Object.freeze({
    schemaVersion: 1,
    phase: 'simulate' as const,
    observedAt: input.report.observedAt,
    source: input.report.source,
    recommendations: Object.freeze(recommendations),
    note: 'simulation only; no runtime, Task or business outcome mutation' as const,
  });
}

/** Creates a bounded approval artifact; it is not an executor or auto-mutator. */
export function planRhinoQAutopilotCanary(input: {
  report: RhinoQAutopilotReport;
  recommendationIds?: readonly string[];
  windowMs?: number;
  maxTasks?: number;
}): RhinoQAutopilotCanaryPlan {
  validateReport(input?.report);
  const windowMs = input.windowMs ?? 15 * 60_000;
  const maxTasks = input.maxTasks ?? 100;
  if (!Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 24 * 60 * 60_000) throw new RangeError('Autopilot canary windowMs must be 1000..86400000');
  if (!Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > 10_000) throw new RangeError('Autopilot canary maxTasks must be 1..10000');
  const known = new Set(input.report.recommendations.map((item) => item.id));
  const recommendationIds = [...new Set(input.recommendationIds ?? [...known])].slice(0, 100);
  if (recommendationIds.some((id) => !known.has(id))) throw new TypeError('Autopilot canary references an unknown recommendation');
  return Object.freeze({
    schemaVersion: 1,
    phase: 'canary' as const,
    source: input.report.source,
    recommendationIds: Object.freeze(recommendationIds),
    windowMs,
    maxTasks,
    approvalRequired: true as const,
    autoApply: false as const,
    rollback: 'Restore the prior application-owned setting and reconcile affected executions before widening the canary.',
    note: 'canary contract only; an application-owned controller must approve and execute it' as const,
  });
}

/**
 * Executes only an explicitly approved, bounded canary. The application owns
 * the setting adapter, observation and rollback implementation; this helper
 * never claims, retries or mutates Task/business state.
 */
export async function executeRhinoQAutopilotCanary(
  input: RhinoQAutopilotCanaryExecutorInput,
): Promise<RhinoQAutopilotCanaryResult> {
  validateCanaryPlan(input?.plan);
  if (typeof input?.approve !== 'function' || typeof input?.apply !== 'function' || typeof input?.observe !== 'function' || typeof input?.rollback !== 'function') {
    throw new TypeError('Autopilot canary requires approve, apply, observe and rollback handlers');
  }
  if (input.signal?.aborted) throw new Error('Autopilot canary was cancelled before approval');

  let approval: RhinoQAutopilotCanaryApproval;
  try {
    approval = validateCanaryApproval(await input.approve());
  } catch (error) {
    return canaryResult(input.plan, 'rejected', [], false, undefined, errorMessage(error));
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const context = { maxTasks: input.plan.maxTasks, windowMs: input.plan.windowMs, signal: controller.signal };
  const deadlineAt = Date.now() + input.plan.windowMs;
  const deadlineTimer = setTimeout(() => controller.abort(new Error('Autopilot canary window expired')), input.plan.windowMs);
  const changes: RhinoQAutopilotCanaryChange[] = [];
  try {
    for (const recommendationId of input.plan.recommendationIds) {
      if (controller.signal.aborted) throw new Error('Autopilot canary was cancelled');
      const change = validateCanaryChange(await runCanaryOperation(() => input.apply(recommendationId, context), controller.signal, deadlineAt), recommendationId);
      changes.push(change);
    }
    if (controller.signal.aborted) throw new Error('Autopilot canary window expired');
    const observed = validateCanaryObservation(await runCanaryOperation(() => input.observe(context), controller.signal, deadlineAt));
    if (!observed.healthy) {
      await rollbackCanaryChanges(changes, input.rollback, { ...context, signal: new AbortController().signal });
      return canaryResult(input.plan, 'rolled_back', changes.map((item) => item.recommendationId), true, observed, observed.reason || 'canary health gate failed', approval);
    }
    return canaryResult(input.plan, 'completed', changes.map((item) => item.recommendationId), false, observed, undefined, approval);
  } catch (error) {
    await rollbackCanaryChanges(changes, input.rollback, { ...context, signal: new AbortController().signal });
    return canaryResult(input.plan, 'rolled_back', changes.map((item) => item.recommendationId), changes.length > 0, undefined, errorMessage(error), approval);
  } finally {
    clearTimeout(deadlineTimer);
    input.signal?.removeEventListener('abort', onAbort);
  }
}

async function runCanaryOperation<T>(
  operation: () => Promise<T> | T,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<T> {
  if (signal.aborted) throw new Error('Autopilot canary was cancelled');
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error('Autopilot canary window expired');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Autopilot canary window expired')), remainingMs);
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Autopilot canary was cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function rollbackCanaryChanges(
  changes: readonly RhinoQAutopilotCanaryChange[],
  rollback: RhinoQAutopilotCanaryExecutorInput['rollback'],
  context: { maxTasks: number; windowMs: number; signal: AbortSignal },
): Promise<void> {
  for (const change of [...changes].reverse()) await rollback(change, context);
}

function canaryResult(
  plan: RhinoQAutopilotCanaryPlan,
  phase: RhinoQAutopilotCanaryResult['phase'],
  applied: readonly string[],
  rolledBack: boolean,
  observed?: RhinoQAutopilotCanaryObservation,
  error?: string,
  approval?: RhinoQAutopilotCanaryApproval,
): RhinoQAutopilotCanaryResult {
  return Object.freeze({
    schemaVersion: 1 as const, phase, plan, approval, applied: Object.freeze([...applied]), rolledBack, observed, error,
    note: 'application-owned settings only; no Task state or business outcome mutation' as const,
  });
}

function rule(
  metric: Rule['metric'],
  thresholdKey: Rule['thresholdKey'],
  direction: Rule['direction'],
  unit: Rule['unit'],
  id: string,
  evidenceLabel: string,
  expectedEffect: string,
  guardrail: string,
  rollback: string,
): Rule {
  return {
    metric, thresholdKey, direction, unit, id,
    evidence: (value, threshold) => `${evidenceLabel} observed=${value} threshold=${threshold}.`,
    expectedEffect, guardrail, rollback,
  };
}

function validateObservation(input: RhinoQAutopilotObservation): void {
  if (!input || input.schemaVersion !== 1) throw new TypeError('Autopilot observation schemaVersion must be 1');
  if (!input.source?.trim()) throw new TypeError('Autopilot observation source is required');
  if (!Number.isFinite(Date.parse(input.observedAt))) throw new TypeError('Autopilot observation observedAt must be an ISO timestamp');
  if (!input.metrics || typeof input.metrics !== 'object') throw new TypeError('Autopilot observation metrics are required');
  if (!input.envelope || typeof input.envelope !== 'object') throw new TypeError('Autopilot observation envelope is required');
  for (const value of Object.values(input.metrics)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new RangeError('Autopilot metrics must be finite and non-negative');
  }
  for (const value of Object.values(input.envelope)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new RangeError('Autopilot thresholds must be finite and non-negative');
  }
}

function validateReport(input: RhinoQAutopilotReport): void {
  if (!input || input.schemaVersion !== 1 || !['observe', 'recommend'].includes(input.phase)) throw new TypeError('Autopilot report must be a schemaVersion 1 observe/recommend report');
  if (!input.source?.trim()) throw new TypeError('Autopilot report source is required');
  if (!Array.isArray(input.recommendations)) throw new TypeError('Autopilot report recommendations are required');
}

function validateCanaryPlan(input: RhinoQAutopilotCanaryPlan): void {
  if (!input || input.schemaVersion !== 1 || input.phase !== 'canary' || input.approvalRequired !== true || input.autoApply !== false) {
    throw new TypeError('Autopilot canary plan must require approval and disable autoApply');
  }
  if (!Array.isArray(input.recommendationIds) || input.recommendationIds.length > 100) throw new RangeError('Autopilot canary recommendationIds must contain at most 100 items');
  if (!Number.isSafeInteger(input.windowMs) || input.windowMs < 1_000 || input.windowMs > 24 * 60 * 60_000) throw new RangeError('Autopilot canary windowMs must be 1000..86400000');
  if (!Number.isSafeInteger(input.maxTasks) || input.maxTasks < 1 || input.maxTasks > 10_000) throw new RangeError('Autopilot canary maxTasks must be 1..10000');
}

function validateCanaryApproval(input: RhinoQAutopilotCanaryApproval): RhinoQAutopilotCanaryApproval {
  if (!input?.approvalId?.trim() || !input.approvedBy?.trim() || !Number.isFinite(Date.parse(input.approvedAt))) throw new TypeError('Autopilot canary approval requires approvalId, approvedBy and an ISO timestamp');
  return { approvalId: input.approvalId.trim().slice(0, 256), approvedBy: input.approvedBy.trim().slice(0, 256), approvedAt: input.approvedAt };
}

function validateCanaryChange(input: RhinoQAutopilotCanaryChange, recommendationId: string): RhinoQAutopilotCanaryChange {
  if (!input?.rollbackToken?.trim() || input.recommendationId !== recommendationId) throw new TypeError(`Autopilot canary apply must return a rollback token for ${recommendationId}`);
  return { recommendationId, rollbackToken: input.rollbackToken.trim().slice(0, 512) };
}

function validateCanaryObservation(input: RhinoQAutopilotCanaryObservation): RhinoQAutopilotCanaryObservation {
  if (!input || typeof input.healthy !== 'boolean') throw new TypeError('Autopilot canary observation must include healthy');
  for (const value of Object.values(input.metrics ?? {})) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new RangeError('Autopilot canary metrics must be finite and non-negative');
  return { healthy: input.healthy, metrics: input.metrics, reason: input.reason?.trim().slice(0, 500) };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
