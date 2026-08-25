import { RhinoQError } from '../gateway/client.js';
import type {
  TaskExecutionResults,
	TaskExecutionPage,
  TaskResult,
  TaskSnapshot,
	TaskSummary,
	TaskArtifactRecord,
	TaskWaitpoint,
	TaskWaitpointCreateRequest,
	TaskWaitpointResolveRequest,
} from '../gateway/types.js';
import type { PostgresTaskClient } from '../postgres/task-client.js';
import { parseTaskEventStream, taskEventResponse, taskListEventResponse, type TaskSSEOptions, type TaskStreamEvent } from './sse.js';
import { failedTaskItems, taskGroupManifest } from './group.js';
import type { ArtifactUploadService, CreateArtifactUploadRequest } from './artifact-upload.js';
import type { ArtifactUploadPart, ArtifactUploadSession } from './artifact-upload.js';


/**
 * The only Task methods the owner-facing HTTP surface may reach.
 *
 * `PostgresTaskClient` carries both boundaries at once. Most of it is
 * owner-scoped, but a handful of methods are runtime/adapter primitives with no
 * tenant predicate at all — `getTaskExecution`, `transitionTaskExecution` and
 * `lookupTaskExecution` read or write by bare identity. Each is marked
 * "must not be mounted as an owner-facing endpoint" in a comment, and a comment
 * is not a boundary: nothing stopped a future handler from calling one, and the
 * result would be an IDOR reachable with any authenticated owner token.
 *
 * Naming the permitted surface makes the compiler enforce it. `Pick` keeps the
 * signatures tied to the client, so this list cannot drift out of date; adding
 * a route that needs an unlisted method now fails the build, which is the point
 * at which someone should be asking whether it is owner-safe.
 *
 * Three entries take no owner argument — `createTaskWaitpoint`,
 * `getTaskWaitpoint` and `refreshTaskArtifact`. Their handlers establish
 * ownership first with a `*ForOwner` read and pass the identity through, so the
 * fence is in the route rather than the signature.
 */
export type OwnerFacingTaskStore = Pick<
  PostgresTaskClient,
  | 'createTaskWaitpoint'
  | 'getTaskArtifactForOwner'
  | 'getTaskExecutionResultsForOwner'
  | 'getTaskForOwner'
  | 'getTaskResultForOwner'
  | 'getTaskSummaryForOwner'
  | 'getTaskWaitpoint'
  | 'listRecentlyVerifiedForOwner'
  | 'listTaskArtifactsForOwner'
  | 'listTaskExecutionsForOwner'
  | 'listTaskVerificationsForOwner'
  | 'listTaskWaitpointsForOwner'
  | 'listTasks'
  | 'listTasksPage'
  | 'listTasksByState'
  | 'listWaitingTaskWaitpointsForOwner'
  | 'refreshTaskArtifact'
  | 'requestTaskCancellationForOwner'
  | 'resolveTaskWaitpoint'
>;

export interface TaskRequestHandlerOptions {
  tasks: OwnerFacingTaskStore;
  /** Return the authenticated application owner ID; never a RhinoQ token. */
  ownerFromRequest(request: Request): Promise<string | undefined> | string | undefined;
  /** Resolve a stable tenant from the host session. Omit for a single `default` tenant. */
  tenantFromRequest?(request: Request): Promise<string | undefined> | string | undefined;
  /** Optional tenant-wide policy hook; ownership checks remain mandatory below. */
  authorize?(input: TaskAuthorizationInput): Promise<boolean> | boolean;
  /** Refuse mounting a tenant surface without an explicit policy hook. */
  requireTenantAuthorization?: boolean;
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
    tenantId: string,
  ): Promise<unknown> | unknown;
  /** Convert a private artifact reference into a short-lived owner-safe response. */
  resolveArtifact?(
    artifact: TaskArtifactRecord,
    request: Request,
    ownerId: string,
    tenantId: string,
  ): Promise<unknown> | unknown;
  /** Application-owned durable retry composition. commandId is mandatory. */
  retryTask?(input: {
    task: TaskSnapshot;
    ownerId: string;
    commandId: string;
    request: Request;
  }): Promise<TaskSnapshot>;
  /**
   * Optional runtime-aware cancellation. Ownership is verified before this is
   * called. Without it the HTTP API records cancellation intent only.
   */
  cancelTask?(input: {
    task: TaskSnapshot;
    ownerId: string;
    expectedVersion?: number;
    request: Request;
  }): Promise<TaskSnapshot>;
  /** Set false when the mounted runtime cannot cancel; requests fail before Task mutation. */
  cancel?: boolean;
  /** Optional health report mounted at `<basePath>/_health`. */
  health?(): Promise<unknown> | unknown;
  /** Explicit no-progress thresholds. Omit to disable derived risk labels. */
  riskPolicy?: TaskRiskPolicy;
  /** Set false to disable SSE. Snapshots remain authoritative. */
  stream?: TaskSSEOptions | false;
  /** Optional durable direct-to-storage multipart owner surface. */
  uploads?: ArtifactUploadService;
}

