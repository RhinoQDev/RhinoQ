import { RhinoQError } from '../gateway/client.js';
import type {
  TaskExecutionResults,
  TaskResult,
  TaskSnapshot,
} from '../gateway/types.js';
import type { PostgresTaskClient } from '../postgres/task-client.js';

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
  ): Promise<unknown> | unknown;
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
      const taskId = relative[0];
      if (!taskId) {
        return json({ code: 'RHINOQ_NOT_FOUND' }, 404);
      }
      if (request.method === 'GET' && relative.length === 1) {
        return json(await options.tasks.getTaskForOwner(taskId, ownerId));
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
      if (
        request.method === 'GET' &&
        relative.length === 2 &&
        relative[1] === 'result'
      ) {
        const result = await options.tasks.getTaskResultForOwner(taskId, ownerId);
        return json(options.resolveResult
          ? await options.resolveResult(result, request)
          : result);
      }
      if (
        request.method === 'POST' &&
        relative.length === 2 &&
        relative[1] === 'cancel'
      ) {
        const body = await request.json() as { expectedVersion?: unknown };
        if (!Number.isInteger(body.expectedVersion) ||
            Number(body.expectedVersion) <= 0) {
          return json({ code: 'RHINOQ_INVALID_REQUEST' }, 400);
        }
        const snapshot: TaskSnapshot =
          await options.tasks.requestTaskCancellationForOwner(
            taskId,
            ownerId,
            Number(body.expectedVersion),
          );
        return json(snapshot);
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

  async listTasks(limit = 50, offset = 0): Promise<TaskSnapshot[]> {
    const result = await this.send<{ tasks: TaskSnapshot[] }>(
      'GET',
      `?limit=${limit}&offset=${offset}`,
    );
    return result.tasks;
  }

  cancelTask(taskId: string, expectedVersion: number): Promise<TaskSnapshot> {
    return this.send<TaskSnapshot>(
      'POST',
      `/${path(taskId)}/cancel`,
      { expectedVersion },
    );
  }

  getTaskResult(taskId: string): Promise<unknown> {
    return this.send('GET', `/${path(taskId)}/result`);
  }

  getTaskExecutionResults(taskId: string): Promise<TaskExecutionResults> {
    return this.send('GET', `/${path(taskId)}/executions`);
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

function path(value: string): string {
  if (!value?.trim()) {
    throw new TypeError('task id is required');
  }
  return encodeURIComponent(value);
}
