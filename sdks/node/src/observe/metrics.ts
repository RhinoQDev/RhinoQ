/**
 * Counters and a health probe for the embedded path.
 *
 * The Gateway exposes /metrics and /healthz. An application that adopted the
 * embedded PostgreSQL Task client has no Gateway, and therefore had no
 * equivalent at all — the one regression the Task-only profile introduced.
 *
 * This deliberately exposes counters and a reachability probe and nothing
 * more. No latency histogram, no throughput figure, no derived rate: RhinoQ's
 * Definition of Done forbids publishing a performance number without the
 * benchmark behind it, and a library that ships a p99 gauge is publishing one.
 * Counting what happened is not a claim about how fast it happened.
 */

/** Counter names the SDK emits. Applications may record their own. */
export type TaskMetricName =
  | 'rhinoq_task_created_total'
  | 'rhinoq_task_transitioned_total'
  | 'rhinoq_task_execution_transitioned_total'
  | 'rhinoq_task_progress_reported_total'
  | 'rhinoq_task_cancellation_resolved_total'
  | 'rhinoq_bridge_event_projected_total'
  | 'rhinoq_bridge_projection_failed_total'
  | 'rhinoq_task_execution_retried_total'
  | 'rhinoq_task_items_settled_total'
  | 'rhinoq_reconciler_sweep_skipped_total'
  | 'rhinoq_reconciler_sweep_failed_total'
  | 'rhinoq_reconciler_task_selected_total'
  | 'rhinoq_reconciler_task_reconciled_total'
  | 'rhinoq_reconciler_task_failed_total'
  | 'rhinoq_bridge_version_conflict_total'
  /**
   * A projector lease lost without being released — a database failover or a
   * killed session. Non-zero means some window had no owner for that scope,
   * and possibly two. Alert on it.
   */
  | 'rhinoq_bridge_lease_lost_total';

export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricSample {
  name: string;
  labels: MetricLabels;
  value: number;
}

/**
 * A minimal counter registry. It holds no timers and starts nothing, so
 * creating one in a request handler or a test is free and it never keeps a
 * process alive.
 */
export class TaskMetrics {
  private readonly counters = new Map<string, { name: string; labels: MetricLabels; value: number }>();

  increment(name: TaskMetricName | (string & {}), labels: MetricLabels = {}, by = 1): void {
    if (!Number.isFinite(by)) {
      throw new TypeError('metric increment must be finite');
    }
    const key = seriesKey(name, labels);
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += by;
      return;
    }
    this.counters.set(key, { name, labels: { ...labels }, value: by });
  }

  /** Current values, sorted so two snapshots are comparable and diffable. */
  snapshot(): MetricSample[] {
    return [...this.counters.values()]
      .map((counter) => ({ name: counter.name, labels: counter.labels, value: counter.value }))
      .sort((left, right) => seriesKey(left.name, left.labels).localeCompare(seriesKey(right.name, right.labels)));
  }

  reset(): void {
    this.counters.clear();
  }

  /**
   * Prometheus text exposition, so an application can serve these on its own
   * /metrics route without a client library. Every series is a counter; there
   * is nothing else to declare.
   */
  render(): string {
    const lines: string[] = [];
    let lastName = '';
    for (const sample of this.snapshot()) {
      if (sample.name !== lastName) {
        lines.push(`# TYPE ${sample.name} counter`);
        lastName = sample.name;
      }
      lines.push(`${sample.name}${renderLabels(sample.labels)} ${sample.value}`);
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }
}

function seriesKey(name: string, labels: MetricLabels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key] ?? ''}`);
  return `${name}{${parts.join(',')}}`;
}

function renderLabels(labels: MetricLabels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) {
    return '';
  }
  const rendered = keys.map((key) => `${key}="${escapeLabelValue(labels[key] ?? '')}"`);
  return `{${rendered.join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface EmbeddedHealth {
  status: HealthStatus;
  /** The Task schema version found in the database, or 0 when unreadable. */
  schemaVersion: number;
  /** The version this SDK requires. */
  expectedSchemaVersion: number;
  /** What to do about it. Empty when status is ok. */
  detail: string;
}

/** The narrow query surface the probe needs; any pg Pool or Client satisfies it. */
export interface HealthQueryable {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Answers the question a Gateway /healthz answered: can this process reach
 * PostgreSQL, and is the Task schema the one this SDK speaks?
 *
 * It reports rather than throws, because a health endpoint that throws is a
 * health endpoint that returns 500 for both "the database is gone" and "the
 * probe has a bug", and an operator cannot tell those apart at 3am.
 *
 * A schema mismatch is `degraded`, not `down`: the process is alive and the
 * fix is a migration, which is a different page than a dead database.
 */
export async function checkEmbeddedHealth(
  pool: HealthQueryable,
  expectedSchemaVersion: number,
): Promise<EmbeddedHealth> {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    return {
      status: 'down',
      schemaVersion: 0,
      expectedSchemaVersion,
      detail: `PostgreSQL is unreachable: ${message(error)}`,
    };
  }
  let installed = 0;
  try {
    const result = await pool.query(
      'SELECT COALESCE(MAX(version),0)::int AS version FROM rhinoq_task.migrations',
    );
    installed = Number(result.rows[0]?.version ?? 0);
  } catch (error) {
    return {
      status: 'degraded',
      schemaVersion: 0,
      expectedSchemaVersion,
      detail: `the RhinoQ Task schema is not installed: ${message(error)}. Run: npx rhinoq init`,
    };
  }
  if (installed !== expectedSchemaVersion) {
    return {
      status: 'degraded',
      schemaVersion: installed,
      expectedSchemaVersion,
      detail: `the Task schema is v${installed} and this SDK speaks v${expectedSchemaVersion}. Run: npx rhinoq init`,
    };
  }
  return { status: 'ok', schemaVersion: installed, expectedSchemaVersion, detail: '' };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
