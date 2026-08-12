import { createHash } from 'node:crypto';
import type { FindingKey, RepairRecord } from '../gateway/types.js';
import type { SqlExecutor } from '../postgres/producer.js';

export interface GuardedRecoveryPort {
  proposeRepair(request: {
    id: string;
    finding: FindingKey;
    handler: string;
    parameters?: unknown;
    actor: string;
  }): Promise<RepairRecord>;
  previewRepair(id: string): Promise<RepairRecord>;
  approveRepair(id: string, actor: string, reason: string): Promise<RepairRecord>;
  executeRepair(id: string): Promise<RepairRecord>;
}

export interface GuardedRecoveryRequest {
  finding: FindingKey;
  handler: string;
  parameters?: unknown;
  idempotencyKey: string;
  requestedBy: string;
  approvedBy?: string;
  approvalReason?: string;
  /** Preview is the default. Execution requires an explicit confirmation. */
  confirm?: boolean;
}

export interface RecoveryPostCheck {
  (record: RepairRecord): Promise<{
    status: 'verified' | 'failed' | 'unknown';
    evidence: string;
  }>;
}

export interface GuardedRecoveryResult {
  idempotencyKey: string;
  repairId: string;
  stage: 'previewed' | 'verified' | 'failed' | 'uncertain';
  plan: RepairRecord;
  postCheck?: { status: 'verified' | 'failed' | 'unknown'; evidence: string };
  replayed?: boolean;
}

export interface RecoveryLedger {
  begin(key: string, fingerprint: string): Promise<{ state: 'running' | 'completed'; result?: GuardedRecoveryResult } | undefined>;
  complete(key: string, fingerprint: string, result: GuardedRecoveryResult): Promise<void>;
}

export class RecoveryInProgressError extends Error {
  readonly code = 'RHINOQ_RECOVERY_IN_PROGRESS';
  constructor(key: string) {
    super(`recovery idempotency key ${JSON.stringify(key)} is already running`);
    this.name = 'RecoveryInProgressError';
  }
}

/** Single-process ledger useful for tests; production should use the SQL ledger. */
export class MemoryRecoveryLedger implements RecoveryLedger {
  private readonly records = new Map<string, { fingerprint: string; state: 'running' | 'completed'; result?: GuardedRecoveryResult }>();

  async begin(key: string, fingerprint: string): Promise<{ state: 'running' | 'completed'; result?: GuardedRecoveryResult } | undefined> {
    const current = this.records.get(key);
    if (!current) {
      this.records.set(key, { fingerprint, state: 'running' });
      return undefined;
    }
    if (current.fingerprint !== fingerprint) throw new TypeError('recovery idempotency key was reused with different repair parameters');
    return { state: current.state, ...(current.result ? { result: current.result } : {}) };
  }

  async complete(key: string, fingerprint: string, result: GuardedRecoveryResult): Promise<void> {
    const current = this.records.get(key);
    if (current && current.fingerprint !== fingerprint) throw new TypeError('recovery idempotency key was reused with different repair parameters');
    this.records.set(key, { fingerprint, state: 'completed', result });
  }
}

export const RECOVERY_LEDGER_SCHEMA_SQL = String.raw`
CREATE TABLE IF NOT EXISTS rhinoq_recovery_idempotency (
  idempotency_key text PRIMARY KEY CHECK (btrim(idempotency_key) <> ''),
  fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('running','completed')),
  result jsonb,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz
);
`;

export async function installRecoveryLedgerProfile(executor: SqlExecutor): Promise<void> {
  await executor.query(RECOVERY_LEDGER_SCHEMA_SQL, []);
}

export class PostgresRecoveryLedger implements RecoveryLedger {
  constructor(private readonly executor: SqlExecutor) {
    if (!executor || typeof executor.query !== 'function') throw new TypeError('PostgresRecoveryLedger requires a SQL executor');
  }

