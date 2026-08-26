import { RhinoQError } from '../gateway/client.js';
import type {
  TaskExecutionResults,
  TaskExecutionRuntimeRefs,
  TaskSnapshot,
  TaskState,
  TaskSummary,
  TaskWaitpoint,
  TaskVerificationRecord,
  TaskArtifact,
  TaskCheckpoint,
  ProviderOperationRecord,
} from '../gateway/types.js';
import type { TaskStateQuery } from '../postgres/task-client.js';
import { taskFlightRecorderDiagnostic, type TaskFlightRecorder } from '../tasks/flight-recorder.js';
import type { DurableStepRecord } from '../tasks/durable.js';
import { taskUIModel, type TaskUIModel } from '../tasks/ui.js';
import { safeOperatorURL, type RuntimeHealthReader, type RuntimeJobLink } from '../observe/runtime-health.js';
import { workbenchPage } from './page.js';
import type { IncidentExplanation } from '../tasks/incident-explanation.js';
import type { RuntimeAdapterReport } from '../runtime/contracts.js';
import type { RhinoQPlanInspection } from '../tasks/plan-inspector.js';
import type { RhinoQAutopilotReport } from '../observe/autopilot.js';
import type { RhinoQAdoptionPlan } from '../adopt/autopilot.js';
import type { TaskEvidencePassport } from '../tasks/evidence-passport.js';
import { inspectRhinoQTask } from '../tasks/operator-inspection.js';

/** The reads the Workbench performs. `PostgresTaskClient` satisfies it. */
export interface WorkbenchTaskSource {
  listTasksByState(query: TaskStateQuery): Promise<TaskSummary[]>;
  getTask(taskId: string): Promise<TaskSnapshot>;
  getTaskExecutionResults(taskId: string): Promise<TaskExecutionResults>;
  listTaskExecutionRuntimeRefs?(taskId: string): Promise<TaskExecutionRuntimeRefs>;
  listTaskWaitpoints?(taskId: string): Promise<TaskWaitpoint[]>;
  listTaskVerifications?(taskId: string): Promise<TaskVerificationRecord[]>;
  listTaskArtifacts?(taskId: string): Promise<TaskArtifact[]>;
  listTaskCheckpoints?(taskId: string, limit?: number): Promise<TaskCheckpoint[]>;
  listDurableSteps?(taskId: string, itemKey?: string): Promise<DurableStepRecord[]>;
  /** Join the Go-owned provider ledger by its explicit taskId correlation. */
  listProviderOperationsByTask?(taskId: string): Promise<ProviderOperationRecord[]>;
  requestTaskCancellation?(taskId: string, expectedVersion: number): Promise<TaskSnapshot>;
}

export interface WorkbenchHandlerOptions {
  tasks: WorkbenchTaskSource;
  /**
   * Decides whether this request may see operator data. Required, and there is
   * no default: this page shows every owner's Tasks and the runtime job IDs
   * behind them, which the owner-scoped API deliberately withholds. A default
   * would eventually be someone's production configuration.
   *
   * Return false, or throw, to refuse.
   */
  requireOperator(request: Request): Promise<boolean> | boolean;
  /** Defaults to `/rhinoq`. */
  basePath?: string;
  /**
   * Allows cancellation from the page. Off by default: an operator console
   * that can act is a different risk from one that can only look, and that
   * should be a decision rather than an inheritance.
   */
  actions?: boolean;
  /** States shown as buckets. Defaults to the six worth watching. */
  states?: TaskState[];
  /** Rows fetched per state. Defaults to 100, capped by the store at 500. */
  limit?: number;
  /**
   * How often the server-sent stream re-reads the store. Defaults to 1s.
   * The stream only writes when something actually changed, so this is the
   * latency of an update rather than its cost to the browser.
   */
  streamIntervalMs?: number;
  /** Optional links that connect this operator surface to the host product. */
  navigation?: { overviewPath?: string; tasksPath?: string };
  /** Optional Go Gateway join that completes Task -> provider Flight Recorder. */
  providerOperationsByTask?(taskId: string): Promise<ProviderOperationRecord[]>;
  /** Read-only runtime evidence. The route remains behind requireOperator. */
  runtimeHealth?: readonly RuntimeHealthReader[];
  /** Optional operator-only link to the corresponding provider job. */
  runtimeJobLink?: RuntimeJobLink;
  /** Portable capability/health reports used to gate runtime actions. */
  runtimeReports?(): Promise<RuntimeAdapterReport[]>;
  /** Optional read-only compiler output for Plan Inspector. */
  applicationPlan?: RhinoQPlanInspection;
  /** Optional deterministic observe/recommend report; never mutates Tasks. */
  autopilot?(): Promise<RhinoQAutopilotReport> | RhinoQAutopilotReport;
  /** Optional read-only native adoption and Safety Compiler evidence. */
  adoptionPlan?: RhinoQAdoptionPlan;
}

