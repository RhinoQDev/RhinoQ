import type { TaskSnapshot, TaskSummary } from '../gateway/types.js';

export type TaskStreamSnapshot = TaskSnapshot | TaskSummary;
export type TaskStreamEvent =
  | { type: 'task.snapshot'; version: number; task: TaskStreamSnapshot }
  | { type: 'task.page'; tasks: TaskSnapshot[] }
  | { type: 'task.heartbeat'; serverTime: string }
  | { type: 'task.error'; code: string };

export interface TaskSSESource {
  getTaskSummaryForOwner(taskId: string, ownerId: string, tenantId?: string): Promise<TaskSummary>;
  listTasks(ownerId: string, limit: number, offset: number, tenantId?: string): Promise<TaskSnapshot[]>;
}
export interface TaskSSEOptions { pollIntervalMs?: number; heartbeatMs?: number; maxConnections?: number; }

export function taskEventResponse(source: TaskSSESource, request: Request, ownerId: string, taskId: string, options: TaskSSEOptions = {}, onClose?: () => void, tenantId = 'default'): Response {
  const lastVersion = parseLastVersion(request.headers.get('last-event-id'));
  return sseResponse(request, async (send, signal) => {
    let version = lastVersion;
    const pollMs = bounded(options.pollIntervalMs ?? 1_000, 250, 60_000, 'stream poll interval');
    const heartbeatMs = bounded(options.heartbeatMs ?? 15_000, 1_000, 120_000, 'stream heartbeat');
    let heartbeatAt = Date.now() + heartbeatMs;
    while (!signal.aborted) {
      const task = await source.getTaskSummaryForOwner(taskId, ownerId, tenantId);
      if (task.entityVersion > version) { version = task.entityVersion; send('task.snapshot', task, String(version)); }
      if (Date.now() >= heartbeatAt) { send('task.heartbeat', { serverTime: new Date().toISOString() }); heartbeatAt = Date.now() + heartbeatMs; }
      if (isTerminal(task.state) || !(await wait(pollMs, signal))) return;
    }
  }, onClose);
}

export function taskListEventResponse(source: TaskSSESource, request: Request, ownerId: string, limit: number, offset: number, options: TaskSSEOptions = {}, onClose?: () => void, tenantId = 'default'): Response {
  return sseResponse(request, async (send, signal) => {
    const versions = new Map<string, number>();
    let pageFingerprint = '';
    const pollMs = bounded(options.pollIntervalMs ?? 2_000, 250, 60_000, 'stream poll interval');
    const heartbeatMs = bounded(options.heartbeatMs ?? 15_000, 1_000, 120_000, 'stream heartbeat');
    let heartbeatAt = Date.now() + heartbeatMs;
    while (!signal.aborted) {
      const tasks = await source.listTasks(ownerId, limit, offset, tenantId);
      const fingerprint = tasks.map((task) => `${task.id}:${task.entityVersion}`).join('|');
      if (fingerprint !== pageFingerprint) { pageFingerprint = fingerprint; send('task.page', { tasks }); }
      for (const task of tasks) {
        if ((versions.get(task.id) ?? 0) < task.entityVersion) {
          versions.set(task.id, task.entityVersion);
          send('task.snapshot', task, `${encodeURIComponent(task.id)}:${task.entityVersion}`);
        }
      }
      if (Date.now() >= heartbeatAt) { send('task.heartbeat', { serverTime: new Date().toISOString() }); heartbeatAt = Date.now() + heartbeatMs; }
      if (!(await wait(pollMs, signal))) return;
    }
  }, onClose);
}

function sseResponse(request: Request, produce: (send: (event: string, data: unknown, id?: string) => void, signal: AbortSignal) => Promise<void>, onClose?: () => void): Response {
  const encoder = new TextEncoder();
  const local = new AbortController();
  let removeRequestAbort = () => {};
  let closed = false;
  const close = () => { if (closed) return; closed = true; removeRequestAbort(); onClose?.(); };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => local.abort();
      request.signal.addEventListener('abort', abort, { once: true });
      removeRequestAbort = () => request.signal.removeEventListener('abort', abort);
      const send = (event: string, data: unknown, id?: string) => {
        if (local.signal.aborted) return;
        controller.enqueue(encoder.encode(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      controller.enqueue(encoder.encode('retry: 1000\n\n'));
      void produce(send, local.signal).then(
        () => { close(); if (!local.signal.aborted) controller.close(); },
        () => { send('task.error', { code: 'RHINOQ_STREAM_READ_FAILED' }); close(); if (!local.signal.aborted) controller.close(); },
      );
    },
    cancel() { close(); local.abort(); },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' } });
}

export async function* parseTaskEventStream(response: Response, signal?: AbortSignal): AsyncGenerator<TaskStreamEvent> {
  if (!response.ok) throw new Error(`Task event stream failed: ${response.status}`);
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) throw new TypeError('Task event endpoint did not return text/event-stream');
  if (!response.body) throw new TypeError('Task event response has no body');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = parseBlock(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
        if (event) yield event;
      }
    }
  } finally { await reader.cancel().catch(() => undefined); }
}

function parseBlock(block: string): TaskStreamEvent | undefined {
  let event = 'message'; const data: string[] = [];
  for (const line of block.split('\n')) { if (line.startsWith('event:')) event = line.slice(6).trim(); if (line.startsWith('data:')) data.push(line.slice(5).trimStart()); }
  if (!data.length) return undefined;
  const payload = JSON.parse(data.join('\n')) as Record<string, unknown>;
  if (event === 'task.snapshot' && typeof payload.entityVersion === 'number') return { type: 'task.snapshot', version: payload.entityVersion, task: payload as unknown as TaskStreamSnapshot };
  if (event === 'task.page' && Array.isArray(payload.tasks)) return { type: 'task.page', tasks: payload.tasks as TaskSnapshot[] };
  if (event === 'task.heartbeat' && typeof payload.serverTime === 'string') return { type: 'task.heartbeat', serverTime: payload.serverTime };
  if (event === 'task.error' && typeof payload.code === 'string') return { type: 'task.error', code: payload.code };
  return undefined;
}
function parseLastVersion(value: string | null): number { if (!value || !/^\d+$/.test(value)) return 0; const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : 0; }
function bounded(value: number, min: number, max: number, name: string): number { if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} must be ${min}..${max}ms`); return value; }
function isTerminal(state: string): boolean { return state === 'succeeded' || state === 'failed' || state === 'cancelled'; }
function wait(ms: number, signal: AbortSignal): Promise<boolean> { if (signal.aborted) return Promise.resolve(false); return new Promise((resolve) => { const timer = setTimeout(() => finish(true), ms); const abort = () => finish(false); const finish = (value: boolean) => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(value); }; signal.addEventListener('abort', abort, { once: true }); }); }