export interface TaskRiskPolicy {
  atRiskAfterMs: number;
  stuckAfterMs: number;
}

export type TaskAuthorizationAction = 'task:read' | 'task:write' | 'task:cancel' | 'task:retry' | 'waitpoint:write' | 'artifact:read' | 'artifact:write';
export interface TaskAuthorizationInput {
  request: Request;
  ownerId: string;
  tenantId: string;
  action: TaskAuthorizationAction;
  taskId?: string;
}

/** Capabilities the owner UI may render without discovering support via 501. */
export interface TaskSurfaceCapabilities {
  schemaVersion: 1;
  cancel: boolean;
  retry: boolean;
  result: boolean;
  waitpoints: true;
  stream: boolean;
  risk: false | TaskRiskPolicy;
  tenant: boolean;
  verifications: true;
  artifacts: boolean;
  artifactUploads?: boolean;
  authorization: boolean;
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
  if (options.requireTenantAuthorization && !options.authorize) {
    throw new TypeError('tenant authorization requires authorize');
  }
  const basePath = normalizeBasePath(options.basePath ?? '/tasks');
  const riskPolicy = normalizeRiskPolicy(options.riskPolicy);
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
      const tenantId = options.tenantFromRequest ? await options.tenantFromRequest(request) : 'default';
      if (!tenantId?.trim()) return json({ code: 'RHINOQ_UNAUTHORIZED', message: 'tenant context is required' }, 401);
      const url = new URL(request.url);
      const relative = routeParts(url.pathname, basePath);
      if (relative === undefined) {
        return json({ code: 'RHINOQ_NOT_FOUND' }, 404);
      }

      if (options.authorize) {
        const taskId = relative[0] && !relative[0].startsWith('_') ? relative[0] : undefined;
        const allowed = await options.authorize({
          request, ownerId, tenantId, taskId,
          action: taskAuthorizationAction(request.method, relative),
        });
        if (!allowed) return json({ code: 'RHINOQ_FORBIDDEN', message: 'tenant policy denied this Task action' }, 403);
      }

