import type { TaskState, TaskSummary } from '../gateway/types.js';
import type { TaskStateQuery } from '../postgres/task-client.js';

export type RhinoQTerminalSeverity = 'info' | 'warning' | 'error';
export type RhinoQTerminalEventKind =
  | 'accepted'
  | 'running'
  | 'progress'
  | 'retry'
  | 'succeeded'
  | 'failed'
  | 'uncertain'
  | 'cancellation'
  | 'cancelled';

export interface RhinoQTerminalEvent {
  schemaVersion: 1;
  kind: RhinoQTerminalEventKind;
  severity: RhinoQTerminalSeverity;
  taskId: string;
  taskType: string;
  state: TaskState;
  entityVersion: number;
  observedAt: string;
  summary: string;
  nextAction?: string;
  progress?: { completed: number; total?: number; message?: string };
  retryCount?: number;
}

export interface RhinoQTerminalIncidentGroup {
  schemaVersion: 1;
  fingerprint: string;
  severity: RhinoQTerminalSeverity;
  kind: RhinoQTerminalEventKind;
  taskType: string;
  count: number;
  taskIds: readonly string[];
  summary: string;
  nextAction?: string;
  observedAt: string;
}

export interface RhinoQTaskSummarySource {
  listTasksByState(query: TaskStateQuery): Promise<TaskSummary[]>;
}

export interface RhinoQChangeHintSource {
  subscribe(listener: () => void): () => void;
  connected?: boolean;
}

export interface RhinoQTaskWatchOptions {
  states?: readonly TaskState[];
  taskType?: string;
  minimumSeverity?: RhinoQTerminalSeverity;
  pollIntervalMs?: number;
  limit?: number;
  initial?: 'attention' | 'all' | 'none';
  once?: boolean;
  signal?: AbortSignal;
  changes?: RhinoQChangeHintSource;
}

const ALL_STATES: readonly TaskState[] = [
  'pending', 'queued', 'running', 'uncertain', 'succeeded', 'failed',
  'cancel_requested', 'cancelled',
];
const SEVERITY_RANK: Record<RhinoQTerminalSeverity, number> = { info: 0, warning: 1, error: 2 };

/**
 * Reads authoritative summaries after a best-effort change hint. A bounded
 * poll remains the safety net because LISTEN/NOTIFY can be lost on reconnect.
 */
export async function* watchRhinoQTasks(
  source: RhinoQTaskSummarySource,
  options: RhinoQTaskWatchOptions = {},
): AsyncGenerator<readonly RhinoQTerminalIncidentGroup[], void, void> {
  if (!source || typeof source.listTasksByState !== 'function') throw new TypeError('RhinoQ watch requires listTasksByState()');
  const states = [...new Set(options.states ?? ALL_STATES)];
  if (!states.length) throw new RangeError('RhinoQ watch requires at least one state');
  const pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 1_000, 100, 60_000, 'pollIntervalMs');
  const limit = boundedInteger(options.limit ?? 500, 1, 500, 'limit');
  const previous = new Map<string, TaskSummary>();
  let first = true;
  while (!options.signal?.aborted) {
    const summaries = await source.listTasksByState({ states, limit });
    const events: RhinoQTerminalEvent[] = [];
    for (const summary of summaries) {
      if (options.taskType && summary.type !== options.taskType) continue;
      const prior = previous.get(summary.id);
      previous.set(summary.id, summary);
      if (prior && summary.entityVersion <= prior.entityVersion) continue;
      const event = projectRhinoQTerminalEvent(summary, prior);
      if (first && options.initial === 'none') continue;
      if (first && (options.initial ?? 'attention') === 'attention' && event.severity === 'info') continue;
      if (options.minimumSeverity && SEVERITY_RANK[event.severity] < SEVERITY_RANK[options.minimumSeverity]) continue;
      events.push(event);
    }
    first = false;
    if (events.length) yield groupRhinoQTerminalEvents(events);
    if (options.once) return;
    await waitForChangeOrPoll(options.changes, pollIntervalMs, options.signal);
  }
}

