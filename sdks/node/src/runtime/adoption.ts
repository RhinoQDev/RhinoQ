import type { SqlExecutor } from '../postgres/producer.js';
import type { RuntimeEvent } from './contracts.js';

/** A single, deduplicated fact used to build a Shadow Mode report. */
export interface AdoptionEvent {
  eventId: string;
  kind: 'observed' | 'bound' | 'binding_created' | 'unbound' | 'unresolved';
  runtime: string;
  scope: string;
  externalId: string;
  occurredAt: string;
  replicaId?: string;
  taskId?: string;
  attempt?: number;
  uncertain?: boolean;
  terminalFailure?: boolean;
}

export interface DurableAdoptionReport {
  schemaVersion: 1;
  mode: 'observe';
  startedAt?: string;
  generatedAt: string;
  observedEvents: number;
  runtimeReferences: number;
  tasksBound: number;
  bindingsCreated: number;
  unboundEvents: number;
  unresolvedEvents: number;
  uncertainOutcomes: number;
  terminalFailures: number;
  retryAttemptsObserved: number;
  replicas: number;
}

export interface AdoptionRequirement {
  callback: 'owner' | 'tenant' | 'result' | 'verifier' | 'runtimeIdentity' | 'durableStore';
  configured: boolean; guaranteeGap: string; nextAction: string;
}
export interface AdoptionChecklistReport {
  schemaVersion: 1; generatedAt: string; durable: boolean;
  requirements: AdoptionRequirement[]; warnings: string[];
}

/** Machine-readable integration checklist suitable for rhinoq-adoption-report.json. */
export function adoptionChecklist(configured: Partial<Record<AdoptionRequirement['callback'], boolean>>): AdoptionChecklistReport {
  const definitions: Array<[AdoptionRequirement['callback'], string, string]> = [
    ['owner', 'Owner isolation cannot be proven.', 'Configure an authenticated owner resolver and run the two-owner contract test.'],
    ['tenant', 'Cross-tenant authorization cannot be proven.', 'Configure tenant authorization or document a single-tenant deployment.'],
    ['result', 'Recorded results cannot be safely downloaded.', 'Configure an owner-and-tenant-aware result resolver.'],
    ['verifier', 'Runtime success is not independent business verification.', 'Register a verifier with unknown and timeout handling.'],
    ['runtimeIdentity', 'Runtime events cannot be correlated deterministically.', 'Configure stable runtime, scope, application key and replica identity.'],
    ['durableStore', 'Adoption observations are process-local and do not aggregate across replicas.', 'Install the PostgreSQL adoption profile.'],
  ];
  const requirements = definitions.map(([callback, guaranteeGap, nextAction]) => ({ callback, configured: configured[callback] === true, guaranteeGap, nextAction }));
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), durable: configured.durableStore === true, requirements,
    warnings: requirements.filter((item) => !item.configured).map((item) => `${item.callback}: ${item.guaranteeGap}`) };
}

/**
 * Durable adoption storage is intentionally narrower than TaskClient. An
 * adopter can back it with PostgreSQL, a warehouse, or an append-only log
 * without making the runtime projector know about that provider.
 */
export interface AdoptionReportStore {
  append(event: AdoptionEvent): Promise<void>;
  snapshot(): Promise<DurableAdoptionReport>;
}

/** Useful for tests and for a deliberate single-process preview. */
export class MemoryAdoptionReportStore implements AdoptionReportStore {
  private readonly events = new Map<string, AdoptionEvent>();

  async append(event: AdoptionEvent): Promise<void> {
    validateAdoptionEvent(event);
    this.events.set(event.eventId, { ...event });
  }

  async snapshot(): Promise<DurableAdoptionReport> {
    return aggregate([...this.events.values()]);
  }
}

