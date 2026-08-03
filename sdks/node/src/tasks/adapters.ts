import { createTaskRequestHandler, type TaskRequestHandlerOptions } from './http.js';

/**
 * Structural subset of a Node request. Express and NestJS's Express platform
 * add `originalUrl`/`baseUrl`; raw `node:http` does not. RhinoQ does not import
 * either framework.
 */
export interface NodeTaskRequest {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end' | 'error', listener: (error?: unknown) => void): unknown;
}

/** Structural subset of a Node response. */
export interface NodeTaskResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(chunk?: string): unknown;
}

export interface NodeTaskMiddlewareOptions extends TaskRequestHandlerOptions {
  /**
   * Origin used to build the absolute URL the Fetch handler needs. Only the
   * pathname and query are read, so the default is fine unless the application
   * routes on the Host header.
   */
  origin?: string;
}

/**
 * The task routes, in the order a router must declare them.
 *
 * The collection path (`/tasks`) is not matched by the wildcard (`/tasks/*`) in
 * Express 4, Fastify or NestJS. Mounting only the wildcard silently loses
 * `listTasks`, which is why every integration was declaring two routes by hand
 * and discovering the second one from a 404.
 */
export function taskRoutePatterns(basePath = '/tasks'): [string, string] {
  const base = `/${basePath}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/tasks';
  return [base, `${base}/*`];
}

/**
 * Adapts the Fetch handler to a Node/Express/NestJS middleware.
 *
 * Mount it once — `app.use('/tasks', middleware)` — and both the collection and
 * the item routes work. Express strips the mount path from `req.url`, so the
 * middleware reads `originalUrl` when the framework provides it; under raw
 * `node:http` the unmodified `req.url` is already the full path.
 *
 * `next` is called for a path outside `basePath`, so the middleware composes
 * with the application's other routes instead of answering 404 for them.
 */
export function createNodeTaskMiddleware(
  options: NodeTaskMiddlewareOptions,
): (request: NodeTaskRequest, response: NodeTaskResponse, next?: (error?: unknown) => void) => void {
  const handler = createTaskRequestHandler(options);
  const origin = (options.origin ?? 'http://rhinoq.invalid').replace(/\/+$/, '');
  const [base] = taskRoutePatterns(options.basePath);

  return (request, response, next) => {
    const pathname = new URL(`${origin}${request.originalUrl ?? request.url ?? '/'}`).pathname;
    if (next && pathname !== base && !pathname.startsWith(`${base}/`)) {
      next();
      return;
    }
    void (async () => {
      const fetchRequest = await toFetchRequest(request, origin);
      const result = await handler(fetchRequest);
      await writeNodeResponse(result, response);
    })().catch((error: unknown) => {
      // A framework `next(error)` reaches the application's error handler,
      // which is where its logging and request ID live. Without one there is
      // nothing left to do but answer, or the socket hangs.
      if (next) {
        next(error);
        return;
      }
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ code: 'RHINOQ_INTERNAL', message: 'Task request failed' }));
    });
  };
}

/** Structural subset of a Fastify instance. */
export interface FastifyLike {
  all(
    path: string,
    handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<unknown>,
  ): unknown;
}

export interface FastifyRequestLike {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  raw?: { url?: string };
}

export interface FastifyReplyLike {
  status(code: number): FastifyReplyLike;
  header(name: string, value: string): FastifyReplyLike;
  send(payload: string): unknown;
}

/**
 * Registers both task routes on a Fastify instance.
 *
 * Fastify's wildcard does not match the bare collection path either, so this
 * declares `/tasks` and `/tasks/*` for the caller. Fastify has already parsed
 * a JSON body by the time the handler runs, so it is re-serialised rather than
 * read from the stream a second time.
 */
export function registerFastifyTaskRoutes(
  fastify: FastifyLike,
  options: NodeTaskMiddlewareOptions,
): void {
  const handler = createTaskRequestHandler(options);
  const origin = (options.origin ?? 'http://rhinoq.invalid').replace(/\/+$/, '');

  const respond = async (request: FastifyRequestLike, reply: FastifyReplyLike): Promise<unknown> => {
    const hasBody = request.body !== undefined && request.body !== null && request.method !== 'GET';
    const result = await handler(new Request(`${origin}${request.raw?.url ?? request.url}`, {
      method: request.method,
      headers: toHeaders(request.headers),
      ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
    }));
    const text = await result.text();
    reply.status(result.status);
    for (const [name, value] of result.headers) reply.header(name, value);
    return reply.send(text);
  };

  for (const pattern of taskRoutePatterns(options.basePath)) {
    fastify.all(pattern, respond);
  }
}

async function toFetchRequest(request: NodeTaskRequest, origin: string): Promise<Request> {
  const method = request.method ?? 'GET';
  const url = `${origin}${request.originalUrl ?? request.url ?? '/'}`;
  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { method, headers: toHeaders(request.headers) });
  }
  return new Request(url, {
    method,
    headers: toHeaders(request.headers),
    body: await readBody(request),
  });
}

// Express's json() middleware may already have consumed the stream. When it
// has, `body` is present and the stream ends immediately, so the parsed value
// is re-serialised instead of waiting for bytes that will never arrive.
async function readBody(request: NodeTaskRequest): Promise<string> {
  const parsed = (request as { body?: unknown }).body;
  if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
    return JSON.stringify(parsed);
  }
  if (typeof parsed === 'string') {
    return parsed;
  }
  return new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    request.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    request.on('end', () => resolve(chunks.join('')));
    request.on('error', (error) => reject(error instanceof Error ? error : new Error(String(error))));
  });
}

function toHeaders(source: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

async function writeNodeResponse(result: Response, response: NodeTaskResponse): Promise<void> {
  const text = await result.text();
  response.statusCode = result.status;
  for (const [name, value] of result.headers) response.setHeader(name, value);
  response.end(text);
}