      if (request.method === 'GET' && relative.length === 0) {
        const limit = integerQuery(url, 'limit', 50);
        const offset = integerQuery(url, 'offset', 0);
        return json({ tasks: await options.tasks.listTasks(ownerId, limit, offset, tenantId) });
      }
      if (request.method === 'GET' && relative.length === 1 && relative[0] === '_events') {
        if (options.stream === false) return json({ code: 'RHINOQ_STREAM_DISABLED' }, 404);
        return openStream((closed) => taskListEventResponse(options.tasks, request, ownerId, integerQuery(url, 'limit', 50), integerQuery(url, 'offset', 0), options.stream || undefined, closed, tenantId));
      }
      if (request.method === 'GET' && relative.length === 1 && relative[0] === '_health') {
        return options.health ? json(await options.health()) : json({ status: 'ok' });
      }
      if (request.method === 'GET' && relative.length === 1 && relative[0] === '_capabilities') {
        const capabilities: TaskSurfaceCapabilities = {
          schemaVersion: 1,
          cancel: options.cancel !== false,
          retry: typeof options.retryTask === 'function',
          result: typeof options.resolveResult === 'function',
          waitpoints: true,
          stream: options.stream !== false,
          risk: riskPolicy ?? false,
          tenant: typeof options.tenantFromRequest === 'function',
          verifications: true,
          artifacts: typeof options.resolveArtifact === 'function',
          ...(options.uploads ? { artifactUploads: true } : {}),
          authorization: typeof options.authorize === 'function',
        };
        return json(capabilities);
      }
      if (request.method === 'GET' && relative.length === 1 && relative[0] === '_risk') {
        if (!riskPolicy) return json({ code: 'RHINOQ_RISK_POLICY_NOT_CONFIGURED' }, 404);
        const limit = integerQuery(url, 'limit', 50);
        if (limit < 1 || limit > 100) return json({ code: 'RHINOQ_INVALID_REQUEST', message: 'risk limit must be 1..100' }, 400);
        const tasks = await options.tasks.listTasksByState({
          states: ['pending', 'queued', 'running', 'cancel_requested'],
          idleForMs: riskPolicy.atRiskAfterMs,
          ownerId,
          tenantId,
          limit,
        });
        const now = Date.now();
        return json({
          policy: riskPolicy,
          tasks: tasks.map((task) => {
            const idleForMs = Math.max(0, now - Date.parse(task.updatedAt));
            return { ...task, risk: idleForMs >= riskPolicy.stuckAfterMs ? 'stuck' : 'at_risk', idleForMs };
          }),
        });
      }
      if (request.method === 'GET' && relative.length === 1 && relative[0] === '_verified') {
        const limit = integerQuery(url, 'limit', 20);
        if (limit < 1 || limit > 100) return json({ code: 'RHINOQ_INVALID_REQUEST', message: 'verification limit must be 1..100' }, 400);
        return json({ verifications: await options.tasks.listRecentlyVerifiedForOwner(ownerId, limit, tenantId) });
      }
      if (request.method === 'GET' && relative.length === 1 && relative[0] === '_waitpoints') {
        const limit = integerQuery(url, 'limit', 50);
        if (limit < 1 || limit > 100) {
          return json({ code: 'RHINOQ_INVALID_REQUEST', message: 'waitpoint limit must be 1..100' }, 400);
        }
        return json({ waitpoints: await options.tasks.listWaitingTaskWaitpointsForOwner(ownerId, limit, tenantId) });
      }
      if (relative[0] === '_uploads') {
        if (!options.uploads) return json({ code: 'RHINOQ_ARTIFACT_UPLOAD_NOT_CONFIGURED' }, 501);
        if (request.method === 'POST' && relative.length === 1) {
          const body = await request.json() as Omit<CreateArtifactUploadRequest, 'ownerId' | 'tenantId'>;
          return json(await options.uploads.create({ ...body, ownerId, tenantId }), 201);
        }
        const uploadId = relative[1];
        if (!uploadId) return json({ code: 'RHINOQ_NOT_FOUND' }, 404);
        if (request.method === 'GET' && relative.length === 2) return json(await options.uploads.resume(uploadId,ownerId,tenantId));
        if (request.method === 'POST' && relative.length === 4 && relative[2] === 'parts' && /^\d+$/.test(relative[3]!)) {
          return json(await options.uploads.signPart(uploadId, ownerId, tenantId, Number(relative[3])));
        }
        const body = await request.json().catch(() => ({})) as any;
        if (request.method === 'POST' && relative.length === 3 && relative[2] === 'parts') return json(await options.uploads.recordPart(uploadId, ownerId, tenantId, Number(body.expectedVersion), body.part));
        if (request.method === 'POST' && relative.length === 3 && relative[2] === 'complete') return json(await options.uploads.complete(uploadId, ownerId, tenantId, Number(body.expectedVersion), body.checksumSha256));
        if (request.method === 'POST' && relative.length === 3 && relative[2] === 'abort') return json(await options.uploads.abort(uploadId, ownerId, tenantId, Number(body.expectedVersion)));
        return json({ code: 'RHINOQ_NOT_FOUND' }, 404);
      }
      const taskId = relative[0];
      if (!taskId) {
        return json({ code: 'RHINOQ_NOT_FOUND' }, 404);
      }
      if (request.method === 'GET' && relative.length === 1) {
        return json(await options.tasks.getTaskForOwner(taskId, ownerId, tenantId));
      }
	  if (request.method === 'GET' && relative.length === 2 && relative[1] === 'events') {
		if (options.stream === false) return json({ code: 'RHINOQ_STREAM_DISABLED' }, 404);
		await options.tasks.getTaskSummaryForOwner(taskId, ownerId, tenantId);
		return openStream((closed) => taskEventResponse(options.tasks, request, ownerId, taskId, options.stream || undefined, closed, tenantId));
	  }
	  if (request.method === 'GET' && relative.length === 2 && relative[1] === 'summary') {
		const summary: TaskSummary = await options.tasks.getTaskSummaryForOwner(taskId, ownerId, tenantId);
		return json(summary);
	  }
      if (request.method === 'GET' && relative.length === 2 && relative[1] === 'failed-items') {
        const task = await options.tasks.getTaskForOwner(taskId, ownerId, tenantId);
        const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json';
        return new Response(failedTaskItems(task, format), { headers: {
          'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${safeFilename(taskId)}-failed.${format}"`,
          'cache-control': 'private, no-store',
        } });
      }
      if (request.method === 'GET' && relative.length === 2 && relative[1] === 'manifest') {
        const task = await options.tasks.getTaskForOwner(taskId, ownerId, tenantId);
        const results = await options.tasks.getTaskExecutionResultsForOwner(taskId, ownerId, tenantId);
        return json(taskGroupManifest(task, results.executions));
      }
	  if (request.method === 'GET' && relative.length === 2 && relative[1] === 'waitpoints') {
		const limit = integerQuery(url, 'limit', 100);
		if (limit < 1 || limit > 100) {
		  return json({ code: 'RHINOQ_INVALID_REQUEST', message: 'waitpoint limit must be 1..100' }, 400);
		}
		return json({
		  waitpoints: await options.tasks.listTaskWaitpointsForOwner(taskId, ownerId, limit, tenantId),
		});
	  }
	  if (request.method === 'GET' && relative.length === 3 && relative[1] === 'executions' && relative[2] === 'page') {
		const page: TaskExecutionPage = await options.tasks.listTaskExecutionsForOwner(
		  taskId, ownerId, url.searchParams.get('cursor') ?? '', integerQuery(url, 'limit', 100), tenantId,
		);
		return json(page);
	  }
      if (
        request.method === 'GET' &&
        relative.length === 2 &&
        relative[1] === 'executions'
      ) {
        const results: TaskExecutionResults =
          await options.tasks.getTaskExecutionResultsForOwner(taskId, ownerId, tenantId);
        return json(results);
      }
      if (request.method === 'POST' && relative.length === 2 && relative[1] === 'waitpoints') {
        await options.tasks.getTaskSummaryForOwner(taskId, ownerId, tenantId);
        const body = await request.json() as TaskWaitpointCreateRequest;
        return json(await options.tasks.createTaskWaitpoint(taskId, body), 201);
      }
      if (relative.length === 3 && relative[1] === 'waitpoints') {
        const waitpoint = await options.tasks.getTaskWaitpoint(relative[2]!, ownerId, tenantId);
        if (waitpoint.taskId !== taskId) return json({ code: 'RHINOQ_WAITPOINT_NOT_FOUND' }, 404);
        if (request.method === 'GET') return json(waitpoint);
        if (request.method === 'POST') {
          const body = await request.json() as TaskWaitpointResolveRequest;
          return json(await options.tasks.resolveTaskWaitpoint(relative[2]!, ownerId, body, tenantId));
        }
      }
      if (request.method === 'GET' && relative.length === 2 && relative[1] === 'verifications') {
        const limit = integerQuery(url, 'limit', 50);
        if (limit < 1 || limit > 100) return json({ code: 'RHINOQ_INVALID_REQUEST', message: 'verification limit must be 1..100' }, 400);
        return json({ verifications: await options.tasks.listTaskVerificationsForOwner(taskId, ownerId, limit, tenantId) });
      }
      if (request.method === 'GET' && relative.length === 2 && relative[1] === 'artifacts') {
        const limit = integerQuery(url, 'limit', 100);
        if (limit < 1 || limit > 100) return json({ code: 'RHINOQ_INVALID_REQUEST', message: 'artifact limit must be 1..100' }, 400);
        return json({ artifacts: await options.tasks.listTaskArtifactsForOwner(taskId, ownerId, limit, tenantId) });
      }
      if (request.method === 'POST' && relative.length === 4 && relative[1] === 'artifacts' && relative[3] === 'refresh') {
        const artifact = await options.tasks.getTaskArtifactForOwner(relative[2]!, ownerId, tenantId);
        if (artifact.taskId !== taskId) return json({ code: 'RHINOQ_ARTIFACT_NOT_FOUND' }, 404);
        const body = await request.json().catch(() => undefined);
        const refreshed = await options.tasks.refreshTaskArtifact(relative[2]!, body);
        return json(refreshed);
      }
      if (request.method === 'GET' && relative.length === 4 && relative[1] === 'artifacts' && relative[3] === 'download') {
        if (!options.resolveArtifact) return json({ code: 'RHINOQ_ARTIFACT_DOWNLOAD_NOT_CONFIGURED' }, 501);
        const artifact = await options.tasks.getTaskArtifactForOwner(relative[2]!, ownerId, tenantId);
        if (artifact.taskId !== taskId) return json({ code: 'RHINOQ_ARTIFACT_NOT_FOUND' }, 404);
        const resolved = await options.resolveArtifact(artifact, request, ownerId, tenantId);
        return resolved instanceof Response ? resolved : json(resolved);
      }
      if (
        request.method === 'GET' &&
        relative.length === 2 &&
        relative[1] === 'result'
      ) {
        if (!options.resolveResult) {
          return json({
            code: 'RHINOQ_RESULT_NOT_CONFIGURED',
            message: 'Result download is not configured for this application.',
            retryable: false,
            nextAction: 'Configure app.http({ resolveResult }) with owner-aware result authorization.',
            docs: 'https://github.com/madebyduy/RhinoQ/blob/main/docs/task-api.md#resolve-a-result',
          }, 501);
        }
        const result = await options.tasks.getTaskResultForOwner(taskId, ownerId, tenantId);
        const resolved = await options.resolveResult(result, request, ownerId, tenantId);
        return resolved instanceof Response ? resolved : json(resolved);
      }
      if (
        request.method === 'POST' &&
        relative.length === 2 &&
        relative[1] === 'cancel'
      ) {
        if (options.cancel === false) {
          return json({
            code: 'RHINOQ_UNSUPPORTED',
            message: 'Cancellation is not configured for this owner API; no Task state was changed.',
            field: 'action',
            retryable: false,
            nextAction: 'Configure app.http({ cancelTask }) or open the runtime tool if it offers a safe cancellation workflow.',
            docs: 'https://github.com/madebyduy/RhinoQ/blob/main/docs/task-api.md#cancel-a-task',
          }, 409);
        }
        const body = await request.json().catch(() => ({})) as { expectedVersion?: unknown };
        if (body.expectedVersion !== undefined &&
            (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) <= 0)) {
          return json({
            code: 'RHINOQ_INVALID_REQUEST',
            message: 'expectedVersion must be a positive integer when supplied.',
            field: 'expectedVersion',
            retryable: false,
            expectedShape: { expectedVersion: 7 },
            nextAction: 'Read the latest Task entityVersion, or omit expectedVersion for an unfenced cancellation request.',
            docs: 'https://github.com/madebyduy/RhinoQ/blob/main/docs/task-api.md#cancel-a-task',
          }, 400);
        }
        const expectedVersion = body.expectedVersion === undefined
          ? undefined
          : Number(body.expectedVersion);
        const ownedTask = options.cancelTask
          ? await options.tasks.getTaskForOwner(taskId, ownerId, tenantId)
          : undefined;
        const snapshot: TaskSnapshot = options.cancelTask && ownedTask
          ? await options.cancelTask({ task: ownedTask, ownerId, expectedVersion, request })
          : expectedVersion === undefined
            ? await cancelWithoutFence(options.tasks, taskId, ownerId, tenantId)
            : await options.tasks.requestTaskCancellationForOwner(
              taskId,
              ownerId,
              expectedVersion,
              tenantId,
            );
        return json(snapshot);
      }
      if (request.method === 'POST' && relative.length === 2 && relative[1] === 'retry') {
        if (!options.retryTask) return json({
          code: 'RHINOQ_RETRY_NOT_CONFIGURED',
          message: 'Retry is not configured for this owner API.',
          retryable: false,
          nextAction: 'Configure app.http({ retryTask }) with a durable commandId and application-owned dispatch policy.',
          docs: 'https://github.com/madebyduy/RhinoQ/blob/main/docs/task-api.md#retry-a-task',
        }, 501);
        const body = await request.json() as { expectedVersion?: unknown; commandId?: unknown };
        if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) <= 0 ||
            typeof body.commandId !== 'string' || !body.commandId.trim()) {
          return json({
            code: 'RHINOQ_INVALID_REQUEST',
            message: 'expectedVersion must be a positive integer and commandId must be a non-empty string.',
            field: !Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) <= 0 ? 'expectedVersion' : 'commandId',
            retryable: false,
            expectedShape: { expectedVersion: 7, commandId: 'task-123-retry-7' },
            nextAction: 'Read the latest Task entityVersion and create a stable commandId for this retry intent.',
            docs: 'https://github.com/madebyduy/RhinoQ/blob/main/docs/task-api.md#retry-a-task',
          }, 400);
        }
        const task = await options.tasks.getTaskForOwner(taskId, ownerId, tenantId);
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

  capabilities(): Promise<TaskSurfaceCapabilities> {
    return this.send('GET', '/_capabilities');
  }

  getTaskResult(taskId: string): Promise<unknown> {
    return this.send('GET', `/${path(taskId)}/result`);
  }

  getTaskExecutionResults(taskId: string): Promise<TaskExecutionResults> {
    return this.send('GET', `/${path(taskId)}/executions`);
  }

  async listTaskWaitpoints(taskId: string, limit = 100): Promise<TaskWaitpoint[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('waitpoint limit must be 1..100');
    const result = await this.send<{ waitpoints: TaskWaitpoint[] }>('GET', `/${path(taskId)}/waitpoints?limit=${limit}`);
    return result.waitpoints;
  }

  async listWaitingTaskWaitpoints(limit = 50): Promise<TaskWaitpoint[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('waitpoint limit must be 1..100');
    const result = await this.send<{ waitpoints: TaskWaitpoint[] }>('GET', `/_waitpoints?limit=${limit}`);
    return result.waitpoints;
  }

  async listRecentlyVerified(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('verification limit must be 1..100');
    const result = await this.send<{ verifications: import('../gateway/types.js').TaskVerificationRecord[] }>('GET', `/_verified?limit=${limit}`);
    return result.verifications;
  }

  async listTaskVerifications(taskId: string, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('verification limit must be 1..100');
    const result = await this.send<{ verifications: import('../gateway/types.js').TaskVerificationRecord[] }>('GET', `/${path(taskId)}/verifications?limit=${limit}`);
    return result.verifications;
  }

  async listTaskArtifacts(taskId: string, limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('artifact limit must be 1..100');
    const result = await this.send<{ artifacts: import('../gateway/types.js').TaskArtifact[] }>('GET', `/${path(taskId)}/artifacts?limit=${limit}`);
    return result.artifacts;
  }

  getTaskArtifactDownload(taskId: string, artifactId: string): Promise<unknown> {
    return this.send('GET', `/${path(taskId)}/artifacts/${path(artifactId)}/download`);
  }

  refreshTaskArtifact(taskId: string, artifactId: string, request: import('../gateway/types.js').TaskArtifactRefreshRequest): Promise<import('../gateway/types.js').TaskArtifact> {
    return this.send('POST', `/${path(taskId)}/artifacts/${path(artifactId)}/refresh`, request);
  }

  createArtifactUpload(request: Omit<CreateArtifactUploadRequest, 'ownerId' | 'tenantId'>): Promise<{ session: ArtifactUploadSession; plan: import('./artifact-storage.js').MultipartPlan }> { return this.send('POST','/_uploads',request); }
  resumeArtifactUpload(id:string):Promise<ArtifactUploadSession>{return this.send('GET',`/_uploads/${path(id)}`);}
  signArtifactUploadPart(id:string,partNumber:number):Promise<{url:string;expiresAt:string}>{return this.send('POST',`/_uploads/${path(id)}/parts/${partNumber}`);}
  recordArtifactUploadPart(id:string,expectedVersion:number,part:ArtifactUploadPart):Promise<ArtifactUploadSession>{return this.send('POST',`/_uploads/${path(id)}/parts`,{expectedVersion,part});}
  completeArtifactUpload(id:string,expectedVersion:number,checksumSha256?:string):Promise<{session:ArtifactUploadSession;artifact?:import('../gateway/types.js').TaskArtifact}>{return this.send('POST',`/_uploads/${path(id)}/complete`,{expectedVersion,...(checksumSha256?{checksumSha256}:{})});}
  abortArtifactUpload(id:string,expectedVersion:number):Promise<ArtifactUploadSession>{return this.send('POST',`/_uploads/${path(id)}/abort`,{expectedVersion});}

  listAtRiskTasks(limit = 50): Promise<{
    policy: TaskRiskPolicy;
    tasks: Array<TaskSummary & { risk: 'at_risk' | 'stuck'; idleForMs: number }>;
  }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('risk limit must be 1..100');
    return this.send('GET', `/_risk?limit=${limit}`);
  }

  getTaskGroupManifest(taskId: string): Promise<unknown> { return this.send('GET', `/${path(taskId)}/manifest`); }
  async downloadFailedTaskItems(taskId: string, format: 'json' | 'csv' = 'json'): Promise<Blob> {
    const headers = new Headers(await this.getHeaders?.());
    const response = await this.doFetch(`${this.url}/${path(taskId)}/failed-items?format=${format}`, { headers });
    if (!response.ok) {
      const payload = await response.json() as Record<string,unknown>;
      throw taskHTTPError(payload, response);
    }
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
      throw taskHTTPError(payload, response);
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

function taskHTTPError(payload: Record<string, unknown>, response: Response): RhinoQError {
  return new RhinoQError(
    typeof payload.code === 'string' ? payload.code : 'RHINOQ_HTTP_ERROR',
    typeof payload.message === 'string' ? payload.message : response.statusText,
    payload.retryable === true,
    {
      status: response.status,
      ...(typeof payload.field === 'string' ? { field: payload.field } : {}),
      ...('expectedShape' in payload ? { expectedShape: payload.expectedShape } : {}),
      ...(typeof payload.nextAction === 'string' ? { nextAction: payload.nextAction } : {}),
      ...(typeof payload.docs === 'string' ? { docs: payload.docs } : {}),
    },
  );
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
  tasks: OwnerFacingTaskStore,
  taskId: string,
  ownerId: string,
  tenantId: string,
): Promise<TaskSnapshot> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await tasks.getTaskForOwner(taskId, ownerId, tenantId);
    // A terminal Task answers a late request with `too_late` rather than an
    // error, and re-requesting an in-flight cancellation is a no-op.
    if (current.state === 'cancel_requested') {
      return current;
    }
    try {
      return await tasks.requestTaskCancellationForOwner(taskId, ownerId, current.entityVersion, tenantId);
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

function normalizeRiskPolicy(policy?: TaskRiskPolicy): TaskRiskPolicy | undefined {
  if (!policy) return undefined;
  if (!Number.isFinite(policy.atRiskAfterMs) || policy.atRiskAfterMs < 1_000 ||
      !Number.isFinite(policy.stuckAfterMs) || policy.stuckAfterMs <= policy.atRiskAfterMs) {
    throw new RangeError('riskPolicy requires stuckAfterMs > atRiskAfterMs >= 1000');
  }
  return { atRiskAfterMs: Math.floor(policy.atRiskAfterMs), stuckAfterMs: Math.floor(policy.stuckAfterMs) };
}

function taskAuthorizationAction(method: string, relative: string[]): TaskAuthorizationAction {
  if (relative[0] === '_uploads') return 'artifact:write';
  if (method === 'GET') {
    return relative[1] === 'artifacts' || relative[3] === 'download' ? 'artifact:read' : 'task:read';
  }
  if (relative[1] === 'cancel') return 'task:cancel';
  if (relative[1] === 'retry') return 'task:retry';
  if (relative[1] === 'waitpoints') return 'waitpoint:write';
  return 'task:write';
}

function path(value: string): string {
  if (!value?.trim()) {
    throw new TypeError('task id is required');
  }
  return encodeURIComponent(value);
}

function safeFilename(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'task'; }