const DEFAULT_STATES: TaskState[] = [
  'running',
  'queued',
  'pending',
  'cancel_requested',
  'uncertain',
  'failed',
];
const ATTENTION_BUCKET = 'attention';
const ATTENTION_STATES: TaskState[] = [
  'pending', 'queued', 'running', 'uncertain', 'succeeded', 'failed',
  'cancel_requested', 'cancelled',
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function normalizeBasePath(value: string): string {
  const path = `/${value}`.replace(/\/+/g, '/').replace(/\/$/, '');
  return path || '/rhinoq';
}

function routeParts(pathname: string, basePath: string): string[] | undefined {
  if (pathname === basePath) {
    return [];
  }
  if (!pathname.startsWith(`${basePath}/`)) {
    return undefined;
  }
  return pathname.slice(basePath.length + 1).split('/').filter(Boolean);
}

/**
 * A local operator console for the embedded Task profile, mounted on the
 * application's own HTTP surface.
 *
 * The Go Workbench needs the full engine schema and its own process. An
 * application on the isolated Task profile had neither, which meant the
 * quickest path to adopting RhinoQ was also the one with nothing to look at.
 * This is Fetch-compatible, so the same adapters that mount
 * `createTaskRequestHandler` mount it.
 *
 * **It is not the owner-scoped API.** It reads across owners and shows runtime
 * job identity. Mount it behind operator authentication, on an internal route,
 * and never expose it to end users.
 */
export function createWorkbenchHandler(
  options: WorkbenchHandlerOptions,
): (request: Request) => Promise<Response> {
  if (!options?.tasks || typeof options.tasks.listTasksByState !== 'function') {
    throw new TypeError('createWorkbenchHandler requires a Task source with listTasksByState');
  }
  if (typeof options.requireOperator !== 'function') {
    throw new TypeError(
      'createWorkbenchHandler requires requireOperator: this page shows every ' +
        'owner’s Tasks and their runtime job IDs',
    );
  }
  const basePath = normalizeBasePath(options.basePath ?? '/rhinoq');
  const states = options.states?.length ? options.states : DEFAULT_STATES;
  const limit = options.limit ?? 100;
  const actions = options.actions === true;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const relative = routeParts(url.pathname, basePath);
    if (relative === undefined) {
      return json({ code: 'RHINOQ_NOT_FOUND' }, 404);
    }

    let allowed = false;
    try {
      allowed = (await options.requireOperator(request)) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      return json({ code: 'RHINOQ_FORBIDDEN' }, 403);
    }

    try {
      if (request.method === 'GET' && relative.length === 0) {
        return new Response(workbenchPage(options.navigation), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            // The page is self-contained; say so, so a stray CDN import fails
            // loudly here rather than silently in someone else's network.
            'content-security-policy':
              "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
            'x-frame-options': 'DENY',
          },
        });
      }

      if (request.method === 'GET' && relative[0] === 'api' && relative[1] === 'stream') {
        return streamResponse({
          tasks: options.tasks,
          states,
          limit,
          actions,
          taskId: url.searchParams.get('task') ?? undefined,
          intervalMs: options.streamIntervalMs ?? 1_000,
          signal: request.signal,
          providerOperationsByTask: options.providerOperationsByTask,
          runtimeJobLink: options.runtimeJobLink,
          runtimeHealth: options.runtimeHealth,
          runtimeReports: options.runtimeReports,
        });
      }

      if (request.method === 'GET' && relative[0] === 'api' && relative[1] === 'overview') {
        const counts: Record<string, number> = {};
        for (const state of states) {
          const tasks = await options.tasks.listTasksByState({ states: [state], limit });
          counts[state] = tasks.length;
        }
        counts[ATTENTION_BUCKET] = (await listAttentionTasks(options.tasks, limit)).length;
        return json({
          schemaVersion: 1,
          states: [...states, ATTENTION_BUCKET],
          counts,
          actions,
          limit,
          runtimeHealth: await inspectRuntimeHealth(options.runtimeHealth),
        });
      }

      if (request.method === 'GET' && relative[0] === 'api' && relative[1] === 'runtime-health') {
        return json({ schemaVersion: 1, scopes: await inspectRuntimeHealth(options.runtimeHealth) });
      }

      if (request.method === 'GET' && relative.length === 2 && relative[0] === 'api' && relative[1] === 'autopilot') {
        return json(options.autopilot ? await options.autopilot() : {
          schemaVersion: 1,
          phase: 'observe',
          observedAt: new Date().toISOString(),
          source: 'not-configured',
          recommendations: [],
          missingMetrics: [],
          note: 'deterministic observations only; no Task state or business outcome mutation',
        });
      }

      if (request.method === 'GET' && relative.length === 2 && relative[0] === 'api' && relative[1] === 'plan') {
        return json(options.applicationPlan ?? {
          schemaVersion: 1,
          status: 'not-configured',
          tasks: [],
          needsDecision: ['start the typed application compiler to expose a plan'],
          note: 'read-only compiled manifest; no configuration was generated or changed',
        });
      }

      if (request.method === 'GET' && relative.length === 2 && relative[0] === 'api' && relative[1] === 'adoption-plan') {
        return json(options.adoptionPlan ?? { schemaVersion: 1, status: 'not-configured', diagnostics: [] });
      }

      if (request.method === 'GET' && relative[0] === 'api' && relative[1] === 'tasks' && relative.length === 2) {
        const requested = url.searchParams.get('state') ?? states[0];
        if (requested === ATTENTION_BUCKET) {
          const tasks = await listAttentionTasks(options.tasks, limit);
          return json({ schemaVersion: 1, state: requested, tasks: tasks.map(withTaskUI) });
        }
        if (!states.includes(requested as TaskState)) {
          return json({ code: 'RHINOQ_INVALID_REQUEST', message: 'unknown state' }, 400);
        }
        const tasks = await options.tasks.listTasksByState({
          states: [requested as TaskState],
          limit,
        });
        return json({ schemaVersion: 1, state: requested, tasks: tasks.map(withTaskUI) });
      }

      if (relative[0] === 'api' && relative[1] === 'tasks' && relative.length >= 3) {
        const taskId = decodeURIComponent(relative[2] as string);

        if (request.method === 'GET' && relative.length === 3) {
          return json({ schemaVersion: 1, ...(await taskDetail(options.tasks, taskId, options.providerOperationsByTask, options.runtimeJobLink, options.runtimeReports)) });
        }

        if (request.method === 'GET' && relative.length === 4 && relative[3] === 'evidence-passport') {
          const detail = await taskDetail(options.tasks, taskId, options.providerOperationsByTask, undefined, options.runtimeReports);
          return json(detail.evidencePassport);
        }
        if (request.method === 'GET' && relative.length === 4 && relative[3] === 'incident-explanation') {
          const detail = await taskDetail(options.tasks, taskId, options.providerOperationsByTask, undefined, options.runtimeReports);
          return json(detail.incidentExplanation);
        }

        if (request.method === 'GET' && relative.length === 4 && relative[3] === 'flight-recorder') {
          const detail = await taskDetail(options.tasks, taskId, options.providerOperationsByTask);
          return json(detail.flightRecorder);
        }
        if (request.method === 'GET' && relative.length === 5 && relative[3] === 'flight-recorder' && relative[4] === 'diagnostic') {
          const detail = await taskDetail(options.tasks, taskId, options.providerOperationsByTask);
          return new Response(taskFlightRecorderDiagnostic(detail.flightRecorder), { headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="${safeFilename(taskId)}-flight-recorder.json"`,
            'cache-control': 'private, no-store',
          } });
        }

        if (request.method === 'POST' && relative.length === 4 && relative[3] === 'cancel') {
          if (!actions) {
            return json({ code: 'RHINOQ_FORBIDDEN', message: 'this Workbench is read-only' }, 403);
          }
          if (typeof options.tasks.requestTaskCancellation !== 'function') {
            return json({ code: 'RHINOQ_UNSUPPORTED', message: 'this store cannot cancel' }, 501);
          }
          if (options.runtimeReports) {
            const detail = await taskDetail(options.tasks, taskId, options.providerOperationsByTask, undefined, options.runtimeReports);
            const cancel = detail.incidentExplanation.recommendedActions.find((action) => action.id === 'request-cancellation');
            if (!cancel || cancel.availability !== 'available') {
              return json({
                code: 'RHINOQ_UNSUPPORTED',
                message: cancel?.reason ?? 'runtime cancellation capability is unavailable',
              }, 409);
            }
          }
          const body = (await request.json().catch(() => ({}))) as { expectedVersion?: unknown };
          if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) <= 0) {
            return json({ code: 'RHINOQ_INVALID_REQUEST', message: 'expectedVersion is required' }, 400);
          }
          const task = await options.tasks.requestTaskCancellation(taskId, Number(body.expectedVersion));
          return json({ schemaVersion: 1, task });
        }
      }

      return json({ code: 'RHINOQ_NOT_FOUND' }, 404);
    } catch (error) {
      if (error instanceof RhinoQError) {
        return json(
          { code: error.code, message: error.message, retryable: error.retryable },
          error.status ?? 500,
        );
      }
      // Never surface an unexpected message: it can carry a connection string.
      return json({ code: 'RHINOQ_INTERNAL', message: 'Workbench request failed' }, 500);
    }
  };
}

interface NodeRequestLike {
  url?: string;
  originalUrl?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'close', listener: () => void): unknown;
}

interface NodeResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  write(chunk: string | Uint8Array): unknown;
  end(chunk?: string | Uint8Array): unknown;
  flushHeaders?(): unknown;
}

/**
 * Express/NestJS middleware for the Workbench.
 *
 * `createNodeTaskMiddleware` cannot serve this: it finishes a response with
 * `await result.text()`, and a server-sent event stream never finishes — the
 * request would hang rather than fail, which is the one outcome a fallback
 * cannot rescue. This pumps the body instead, so the console is realtime on
 * the frameworks it is most likely to be mounted in.
 */
export function createNodeWorkbenchMiddleware(
  options: WorkbenchHandlerOptions & { origin?: string },
): (request: NodeRequestLike, response: NodeResponseLike, next?: () => void) => void {
  const handler = createWorkbenchHandler(options);
  const basePath = normalizeBasePath(options.basePath ?? '/rhinoq');
  const origin = (options.origin ?? 'http://rhinoq.invalid').replace(/\/+$/, '');

  return (request, response, next) => {
    const raw = request.originalUrl ?? request.url ?? '/';
    const url = new URL(`${origin}${raw}`);
    if (next && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      next();
      return;
    }

    const controller = new AbortController();
    request.on('close', () => controller.abort());

    void (async () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) headers.set(name, value.join(', '));
      }
      const result = await handler(
        new Request(url, { method: request.method ?? 'GET', headers, signal: controller.signal }),
      );
      response.statusCode = result.status;
      for (const [name, value] of result.headers) {
        response.setHeader(name, value);
      }
      if (!result.body) {
        response.end();
        return;
      }
      // Send headers before the first chunk so EventSource opens immediately
      // instead of waiting for whatever the framework decides to buffer.
      response.flushHeaders?.();
      const reader = result.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) response.write(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        response.end();
      }
    })().catch(() => {
      try {
        response.statusCode = 500;
        response.end('{"code":"RHINOQ_INTERNAL"}');
      } catch {
        // The socket is already gone.
      }
    });
  };
}

interface StreamOptions {
  tasks: WorkbenchTaskSource;
  states: TaskState[];
  limit: number;
  actions: boolean;
  taskId?: string;
  intervalMs: number;
  signal: AbortSignal;
  providerOperationsByTask?: WorkbenchHandlerOptions['providerOperationsByTask'];
  runtimeJobLink?: RuntimeJobLink;
  runtimeHealth?: readonly RuntimeHealthReader[];
  runtimeReports?: WorkbenchHandlerOptions['runtimeReports'];
}

/**
 * Server-sent events, so a change reaches the console when it happens instead
 * of on the next refresh.
 *
 * The store is still read on a timer — PostgreSQL is not pushing at us — but
 * the timer lives here, once per operator, and only a real change is written.
 * A browser polling the same data would either lag or hammer, and would show
 * nothing at all between refreshes.
 */
function streamResponse(options: StreamOptions): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let previous = '';
  let inFlight = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      const stop = () => {
        if (timer) {
          clearInterval(timer);
          timer = undefined;
        }
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      };

      options.signal.addEventListener('abort', stop, { once: true });
      // Tell the browser how long to wait before reconnecting, and open the
      // stream immediately so the page can drop its skeleton.
      controller.enqueue(encoder.encode(`retry: 3000\n\n`));

      const poll = async () => {
        if (inFlight || options.signal.aborted) {
          return;
        }
        inFlight = true;
        try {
          const payload = await collect(options);
          const serialized = JSON.stringify(payload);
          if (serialized !== previous) {
            previous = serialized;
            send('state', payload);
          } else {
            // A comment is not an event; it keeps proxies from closing an
            // idle stream without waking the page up.
            controller.enqueue(encoder.encode(': keep-alive\n\n'));
          }
        } catch (error) {
          send('failure', {
            message: error instanceof RhinoQError ? error.message : 'Workbench stream failed',
          });
        } finally {
          inFlight = false;
        }
      };

      void poll();
      timer = setInterval(() => void poll(), Math.max(250, options.intervalMs));
      timer.unref?.();
    },
    cancel() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // Nginx buffers text/event-stream by default and the page looks frozen.
      'x-accel-buffering': 'no',
    },
  });
}

async function collect(options: StreamOptions): Promise<Record<string, unknown>> {
  const counts: Record<string, number> = {};
  const lists: Record<string, WorkbenchTaskRow[]> = {};
  for (const state of options.states) {
    const tasks = await options.tasks.listTasksByState({ states: [state], limit: options.limit });
    counts[state] = tasks.length;
    lists[state] = tasks.map(withTaskUI);
  }
  lists[ATTENTION_BUCKET] = (await listAttentionTasks(options.tasks, options.limit)).map(withTaskUI);
  counts[ATTENTION_BUCKET] = lists[ATTENTION_BUCKET].length;
  const detail = options.taskId
    ? await taskDetail(options.tasks, options.taskId, options.providerOperationsByTask, options.runtimeJobLink, options.runtimeReports).catch(() => undefined)
    : undefined;
  return {
    schemaVersion: 1,
    states: [...options.states, ATTENTION_BUCKET],
    actions: options.actions,
    counts,
    lists,
    runtimeHealth: await inspectRuntimeHealth(options.runtimeHealth),
    ...(detail ? { detail } : {}),
  };
}

async function listAttentionTasks(tasks: WorkbenchTaskSource, limit: number): Promise<TaskSummary[]> {
  const rows = await tasks.listTasksByState({ states: ATTENTION_STATES, limit });
  const seen = new Set<string>();
  return rows.filter((task) => {
    if (seen.has(task.id) || !needsAttention(task)) return false;
    seen.add(task.id);
    return true;
  });
}

function needsAttention(task: TaskSummary): boolean {
  if (task.state === 'uncertain' || task.state === 'failed') return true;
  if (task.cancellation?.status === 'too_late' || task.cancellation?.status === 'cannot_cancel_safely') return true;
  const counts = task.itemCounts ?? task.executionCounts;
  return counts.failed > 0 && counts.succeeded > 0;
}

type WorkbenchTaskRow = TaskSummary & { ui: TaskUIModel };

function withTaskUI(task: TaskSummary): WorkbenchTaskRow {
  return { ...task, ui: taskUIModel(task) };
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'task';
}

/**
 * One Task, joined the way an operator asks about it: per item, with the
 * runtime job to look at and the reason it failed. The runtime identity comes
 * from the server-side read, never from the polled snapshot.
 */
async function taskDetail(
  tasks: WorkbenchTaskSource,
  taskId: string,
  providerOperationsByTask?: (taskId: string) => Promise<ProviderOperationRecord[]>,
  runtimeJobLink?: RuntimeJobLink,
  runtimeReports?: () => Promise<RuntimeAdapterReport[]>,
): Promise<{ task: TaskSnapshot; ui: TaskUIModel; items: WorkbenchItem[]; steps: DurableStepRecord[]; waitpoints: TaskWaitpoint[]; flightRecorder: TaskFlightRecorder; incidentExplanation: IncidentExplanation; evidencePassport: TaskEvidencePassport }> {
  const [inspection, refs] = await Promise.all([
    inspectRhinoQTask(tasks, taskId, { providerOperationsByTask, runtimeReports }),
    tasks.listTaskExecutionRuntimeRefs?.(taskId).catch(() => undefined),
  ]);
  const { task } = inspection;

  const runtimeRefs = new Map<string, { externalId: string; runtime: string; runtimeScope?: string }>();
  for (const ref of refs?.executions ?? []) {
    if (ref.externalId) {
      runtimeRefs.set(ref.executionId, {
        externalId: ref.externalId,
        runtime: ref.runtime,
        ...(ref.runtimeScope ? { runtimeScope: ref.runtimeScope } : {}),
      });
    }
  }
  const reasons = new Map<string, string>();
  for (const result of inspection.executionResults.executions ?? []) {
    if (result.failureReason) {
      reasons.set(result.executionId, result.failureReason);
    }
  }

  const items = task.executions.map((execution) => {
    const runtimeRef = runtimeRefs.get(execution.id);
    return {
      executionId: execution.id,
      itemKey: execution.itemKey ?? 'default',
      attempt: execution.attempt,
      state: execution.state,
      hasResult: execution.hasResult === true,
      ...(runtimeRef ? { externalId: runtimeRef.externalId } : {}),
      ...(runtimeRef && runtimeJobLink
        ? safeRuntimeLink(runtimeJobLink, runtimeRef.externalId, runtimeRef.runtime, runtimeRef.runtimeScope)
        : {}),
      ...(execution.failureReason ?? reasons.get(execution.id)
        ? { failureReason: execution.failureReason ?? reasons.get(execution.id) }
        : {}),
    };
  });

  return {
    task,
    ui: taskUIModel(task),
    items,
    waitpoints: [...inspection.waitpoints],
    steps: [...inspection.steps],
    flightRecorder: inspection.flightRecorder,
    incidentExplanation: inspection.incidentExplanation,
    evidencePassport: inspection.evidencePassport,
  };
}

interface WorkbenchItem {
  executionId: string;
  itemKey: string;
  attempt: number;
  state: string;
  hasResult: boolean;
  externalId?: string;
  runtimeURL?: string;
  failureReason?: string;
}

function safeRuntimeLink(link: RuntimeJobLink, externalId: string, runtime?: string, scope?: string): { runtimeURL?: string } {
  try {
    const runtimeURL = safeOperatorURL(link({ runtime: runtime ?? 'unknown', scope: scope ?? '', externalId }));
    return runtimeURL ? { runtimeURL } : {};
  } catch { return {}; }
}

function sanitizeRuntimeHealth<T extends { dashboardURL?: string }>(health: T): T {
  const dashboardURL = safeOperatorURL(health.dashboardURL);
  return { ...health, ...(dashboardURL ? { dashboardURL } : { dashboardURL: undefined }) };
}

async function inspectRuntimeHealth(readers: readonly RuntimeHealthReader[] | undefined) {
  const scopes = await Promise.all((readers ?? []).slice(0, 50).map((reader) => reader.inspect()));
  return scopes.map(sanitizeRuntimeHealth);
}
