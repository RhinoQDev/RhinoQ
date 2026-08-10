import { RhinoQError } from '../gateway/client.js';
import type {
  TaskExecutionResults,
	TaskExecutionPage,
  TaskResult,
  TaskSnapshot,
	TaskSummary,
	TaskWaitpoint,
	TaskWaitpointCreateRequest,
	TaskWaitpointResolveRequest,
} from '../gateway/types.js';
import type { PostgresTaskClient } from '../postgres/task-client.js';
import { parseTaskEventStream, taskEventResponse, taskListEventResponse, type TaskSSEOptions, type TaskStreamEvent } from './sse.js';
import { failedTaskItems, taskGroupManifest } from './group.js';


export interface TaskRequestHandlerOptions {
  tasks: PostgresTaskClient;
  /** Return the authenticated application owner ID; never a RhinoQ token. */
  ownerFromRequest(request: Request): Promise<string | undefined> | string | undefined;
  /** Defaults to /tasks. */
  basePath?: string;
  /**
   * Optional application-owned conversion from a storage reference to a
   * short-lived download response.
   */
  resolveResult?(
    result: TaskResult,
    request: Request,
    ownerId: string,
  ): Promise<unknown> | unknown;
  /** Application-owned durable retry composition. commandId is mandatory. */
  retryTask?(input: {
    task: TaskSnapshot;
    ownerId: string;
    commandId: string;
    request: Request;
  }): Promise<TaskSnapshot>;
  /** Optional health report mounted at `<basePath>/_health`. */
  health?(): Promise<unknown> | unknown;
  /** Set false to disable SSE. Snapshots remain authoritative. */
  stream?: TaskSSEOptions | false;
}

/**
 * Small application-facing HTTP surface using the host application's auth.
 *
 * It is Fetch API compatible, so framework adapters only translate their
 * request/response objects instead of rebuilding authorization and errors for
 * every Task type.
 */
