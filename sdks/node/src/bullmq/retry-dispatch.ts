import { createHmac, timingSafeEqual } from 'node:crypto';

export interface RetryDispatchQueue {
  getJob(id: string): Promise<{ id?: string } | undefined>;
  add(name: string, data: unknown, options: { jobId: string; removeOnComplete: false; removeOnFail: false }): Promise<unknown>;
}

export interface RetryDispatchIntent {
  schemaVersion: 1;
  commandId: string;
  taskId: string;
  executionId: string;
  runtime: string;
  queue: string;
  jobName: string;
  data: unknown;
  attempt: number;
}

export interface BullMQRetryDispatchOptions {
  secret: string;
  queues: Readonly<Record<string, RetryDispatchQueue>>;
}

/**
 * Authenticated receiver for Go's durable retry outbox publisher. BullMQ sees
 * the immutable Execution id as jobId, so a lost HTTP response converges on
 * the already-created job instead of allocating another identity.
 */
export function createBullMQRetryDispatchHandler(options: BullMQRetryDispatchOptions) {
  if (!options.secret?.trim()) throw new TypeError('retry dispatch secret is required');
  if (!options.queues || Object.keys(options.queues).length === 0) throw new TypeError('at least one retry dispatch queue is required');

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return response(405, 'RHINOQ_METHOD_NOT_ALLOWED');
    const bytes = new Uint8Array(await request.arrayBuffer());
    const signature = request.headers.get('x-rhinoq-signature') ?? '';
    if (!validSignature(bytes, signature, options.secret)) return response(401, 'RHINOQ_INVALID_SIGNATURE');
    let envelope: { id?: unknown; eventType?: unknown; payload?: unknown };
    try { envelope = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return response(400, 'RHINOQ_INVALID_EVENT'); }
    if (!Number.isSafeInteger(envelope.id) || envelope.eventType !== 'task.retry.dispatch_requested' || !intentValid(envelope.payload)) {
      return response(400, 'RHINOQ_INVALID_EVENT');
    }
    const intent = envelope.payload;
    const queue = options.queues[intent.queue];
    if (!queue) return response(422, 'RHINOQ_QUEUE_NOT_REGISTERED');
    const existing = await queue.getJob(intent.executionId);
    if (!existing) await queue.add(intent.jobName, intent.data, {
      jobId: intent.executionId,
      // The outbox acknowledgement happens after Queue.add returns. Removing a
      // fast job before that acknowledgement would erase BullMQ's duplicate
      // observation and turn a lost response into a second execution.
      removeOnComplete: false,
      removeOnFail: false,
    });
    return new Response(null, { status: 204 });
  };
}

function validSignature(body: Uint8Array, supplied: string, secret: string): boolean {
  if (!supplied.startsWith('v1=')) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  let actual: Buffer;
  try { actual = Buffer.from(supplied.slice(3), 'hex'); } catch { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function intentValid(value: unknown): value is RetryDispatchIntent {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === 1 && positiveText(item.commandId) && positiveText(item.taskId) &&
    positiveText(item.executionId) && positiveText(item.runtime) && positiveText(item.queue) &&
    positiveText(item.jobName) && Number.isSafeInteger(item.attempt) && Number(item.attempt) > 0 &&
    Object.prototype.hasOwnProperty.call(item, 'data');
}

function positiveText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function response(status: number, code: string): Response { return Response.json({ code }, { status }); }