  async begin(key: string, fingerprint: string): Promise<{ state: 'running' | 'completed'; result?: GuardedRecoveryResult } | undefined> {
    const inserted = await this.executor.query<{ fingerprint: string; state: 'running' | 'completed'; result?: GuardedRecoveryResult }>(
      `INSERT INTO rhinoq_recovery_idempotency (idempotency_key, fingerprint, state)
       VALUES ($1,$2,'running') ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING fingerprint, state, result`, [key, fingerprint]);
    if (inserted.rows[0]) return undefined;
    const existing = await this.executor.query<{ fingerprint: string; state: 'running' | 'completed'; result?: GuardedRecoveryResult }>(
      `SELECT fingerprint, state, result FROM rhinoq_recovery_idempotency WHERE idempotency_key=$1`, [key]);
    const row = existing.rows[0];
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new TypeError('recovery idempotency key was reused with different repair parameters');
    return { state: row.state, ...(row.result ? { result: row.result } : {}) };
  }

  async complete(key: string, fingerprint: string, value: GuardedRecoveryResult): Promise<void> {
    const updated = await this.executor.query(
      `UPDATE rhinoq_recovery_idempotency
       SET state='completed', result=$3::jsonb, completed_at=clock_timestamp()
       WHERE idempotency_key=$1 AND fingerprint=$2 AND state='running'
       RETURNING idempotency_key`,
      [key, fingerprint, JSON.stringify(value)],
    );
    if (updated.rows.length === 0) throw new Error('recovery idempotency ledger completion lost its running fence');
  }
}

/**
 * Preview-first recovery orchestration. The mutation itself remains an
 * allow-listed server handler; this class supplies the client-side guardrail
 * and refuses to call execute without a fresh preview, approval and post-check.
 */
export class GuardedRecovery {
  private readonly ledger: RecoveryLedger;
  private readonly postCheck: RecoveryPostCheck;

  constructor(
    private readonly port: GuardedRecoveryPort,
    options: { ledger?: RecoveryLedger; postCheck: RecoveryPostCheck },
  ) {
    if (!port || typeof port.proposeRepair !== 'function' || typeof port.previewRepair !== 'function' ||
        typeof port.approveRepair !== 'function' || typeof port.executeRepair !== 'function') {
      throw new TypeError('GuardedRecovery requires a complete recovery port');
    }
    if (typeof options?.postCheck !== 'function') throw new TypeError('GuardedRecovery requires a postCheck callback');
    this.ledger = options.ledger ?? new MemoryRecoveryLedger();
    this.postCheck = options.postCheck;
  }