export function createTaskRequestHandler(
  options: TaskRequestHandlerOptions,
): (request: Request) => Promise<Response> {
  if (!options?.tasks) {
    throw new TypeError('PostgresTaskClient is required');
  }
  const basePath = normalizeBasePath(options.basePath ?? '/tasks');
  let activeStreams = 0;
  const maxStreams = options.stream === false ? 0 : boundedInteger(options.stream?.maxConnections ?? 1_000, 1, 100_000, 'stream maxConnections');
  const openStream = (create: (closed: () => void) => Response): Response => {
    if (activeStreams >= maxStreams) return json({ code: 'RHINOQ_STREAM_CAPACITY', retryable: true }, 503);
    activeStreams++;
    let closed = false;
    return create(() => { if (!closed) { closed = true; activeStreams--; } });
  };

  return async (request: Request): Promise<Response> => {
    try {
      const ownerId = await options.ownerFromRequest(request);
      if (!ownerId?.trim()) {
        return json({ code: 'RHINOQ_UNAUTHORIZED' }, 401);
      }
      const url = new URL(request.url);
      const relative = routeParts(url.pathname, basePath);
      if (relative === undefined) {
        return json({ code: 'RHINOQ_NOT_FOUND' }, 404);
      }

      if (request.method === 'GET' && relative.length === 0) {
        const limit = integerQuery(url, 'limit', 50);
        const offset = integerQuery(url, 'offset', 0);
        return json({ tasks: await options.tasks.listTasks(ownerId, limit, offset) });
      }
      if (request.method === 'GET' && relative.length === 1 && relative[0] === '_events') {
        if (options.stream === false) return json({ code: 'RHINOQ_STREAM_DISABLED' }, 404);
        return openStream((closed) => taskListEventResponse(options.tasks, request, ownerId, integerQuery(url, 'limit', 50), integerQuery(url, 'offset', 0), options.stream || undefined, closed));
      }
      if (request.method === 'GET' && relative.length === 1 && relative[0] === '_health') {
        return options.health ? json(await options.health()) : json({ status: 'ok' });
      }
      const taskId = relative[0];
      if (!taskId) {
        return json({ code: 'RHINOQ_NOT_FOUND' }, 404);
      }
      if (request.method === 'GET' && relative.length === 1) {
        return json(await options.tasks.getTaskForOwner(taskId, ownerId));
      }
	  if (request.method === 'GET' && relative.length === 2 && relative[1] === 'events') {
		if (options.stream === false) return json({ code: 'RHINOQ_STREAM_DISABLED' }, 404);
		await options.tasks.getTaskSummaryForOwner(taskId, ownerId);
		return openStream((closed) => taskEventResponse(options.tasks, request, ownerId, taskId, options.stream || undefined, closed));
	  }
	  if (request.method === 'GET' && relative.length === 2 && relative[1] === 'summary') {
		const summary: TaskSummary = await options.tasks.getTaskSummaryForOwner(taskId, ownerId);
		return json(summary);
	  }
      if (request.method === 'GET' && relative.length === 2 && relative[1] === 'failed-items') {
        const task = await options.tasks.getTaskForOwner(taskId, ownerId);
        const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json';
        return new Response(failedTaskItems(task, format), { headers: {
          'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${safeFilename(taskId)}-failed.${format}"`,
          'cache-control': 'private, no-store',
        } });
      }
      if (request.method === 'GET' && relative.length === 2 && relative[1] === 'manifest') {
        const task = await options.tasks.getTaskForOwner(taskId, ownerId);
        const results = await options.tasks.getTaskExecutionResultsForOwner(taskId, ownerId);
        return json(taskGroupManifest(task, results.executions));
      }
	  if (request.method === 'GET' && relative.length === 3 && relative[1] === 'executions' && relative[2] === 'page') {
		const page: TaskExecutionPage = await options.tasks.listTaskExecutionsForOwner(
			taskId, ownerId, url.searchParams.get('cursor') ?? '', integerQuery(url, 'limit', 100),
		);
		return json(page);
	  }
      if (
        request.method === 'GET' &&
        relative.length === 2 &&
        relative[1] === 'executions'
      ) {
        const results: TaskExecutionResults =
          await options.tasks.getTaskExecutionResultsForOwner(taskId, ownerId);
        return json(results);
      }
      if (request.method === 'POST' && relative.length === 2 && relative[1] === 'waitpoints') {
        await options.tasks.getTaskSummaryForOwner(taskId, ownerId);
        const body = await request.json() as TaskWaitpointCreateRequest;
        return json(await options.tasks.createTaskWaitpoint(taskId, body), 201);
      }
      if (relative.length === 3 && relative[1] === 'waitpoints') {
        const waitpoint = await options.tasks.getTaskWaitpoint(relative[2]!, ownerId);
        if (waitpoint.taskId !== taskId) return json({ code: 'RHINOQ_WAITPOINT_NOT_FOUND' }, 404);
        if (request.method === 'GET') return json(waitpoint);
        if (request.method === 'POST') {
          const body = await request.json() as TaskWaitpointResolveRequest;
          return json(await options.tasks.resolveTaskWaitpoint(relative[2]!, ownerId, body));
        }
      }
      if (
        request.method === 'GET' &&
        relative.length === 2 &&
        relative[1] === 'result'
      ) {
        const result = await options.tasks.getTaskResultForOwner(taskId, ownerId);
        const resolved = options.resolveResult
          ? await options.resolveResult(result, request, ownerId)
          : result;
        return resolved instanceof Response ? resolved : json(resolved);
      }
      if (
        request.method === 'POST' &&
        relative.length === 2 &&
        relative[1] === 'cancel'
      ) {
        const body = await request.json().catch(() => ({})) as { expectedVersion?: unknown };
        if (body.expectedVersion !== undefined &&
            (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) <= 0)) {
          return json({ code: 'RHINOQ_INVALID_REQUEST' }, 400);
        }
        const snapshot: TaskSnapshot = body.expectedVersion === undefined
          ? await cancelWithoutFence(options.tasks, taskId, ownerId)
          : await options.tasks.requestTaskCancellationForOwner(
            taskId,
            ownerId,
            Number(body.expectedVersion),
          );
        return json(snapshot);
      }
      if (request.method === 'POST' && relative.length === 2 && relative[1] === 'retry') {
        if (!options.retryTask) return json({ code: 'RHINOQ_RETRY_NOT_CONFIGURED' }, 501);
        const body = await request.json() as { expectedVersion?: unknown; commandId?: unknown };
        if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) <= 0 ||
            typeof body.commandId !== 'string' || !body.commandId.trim()) {
          return json({ code: 'RHINOQ_INVALID_REQUEST', message: 'expectedVersion and commandId are required' }, 400);
        }
        const task = await options.tasks.getTaskForOwner(taskId, ownerId);
        if (task.entityVersion !== Number(body.expectedVersion)) {
          return json({ code: 'RHINOQ_VERSION_CONFLICT', task }, 409);
        }
        if (task.state !== 'failed' && task.state !== 'cancelled') {
          return json({ code: 'RHINOQ_TASK_NOT_RETRYABLE', task }, 409);
        }
        return json(await options.retryTask({ task, ownerId, commandId: body.commandId.trim(), request }));
      }
      return json({ code: 'RHINOQ_NOT_FOUND' }, 404);
    } catch (error) {
      if (error instanceof RhinoQError) {
        return json(
          { code: error.code, message: error.message, retryable: error.retryable },
          error.status ?? 500,
        );
      }
      return json(
        { code: 'RHINOQ_INTERNAL', message: 'Task request failed' },
        500,
      );
    }
  };
}

