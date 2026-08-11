import type { RuntimeHealthReader, RuntimeScopeHealth } from '../observe/runtime-health.js';

export interface BullMQInspectableQueue {
  name?: string;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  isPaused?(): Promise<boolean>;
  getWorkers?(): Promise<unknown[]>;
  opts?: { defaultJobOptions?: Record<string, unknown> };
}

export interface BullMQRuntimeInspectorOptions {
  queue: BullMQInspectableQueue;
  scope?: string;
  dashboardURL?: string;
  timeoutMs?: number;
}

/** Bounded, read-only BullMQ inspection. It never returns Redis errors or credentials. */
export class BullMQRuntimeInspector implements RuntimeHealthReader {
  private readonly scope: string;

  constructor(private readonly options: BullMQRuntimeInspectorOptions) {
    this.scope = (options.scope ?? options.queue.name ?? '').trim();
    if (!this.scope) throw new TypeError('BullMQRuntimeInspector requires a scope or queue name');
  }

  async inspect(): Promise<RuntimeScopeHealth> {
    const observedAt = new Date().toISOString();
    try {
      return await withTimeout(this.read(observedAt), this.options.timeoutMs ?? 2_000);
    } catch {
      return {
        schemaVersion: 1, runtime: 'bullmq', scope: this.scope, status: 'unavailable', observedAt,
        queue: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, paused: false },
        workers: { observable: false }, reason: 'runtime_unreachable',
      };
    }
  }

  private async read(observedAt: string): Promise<RuntimeScopeHealth> {
    const [counts, paused] = await Promise.all([
      this.options.queue.getJobCounts('wait', 'waiting', 'active', 'delayed', 'failed', 'completed'),
      this.options.queue.isPaused?.() ?? Promise.resolve(false),
    ]);
    let workers: RuntimeScopeHealth['workers'] = { observable: false };
    if (this.options.queue.getWorkers) {
      try { workers = { observable: true, connected: (await this.options.queue.getWorkers()).length }; } catch { /* visibility is optional */ }
    }
    const waiting = number(counts.waiting) + number(counts.wait);
    const noWorkers = !paused && waiting > 0 && workers.observable && workers.connected === 0;
    const unknownWorkers = waiting > 0 && !workers.observable;
    const defaults = this.options.queue.opts?.defaultJobOptions ?? {};
    const attempts = finite(defaults.attempts);
    const backoff = typeof defaults.backoff === 'string'
      ? defaults.backoff
      : objectType(defaults.backoff);
    return {
      schemaVersion: 1, runtime: 'bullmq', scope: this.scope,
      status: noWorkers ? 'degraded' : unknownWorkers ? 'unknown' : 'healthy', observedAt,
      queue: {
        waiting, active: number(counts.active), delayed: number(counts.delayed),
        failed: number(counts.failed), completed: number(counts.completed), paused,
      },
      workers,
      ...(attempts !== undefined || backoff || typeof defaults.removeOnComplete === 'boolean' || typeof defaults.removeOnFail === 'boolean'
        ? { policy: { ...(attempts !== undefined ? { attempts } : {}), ...(backoff ? { backoff } : {}),
          ...(typeof defaults.removeOnComplete === 'boolean' ? { removeOnComplete: defaults.removeOnComplete } : {}),
          ...(typeof defaults.removeOnFail === 'boolean' ? { removeOnFail: defaults.removeOnFail } : {}) } } : {}),
      ...(noWorkers ? { reason: 'waiting_without_workers' as const } : unknownWorkers ? { reason: 'worker_visibility_unavailable' as const } : {}),
      ...(this.options.dashboardURL ? { dashboardURL: this.options.dashboardURL } : {}),
    };
  }
}

function number(value: unknown): number { return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : 0; }
function finite(value: unknown): number | undefined { return Number.isFinite(value) ? Number(value) : undefined; }
function objectType(value: unknown): string | undefined {
  return value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
    ? (value as { type: string }).type : undefined;
}
async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), Math.max(50, timeoutMs)); timer.unref?.(); })]);
  } finally { if (timer) clearTimeout(timer); }
}