  async preview(request: GuardedRecoveryRequest): Promise<GuardedRecoveryResult> {
    validateRequest(request);
    const repairId = repairIdFor(request);
    let proposed: RepairRecord;
    try {
      proposed = await this.port.proposeRepair({
        id: repairId, finding: request.finding, handler: request.handler,
        parameters: normalizedParameters(request),
        actor: request.requestedBy,
      });
    } catch (error) {
      if (!alreadyExists(error)) throw error;
      // The deterministic repair ID is the durable idempotency boundary. The
      // server's preview endpoint is the readback for an already-created plan.
      proposed = { id: repairId, finding: request.finding, handler: request.handler,
        parameters: normalizedParameters(request),
        state: 'proposed', proposedBy: request.requestedBy, version: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    }
    const plan = await this.port.previewRepair(proposed.id);
    if (plan.handler !== request.handler ||
        plan.finding.ruleId !== request.finding.ruleId ||
        plan.finding.subjectType !== request.finding.subjectType ||
        plan.finding.subjectId !== request.finding.subjectId ||
        plan.finding.invariantVersion !== request.finding.invariantVersion ||
        JSON.stringify(plan.parameters) !== JSON.stringify(normalizedParameters(request))) {
      throw new TypeError('recovery idempotency key was reused with different repair parameters');
    }
    if (!plan.preview?.trim() || !plan.precondition?.trim()) {
      throw new Error('recovery preview did not return a precondition and change summary');
    }
    return { idempotencyKey: request.idempotencyKey, repairId: plan.id, stage: 'previewed', plan };
  }

  async execute(request: GuardedRecoveryRequest): Promise<GuardedRecoveryResult> {
    validateRequest(request);
    if (request.confirm !== true) return this.preview(request);
    if (!request.approvedBy?.trim() || !request.approvalReason?.trim()) {
      throw new TypeError('confirmed recovery requires approvedBy and approvalReason');
    }
    if (request.approvedBy.trim() === request.requestedBy.trim()) {
      throw new TypeError('recovery approval must be made by a different actor');
    }
    const fingerprint = fingerprintFor(request);
    const existing = await this.ledger.begin(request.idempotencyKey.trim(), fingerprint);
    if (existing?.state === 'completed' && existing.result) return { ...existing.result, replayed: true };
    if (existing?.state === 'running') throw new RecoveryInProgressError(request.idempotencyKey);
    let preview: GuardedRecoveryResult;
    try {
      preview = await this.preview(request);
    } catch (error) {
      return this.finishUncertain(request, fingerprint, repairIdFor(request), error);
    }
    let plan: RepairRecord;
    try {
      await this.port.approveRepair(preview.repairId, request.approvedBy, request.approvalReason);
      plan = await this.port.executeRepair(preview.repairId);
    } catch (error) {
      // The mutation may have crossed the server boundary before its response
      // was lost. Consume the idempotency fence as uncertain so a caller never
      // issues a blind second mutation; reconciliation can inspect the repair
      // row and provider evidence before a new key is chosen.
      return this.finishUncertain(request, fingerprint, preview.repairId, error, preview.plan);
    }
    let postCheck: GuardedRecoveryResult['postCheck'];
    try {
      postCheck = await this.postCheck(plan);
    } catch (error) {
      postCheck = { status: 'unknown', evidence: error instanceof Error ? error.message : String(error) };
    }
    const stage: GuardedRecoveryResult['stage'] = plan.state === 'succeeded' && postCheck.status === 'verified'
      ? 'verified' : postCheck.status === 'failed' || plan.state === 'failed' ? 'failed' : 'uncertain';
    const result: GuardedRecoveryResult = {
      idempotencyKey: request.idempotencyKey, repairId: plan.id, stage, plan, postCheck,
    };
    await this.ledger.complete(request.idempotencyKey.trim(), fingerprint, result);
    return result;
  }

  private async finishUncertain(
    request: GuardedRecoveryRequest,
    fingerprint: string,
    repairId: string,
    error: unknown,
    existingPlan?: RepairRecord,
  ): Promise<GuardedRecoveryResult> {
    const plan = existingPlan ?? {
      id: repairId,
      finding: request.finding,
      handler: request.handler,
      parameters: normalizedParameters(request),
      state: 'uncertain' as const,
      proposedBy: request.requestedBy,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result: GuardedRecoveryResult = {
      idempotencyKey: request.idempotencyKey,
      repairId,
      stage: 'uncertain',
      plan,
      postCheck: {
        status: 'unknown',
        evidence: error instanceof Error ? error.message : String(error),
      },
    };
    await this.ledger.complete(request.idempotencyKey.trim(), fingerprint, result);
    return result;
  }
}

function validateRequest(request: GuardedRecoveryRequest): void {
  if (!request?.idempotencyKey?.trim()) throw new TypeError('recovery idempotencyKey is required');
  if (!request.requestedBy?.trim()) throw new TypeError('recovery requestedBy is required');
  if (!request.handler?.trim()) throw new TypeError('recovery handler is required');
  if (!request.finding?.ruleId?.trim() || !request.finding.subjectType?.trim() || !request.finding.subjectId?.trim()) {
    throw new TypeError('recovery finding identity is required');
  }
}

function repairIdFor(request: GuardedRecoveryRequest): string {
  return `repair_${createHash('sha256').update(request.idempotencyKey.trim()).digest('hex').slice(0, 40)}`;
}

function fingerprintFor(request: GuardedRecoveryRequest): string {
  return JSON.stringify({ key: request.idempotencyKey.trim(), finding: request.finding, handler: request.handler, parameters: normalizedParameters(request) });
}

function normalizedParameters(request: GuardedRecoveryRequest): unknown {
  return request.parameters === undefined ? {} : request.parameters;
}

function alreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|duplicate|unique|conflict/i.test(message) ||
    (typeof error === 'object' && error !== null && 'code' in error && ['RHINOQ_ALREADY_EXISTS', '23505', '409'].includes(String(error.code)));
}