export interface ApplicationTaskClientOptions {
  url: string;
  fetch?: typeof globalThis.fetch;
  headers?: () => HeadersInit | Promise<HeadersInit>;
}

/**
 * Browser-safe client for the application-owned Task endpoint. It knows
 * nothing about Gateway/operator credentials and works directly with
 * watchTask().
 */
export class ApplicationTaskClient {
  private readonly url: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly getHeaders?: () => HeadersInit | Promise<HeadersInit>;

  constructor(options: ApplicationTaskClientOptions) {
    this.url = options.url?.replace(/\/+$/, '');
    if (!this.url) {
      throw new TypeError('application Task URL is required');
    }
    this.doFetch = options.fetch ?? globalThis.fetch;
    if (typeof this.doFetch !== 'function') {
      throw new TypeError('fetch is required');
    }
    this.getHeaders = options.headers;
  }

  getTask(taskId: string): Promise<TaskSnapshot> {
    return this.send<TaskSnapshot>('GET', `/${path(taskId)}`);
  }

	getTaskSummary(taskId: string): Promise<TaskSummary> {
		return this.send('GET', `/${path(taskId)}/summary`);
	}

	listTaskExecutions(taskId: string, cursor = '', limit = 100): Promise<TaskExecutionPage> {
		return this.send('GET', `/${path(taskId)}/executions/page?limit=${limit}&cursor=${encodeURIComponent(cursor)}`);
	}

  async listTasks(limit = 50, offset = 0): Promise<TaskSnapshot[]> {
    const result = await this.send<{ tasks: TaskSnapshot[] }>(
      'GET',
      `?limit=${limit}&offset=${offset}`,
    );
    return result.tasks;
  }

  streamTask(taskId: string, options: { lastVersion?: number; signal?: AbortSignal } = {}): AsyncIterable<TaskStreamEvent> {
    return this.openStream(`/${path(taskId)}/events`, options);
  }

  streamTasks(limit = 50, offset = 0, options: { signal?: AbortSignal } = {}): AsyncIterable<TaskStreamEvent> {
    return this.openStream(`/_events?limit=${limit}&offset=${offset}`, options);
  }

  /**
   * Asks for cancellation. `expectedVersion` is optional: on a fan-out the Task
   * version moves several times a second, so a version read by a browser is
   * already stale by the time the request lands. Omit it unless you genuinely
   * need to refuse the cancel when the batch has moved on.
   */
  cancelTask(taskId: string, expectedVersion?: number): Promise<TaskSnapshot> {
    return this.send<TaskSnapshot>(
      'POST',
      `/${path(taskId)}/cancel`,
      expectedVersion === undefined ? {} : { expectedVersion },
    );
  }

  retryTask(taskId: string, expectedVersion: number, commandId: string): Promise<TaskSnapshot> {
    if (!commandId?.trim()) throw new TypeError('retry commandId is required');
    return this.send('POST', `/${path(taskId)}/retry`, { expectedVersion, commandId });
  }

  health(): Promise<unknown> { return this.send('GET', '/_health'); }

  getTaskResult(taskId: string): Promise<unknown> {
    return this.send('GET', `/${path(taskId)}/result`);
  }

  getTaskExecutionResults(taskId: string): Promise<TaskExecutionResults> {
    return this.send('GET', `/${path(taskId)}/executions`);
  }