/** SQL required by the explicit PostgreSQL adoption-profile installation. */
export const ADOPTION_REPORT_SCHEMA_SQL = String.raw`
CREATE TABLE IF NOT EXISTS rhinoq_runtime_adoption_events (
  event_id text PRIMARY KEY CHECK (btrim(event_id) <> ''),
  kind text NOT NULL CHECK (kind IN ('observed','bound','binding_created','unbound','unresolved')),
  runtime text NOT NULL,
  runtime_scope text NOT NULL,
  external_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  task_id text,
  attempt integer CHECK (attempt IS NULL OR attempt > 0),
  uncertain boolean NOT NULL DEFAULT false,
  terminal_failure boolean NOT NULL DEFAULT false,
  replica_id text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS rhinoq_runtime_adoption_events_time_idx
  ON rhinoq_runtime_adoption_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS rhinoq_runtime_adoption_events_ref_idx
  ON rhinoq_runtime_adoption_events (runtime, runtime_scope, external_id);
`;

export async function installAdoptionReportProfile(executor: SqlExecutor): Promise<void> {
  await executor.query(ADOPTION_REPORT_SCHEMA_SQL, []);
}

/** PostgreSQL implementation; duplicate observations are ignored by event_id. */
export class PostgresAdoptionReportStore implements AdoptionReportStore {
  constructor(private readonly executor: SqlExecutor) {
    if (!executor || typeof executor.query !== 'function') {
      throw new TypeError('PostgresAdoptionReportStore requires a SQL executor');
    }
  }