export function projectRhinoQTerminalEvent(current: TaskSummary, previous?: TaskSummary): RhinoQTerminalEvent {
  const retries = current.itemCounts?.retries ?? Math.max(0, current.executionCounts.total - (current.itemCounts?.total ?? current.executionCounts.total));
  const priorRetries = previous?.itemCounts?.retries ?? 0;
  let kind: RhinoQTerminalEventKind;
  let severity: RhinoQTerminalSeverity = 'info';
  let summary: string;
  let nextAction: string | undefined;
  if (current.state === 'uncertain') {
    kind = 'uncertain'; severity = 'error';
    summary = 'External or business outcome is not confirmed; blind retry is unsafe.';
    nextAction = `rhinoq inspect ${current.id}`;
  } else if (current.state === 'failed') {
    kind = 'failed'; severity = 'error';
    summary = 'Task failed; inspect attempt and effect evidence before retrying.';
    nextAction = `rhinoq inspect ${current.id}`;
  } else if (current.cancellation?.status === 'cannot_cancel_safely') {
    kind = 'cancellation'; severity = 'error';
    summary = current.cancellation.reason ?? 'The active operation cannot be cancelled safely.';
    nextAction = `rhinoq inspect ${current.id}`;
  } else if (current.state === 'cancel_requested') {
    kind = 'cancellation'; severity = 'warning';
    summary = 'Cancellation was requested and is awaiting authoritative runtime resolution.';
    nextAction = `rhinoq inspect ${current.id}`;
  } else if (retries > priorRetries) {
    kind = 'retry'; severity = 'warning';
    summary = `A new attempt was observed; retry count is ${retries}.`;
    nextAction = `rhinoq inspect ${current.id}`;
  } else if (current.state === 'succeeded') {
    kind = 'succeeded'; summary = current.hasResult ? 'Task succeeded with a recorded result.' : 'Task succeeded without a recorded result.';
    if (!current.hasResult) { severity = 'warning'; nextAction = `rhinoq inspect ${current.id}`; }
  } else if (current.state === 'cancelled') {
    kind = 'cancelled'; summary = 'Task cancellation reached a terminal state.';
  } else if (current.state === 'running') {
    const progressed = previous && (current.progress.completed !== previous.progress.completed || current.progress.message !== previous.progress.message);
    kind = progressed ? 'progress' : 'running';
    summary = progressed ? 'Task progress advanced.' : 'Task is running.';
  } else {
    kind = 'accepted'; summary = `Task is ${current.state}.`;
  }
  return Object.freeze({
    schemaVersion: 1 as const, kind, severity, taskId: current.id, taskType: current.type,
    state: current.state, entityVersion: current.entityVersion, observedAt: current.updatedAt,
    summary, ...(nextAction ? { nextAction } : {}),
    progress: Object.freeze({ ...current.progress }),
    ...(retries ? { retryCount: retries } : {}),
  });
}

/** Groups identical operational symptoms so a fan-out does not print one stack per Task. */
export function groupRhinoQTerminalEvents(events: readonly RhinoQTerminalEvent[]): readonly RhinoQTerminalIncidentGroup[] {
  const grouped = new Map<string, RhinoQTerminalEvent[]>();
  for (const event of events) {
    const fingerprint = `${event.severity}:${event.kind}:${event.taskType}:${event.summary}`;
    const group = grouped.get(fingerprint) ?? [];
    group.push(event);
    grouped.set(fingerprint, group);
  }
  return Object.freeze([...grouped.entries()].map(([fingerprint, group]) => {
    const latest = [...group].sort((left, right) => right.observedAt.localeCompare(left.observedAt))[0]!;
    return Object.freeze({
      schemaVersion: 1 as const, fingerprint, severity: latest.severity, kind: latest.kind,
      taskType: latest.taskType, count: group.length,
      taskIds: Object.freeze(group.map((item) => item.taskId).sort().slice(0, 10)),
      summary: latest.summary, ...(latest.nextAction ? { nextAction: latest.nextAction } : {}),
      observedAt: latest.observedAt,
    });
  }).sort((left, right) => SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] || right.observedAt.localeCompare(left.observedAt)));
}

export function formatRhinoQTerminalGroup(group: RhinoQTerminalIncidentGroup, options: { quiet?: boolean } = {}): string {
  if (options.quiet && group.severity === 'info') return '';
  const marker = group.severity === 'error' ? '!' : group.severity === 'warning' ? '~' : group.kind === 'succeeded' ? '✓' : '→';
  const count = group.count > 1 ? ` ×${group.count}` : '';
  const ids = group.count === 1 ? ` ${group.taskIds[0] ?? ''}` : ` [${group.taskIds.join(', ')}${group.count > group.taskIds.length ? ', …' : ''}]`;
  return `${group.observedAt} ${marker} ${group.taskType}${count}${ids}\n  ${group.summary}${group.nextAction ? `\n  Next: ${group.nextAction}` : ''}`;
}

export function buildRhinoQWorkbenchTaskURL(baseURL: string, taskId: string): string {
  if (!taskId?.trim()) throw new TypeError('task id is required');
  let url: URL;
  try { url = new URL(baseURL); } catch { throw new TypeError('Workbench base URL must be absolute'); }
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new TypeError('Workbench URL must use HTTPS outside loopback');
  url.searchParams.set('task', taskId.trim());
  return url.toString();
}

async function waitForChangeOrPoll(changes: RhinoQChangeHintSource | undefined, pollIntervalMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(done, pollIntervalMs);
    const onAbort = () => done();
    function done(): void {
      clearTimeout(timer);
      unsubscribe?.();
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    unsubscribe = changes?.subscribe(done);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be ${minimum}..${maximum}`);
  return value;
}