  getTaskGroupManifest(taskId: string): Promise<unknown> { return this.send('GET', `/${path(taskId)}/manifest`); }
  async downloadFailedTaskItems(taskId: string, format: 'json' | 'csv' = 'json'): Promise<Blob> {
    const headers = new Headers(await this.getHeaders?.());
    const response = await this.doFetch(`${this.url}/${path(taskId)}/failed-items?format=${format}`, { headers });
    if (!response.ok) { const payload = await response.json() as Record<string,unknown>; throw new RhinoQError(String(payload.code ?? 'RHINOQ_HTTP_ERROR'), String(payload.message ?? response.statusText), false, { status: response.status }); }
    return response.blob();
  }

  createTaskWaitpoint(taskId: string, request: TaskWaitpointCreateRequest): Promise<TaskWaitpoint> {
    return this.send('POST', `/${path(taskId)}/waitpoints`, request);
  }

  getTaskWaitpoint(taskId: string, waitpointId: string): Promise<TaskWaitpoint> {
    return this.send('GET', `/${path(taskId)}/waitpoints/${path(waitpointId)}`);
  }

  resolveTaskWaitpoint(taskId: string, waitpointId: string, request: TaskWaitpointResolveRequest): Promise<TaskWaitpoint> {
    return this.send('POST', `/${path(taskId)}/waitpoints/${path(waitpointId)}`, request);
  }

  private async send<T>(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<T> {
    const headers = new Headers(await this.getHeaders?.());
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
    }
    const response = await this.doFetch(`${this.url}${pathname}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      throw new RhinoQError(
        typeof payload.code === 'string' ? payload.code : 'RHINOQ_HTTP_ERROR',
        typeof payload.message === 'string' ? payload.message : response.statusText,
        payload.retryable === true,
        { status: response.status },
      );
    }
    return payload as T;
  }

  private async *openStream(pathname: string, options: { lastVersion?: number; signal?: AbortSignal }): AsyncGenerator<TaskStreamEvent> {
    const headers = new Headers(await this.getHeaders?.());
    headers.set('accept', 'text/event-stream');
    if (options.lastVersion && options.lastVersion > 0) headers.set('last-event-id', String(options.lastVersion));
    const response = await this.doFetch(`${this.url}${pathname}`, { method: 'GET', headers, signal: options.signal });
    yield* parseTaskEventStream(response, options.signal);
  }
}

/**
 * Cancels without asking the caller to win a race it cannot win.
 *
 * `expectedVersion` is the right fence for a read-modify-write: it stops a
 * caller overwriting a decision made from a snapshot it never saw. Cancellation
 * is not that. There is no stale value being overwritten — "stop this batch" is
 * an intent, and asking for it twice is the same as asking once.
 *
 * A fan-out advances the Task version on every item transition, several times a
 * second. A browser that reads a version and then posts it has, by the time the
 * request lands, a version that is already old — so pressing Cancel on a busy
 * batch returned 409 essentially always, and the busier the batch the more
 * reliably it failed. That is the exact opposite of what anyone needs.
 *
 * Callers who do want the fence keep it by sending `expectedVersion`.
 */
async function cancelWithoutFence(
  tasks: PostgresTaskClient,
  taskId: string,
  ownerId: string,
): Promise<TaskSnapshot> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await tasks.getTaskForOwner(taskId, ownerId);
    // A terminal Task answers a late request with `too_late` rather than an
    // error, and re-requesting an in-flight cancellation is a no-op.
    if (current.state === 'cancel_requested') {
      return current;
    }
    try {
      return await tasks.requestTaskCancellationForOwner(taskId, ownerId, current.entityVersion);
    } catch (error) {
      if (!(error instanceof RhinoQError) || error.code !== 'RHINOQ_VERSION_CONFLICT') {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function normalizeBasePath(value: string): string {
  const normalized = `/${value}`.replace(/\/+/g, '/').replace(/\/$/, '');
  return normalized || '/tasks';
}

function routeParts(pathname: string, basePath: string): string[] | undefined {
  if (pathname === basePath) {
    return [];
  }
  if (!pathname.startsWith(`${basePath}/`)) {
    return undefined;
  }
  return pathname.slice(basePath.length + 1).split('/').map(decodeURIComponent);
}

function integerQuery(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be ${min}..${max}`);
  return value;
}

function path(value: string): string {
  if (!value?.trim()) {
    throw new TypeError('task id is required');
  }
  return encodeURIComponent(value);
}

function safeFilename(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'task'; }
