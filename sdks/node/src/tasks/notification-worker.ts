import type { TaskNotificationRecord } from '../gateway/types.js';
import { sendNotification, type NotificationMessage, type SendNotificationOptions } from '../notify/sender.js';
import type { NotifySeverity, ResolvedNotifyDestination } from '../notify/registry.js';

export interface TaskNotificationQueue {
  claimTaskNotification(owner: string, leaseMs?: number): Promise<TaskNotificationRecord | undefined>;
  completeTaskNotification(id: string, owner: string): Promise<TaskNotificationRecord>;
  failTaskNotification(id: string, owner: string, error: string, retryAfterMs?: number): Promise<TaskNotificationRecord>;
}

export interface TaskNotificationDelivery {
  deliver(record: TaskNotificationRecord): Promise<void>;
}

export interface TaskNotificationWorkerOptions {
  queue: TaskNotificationQueue;
  delivery: TaskNotificationDelivery;
  owner: string;
  leaseMs?: number;
  retryAfterMs?: number;
  idleMs?: number;
}

export type TaskNotificationRun =
  | { status: 'idle' }
  | { status: 'sent' | 'failed'; notification: TaskNotificationRecord; error?: string };

/**
 * Drains the durable Task notification outbox without owning its correctness.
 * Claim, lease, retry scheduling and dedup remain PostgreSQL-store operations.
 */
export class TaskNotificationWorker {
  private readonly leaseMs: number;
  private readonly retryAfterMs: number;
  private readonly idleMs: number;
  constructor(private readonly options: TaskNotificationWorkerOptions) {
    if (!options?.queue || !options.delivery) throw new TypeError('Task notification worker requires queue and delivery');
    if (!options.owner?.trim()) throw new TypeError('Task notification worker owner is required');
    this.leaseMs = bounded(options.leaseMs ?? 60_000, 1_000, 3_600_000, 'leaseMs');
    this.retryAfterMs = bounded(options.retryAfterMs ?? 30_000, 1_000, 86_400_000, 'retryAfterMs');
    this.idleMs = bounded(options.idleMs ?? 1_000, 25, 60_000, 'idleMs');
  }
  async runOnce(): Promise<TaskNotificationRun> {
    const notification = await this.options.queue.claimTaskNotification(this.options.owner, this.leaseMs);
    if (!notification) return { status: 'idle' };
    try {
      await this.options.delivery.deliver(notification);
      return { status: 'sent', notification: await this.options.queue.completeTaskNotification(notification.id, this.options.owner) };
    } catch (error) {
      const message = error instanceof Error && error.message.trim() ? error.message.slice(0, 1_000) : 'notification delivery failed';
      return { status: 'failed', error: message, notification: await this.options.queue.failTaskNotification(notification.id, this.options.owner, message, this.retryAfterMs) };
    }
  }
  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const result = await this.runOnce();
      if (result.status === 'idle') await abortableDelay(this.idleMs, signal);
    }
  }
}

export interface TaskWebhookDeliveryOptions extends SendNotificationOptions {
  destination: ResolvedNotifyDestination;
  /** Severity is an application policy and therefore mandatory. */
  severity(record: TaskNotificationRecord): NotifySeverity;
}

export function createTaskWebhookDelivery(options: TaskWebhookDeliveryOptions): TaskNotificationDelivery {
  if (!options?.destination || typeof options.severity !== 'function') throw new TypeError('Task webhook delivery requires destination and severity policy');
  return { async deliver(record) {
    const message: NotificationMessage = {
      id: record.id,
      type: 'rhinoq.task.verification',
      ruleId: record.finding.ruleId,
      subjectType: record.finding.subjectType,
      subjectId: record.finding.subjectId,
      invariantVersion: record.finding.invariantVersion,
      status: record.finding.status,
      severity: options.severity(record),
      escalation: false,
      ...(record.deepLink ? { link: record.deepLink } : {}),
      occurrenceCount: record.finding.occurrenceCount,
      ...(record.finding.latestEvidence ? { evidence: record.finding.latestEvidence } : {}),
      observedAt: record.finding.updatedAt,
    };
    await sendNotification(options.destination, message, options);
  } };
}

export interface TaskEmailMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  idempotencyKey: string;
}
export interface TaskEmailDeliveryOptions {
  recipients(record: TaskNotificationRecord): Promise<string[]> | string[];
  render(record: TaskNotificationRecord): Promise<Omit<TaskEmailMessage, 'to' | 'idempotencyKey'>> | Omit<TaskEmailMessage, 'to' | 'idempotencyKey'>;
  send(message: TaskEmailMessage): Promise<void>;
}

/** Provider-neutral email adapter; credentials and recipient policy stay in the host application. */
export function createTaskEmailDelivery(options: TaskEmailDeliveryOptions): TaskNotificationDelivery {
  if (!options || typeof options.recipients !== 'function' || typeof options.render !== 'function' || typeof options.send !== 'function') throw new TypeError('Task email delivery requires recipients, render and send');
  return { async deliver(record) {
    const to = (await options.recipients(record)).map((value) => value.trim()).filter(Boolean);
    if (!to.length) throw new Error('Task email delivery resolved no recipients');
    const rendered = await options.render(record);
    if (!rendered.subject?.trim() || !rendered.text?.trim()) throw new Error('Task email delivery requires subject and text');
    await options.send({ ...rendered, to, idempotencyKey: record.id });
  } };
}

function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be ${min}..${max}`);
  return value;
}
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal?.addEventListener('abort', finish, { once: true });
  });
}