  async append(event: AdoptionEvent): Promise<void> {
    validateAdoptionEvent(event);
    await this.executor.query(
      `INSERT INTO rhinoq_runtime_adoption_events
       (event_id, kind, runtime, runtime_scope, external_id, occurred_at, task_id, attempt, uncertain, terminal_failure, replica_id)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10,$11)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, event.kind, event.runtime, event.scope, event.externalId,
        event.occurredAt, event.taskId ?? null, event.attempt ?? null,
        event.uncertain === true, event.terminalFailure === true, event.replicaId ?? null],
    );
  }

  async snapshot(): Promise<DurableAdoptionReport> {
    const result = await this.executor.query<ReportRow>(
      `SELECT
         COUNT(*) FILTER (WHERE kind='observed')::bigint AS observed_events,
         COUNT(DISTINCT (runtime, runtime_scope, external_id))::bigint AS runtime_references,
         COUNT(DISTINCT task_id) FILTER (WHERE kind IN ('bound','binding_created') AND task_id IS NOT NULL)::bigint AS tasks_bound,
         COUNT(*) FILTER (WHERE kind='binding_created')::bigint AS bindings_created,
         COUNT(*) FILTER (WHERE kind='unbound')::bigint AS unbound_events,
         COUNT(*) FILTER (WHERE kind='unresolved')::bigint AS unresolved_events,
         COUNT(*) FILTER (WHERE kind='observed' AND uncertain)::bigint AS uncertain_outcomes,
         COUNT(*) FILTER (WHERE kind='observed' AND terminal_failure)::bigint AS terminal_failures,
         COUNT(DISTINCT (runtime, runtime_scope, external_id, attempt))
           FILTER (WHERE kind='observed' AND attempt > 1)::bigint AS retry_attempts_observed,
         COUNT(DISTINCT replica_id) FILTER (WHERE replica_id IS NOT NULL)::bigint AS replicas,
         MIN(occurred_at) AS started_at
       FROM rhinoq_runtime_adoption_events`, [],
    );
    const row = result.rows[0];
    return {
      schemaVersion: 1,
      mode: 'observe',
      ...(row?.started_at ? { startedAt: asIso(row.started_at) } : {}),
      generatedAt: new Date().toISOString(),
      observedEvents: number(row?.observed_events),
      runtimeReferences: number(row?.runtime_references),
      tasksBound: number(row?.tasks_bound),
      bindingsCreated: number(row?.bindings_created),
      unboundEvents: number(row?.unbound_events),
      unresolvedEvents: number(row?.unresolved_events),
      uncertainOutcomes: number(row?.uncertain_outcomes),
      terminalFailures: number(row?.terminal_failures),
      retryAttemptsObserved: number(row?.retry_attempts_observed),
      replicas: number(row?.replicas),
    };
  }
}

export function adoptionEventFromRuntime(
  event: RuntimeEvent,
  kind: Extract<AdoptionEvent['kind'], 'observed'> = 'observed',
): AdoptionEvent {
  const identity = event.eventId?.trim() || [
    event.ref.runtime, event.ref.scope, event.ref.externalId, event.type,
    event.occurredAt, event.attempt ?? '',
  ].join('|');
  return {
    eventId: `runtime:${identity}`.slice(0, 512),
    kind,
    runtime: event.ref.runtime,
    scope: event.ref.scope,
    externalId: event.ref.externalId,
    occurredAt: event.occurredAt,
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
    uncertain: event.type === 'uncertain',
    terminalFailure: event.type === 'failed' && event.terminal,
  };
}

export function validateAdoptionEvent(event: AdoptionEvent): AdoptionEvent {
  if (!event || !event.eventId?.trim()) throw new TypeError('adoption eventId is required');
  if (!event.kind || !['observed', 'bound', 'binding_created', 'unbound', 'unresolved'].includes(event.kind)) {
    throw new TypeError('adoption event kind is invalid');
  }
  for (const [field, value] of [['runtime', event.runtime], ['scope', event.scope], ['externalId', event.externalId]] as const) {
    if (!value?.trim()) throw new TypeError(`adoption ${field} is required`);
  }
  if (!Number.isFinite(Date.parse(event.occurredAt))) throw new TypeError('adoption occurredAt must be an ISO timestamp');
  if (event.attempt !== undefined && (!Number.isInteger(event.attempt) || event.attempt < 1)) {
    throw new RangeError('adoption attempt must be a positive integer');
  }
  return event;
}

interface ReportRow {
  observed_events?: number | string;
  runtime_references?: number | string;
  tasks_bound?: number | string;
  bindings_created?: number | string;
  unbound_events?: number | string;
  unresolved_events?: number | string;
  uncertain_outcomes?: number | string;
  terminal_failures?: number | string;
  retry_attempts_observed?: number | string;
  replicas?: number | string;
  started_at?: string | Date;
}

function aggregate(events: AdoptionEvent[]): DurableAdoptionReport {
  const observed = events.filter((event) => event.kind === 'observed');
  return {
    schemaVersion: 1,
    mode: 'observe',
    ...(events.length ? { startedAt: events.map((event) => event.occurredAt).sort()[0] } : {}),
    generatedAt: new Date().toISOString(),
    observedEvents: observed.length,
    runtimeReferences: new Set(events.map((event) => `${event.runtime}\0${event.scope}\0${event.externalId}`)).size,
    tasksBound: new Set(events.filter((event) => ['bound', 'binding_created'].includes(event.kind) && event.taskId).map((event) => event.taskId)).size,
    bindingsCreated: events.filter((event) => event.kind === 'binding_created').length,
    unboundEvents: events.filter((event) => event.kind === 'unbound').length,
    unresolvedEvents: events.filter((event) => event.kind === 'unresolved').length,
    uncertainOutcomes: observed.filter((event) => event.uncertain).length,
    terminalFailures: observed.filter((event) => event.terminalFailure).length,
    retryAttemptsObserved: new Set(observed.filter((event) => (event.attempt ?? 0) > 1).map((event) => `${event.runtime}\0${event.scope}\0${event.externalId}\0${event.attempt}`)).size,
    replicas: new Set(events.filter((event) => event.replicaId).map((event) => event.replicaId)).size,
  };
}

function number(value: number | string | undefined): number {
  const parsed = typeof value === 'string' ? Number(value) : value ?? 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function asIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
