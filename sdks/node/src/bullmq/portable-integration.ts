import type { TaskSnapshot } from '../gateway/types.js';
import { installPostgresTaskProfile } from '../postgres/task-client.js';
import type { SqlPool } from '../postgres/task-schema.js';
import type { TaskClient } from '../tasks/client.js';
import { createRhinoQ, type RhinoQRuntimeIntegration } from '../runtime/integration.js';
import type { AdoptionReportStore } from '../runtime/adoption.js';
import type { RuntimeRef, RuntimeObservation, DispatchCommand, CancelResult, RuntimeHealth } from '../runtime/contracts.js';
import { BullMQRuntimeAdapter } from './runtime-adapter.js';
import type { BullMQEvent, BullMQQueue, BullMQQueueEvents, BullMQTaskObservation } from './task-bridge.js';

interface BullMQPortableIntegrationBaseOptions {
  pool: SqlPool;
  events: BullMQQueueEvents;
  tasks?: TaskClient;
  scope: string;
  mode: 'single' | 'fanout';
  progress?: (event: BullMQEvent) => { completed: number; total?: number; message?: string } | undefined;
  terminalFailure?: (event: BullMQEvent) => Promise<boolean> | boolean;
  resultReference?: (event: BullMQEvent) => Promise<string | undefined> | string | undefined;
  inspect?: (ref: RuntimeRef) => Promise<BullMQTaskObservation | undefined>;
  cancel?: (ref: RuntimeRef) => Promise<CancelResult>;
  health?: () => Promise<RuntimeHealth>;
  adoptionStore?: AdoptionReportStore;
  adoptionReplicaId?: string;
}

export type BullMQPortableIntegrationOptions = BullMQPortableIntegrationBaseOptions & (
  | {
      /** Observe/track only. Dispatch is deliberately unavailable. */
      queue?: never;
      jobName?: never;
      jobId?: never;
      jobOptions?: never;
    }
  | {
      /** Supplying a Queue enables dispatch, so stable job identity is mandatory. */
      queue: BullMQQueue & { getJob?: (id: string) => Promise<BullMQReadableJob | undefined> };
      jobName: string | ((command: DispatchCommand) => string);
      jobId: (command: DispatchCommand) => string;
      jobOptions?: (command: DispatchCommand) => Record<string, unknown>;
    }
);

export interface BullMQPortableDispatch {
  task: { id: string; type: string; ownerId?: string; definitionVersion?: number };
  executionId: string;
  itemKey?: string;
  payload: unknown;
  idempotencyKey: string;
}

interface BullMQReadableJob {
  getState(): Promise<string>;
  attemptsMade?: number;
  opts?: { attempts?: number };
  progress?: unknown;
  returnvalue?: unknown;
  failedReason?: string;
}

/**
 * Portable BullMQ composition. This is the migration target behind the old
 * facade: QueueEvents translation and Queue.add live in the adapter, while
 * reservation, binding and projection are owned by createRhinoQ().
 */
export interface BullMQPortableIntegration {
  readonly tasks: TaskClient;
  readonly adapter: BullMQRuntimeAdapter;
  readonly runtime: RhinoQRuntimeIntegration;
  start(): Promise<void>;
  close(): Promise<void>;
  track(binding: { task: BullMQPortableDispatch['task']; executionId: string; itemKey?: string; jobId: string }): Promise<TaskSnapshot>;
  dispatch(input: BullMQPortableDispatch): Promise<TaskSnapshot>;
  reconcile(ref: RuntimeRef): Promise<RuntimeObservation>;
  cancel(taskId: string, ref: RuntimeRef): Promise<CancelResult>;
}

export async function createBullMQPortableIntegration(
  options: BullMQPortableIntegrationOptions,
): Promise<BullMQPortableIntegration> {
  if (!options?.pool || typeof options.pool.query !== 'function') throw new TypeError('portable BullMQ integration requires a PostgreSQL pool');
  if (!options.events || typeof options.events.on !== 'function') throw new TypeError('portable BullMQ integration requires QueueEvents');
  if (!options.scope?.trim()) throw new TypeError('portable BullMQ integration requires scope');
  if (options.mode !== 'single' && options.mode !== 'fanout') throw new TypeError("portable BullMQ integration requires mode: 'single' or 'fanout'");
  if (options.queue && !options.jobName) throw new TypeError('portable BullMQ integration requires jobName when queue enables dispatch');
  if (options.queue && !options.jobId) throw new TypeError('portable BullMQ integration requires jobId when queue enables dispatch');
  const tasks = options.tasks ?? await installPostgresTaskProfile(options.pool);
  const adapter = new BullMQRuntimeAdapter({
    scope: options.scope,
    events: options.events,
    ...(options.queue ? { queue: options.queue } : {}),
    ...(options.jobName ? { jobName: options.jobName } : {}),
    ...(options.jobId ? { jobId: options.jobId } : {}),
    ...(options.jobOptions ? { jobOptions: options.jobOptions } : {}),
    ...(options.progress ? { progress: options.progress } : {}),
    ...(options.terminalFailure ? { terminalFailure: options.terminalFailure } : {}),
    ...(options.resultReference ? { resultReference: options.resultReference } : {}),
    ...(options.inspect ? { inspect: options.inspect } : options.queue?.getJob ? { inspect: async (ref) => readQueueJob(options.queue!, ref) } : {}),
    ...(options.cancel ? { cancel: options.cancel } : {}),
    ...(options.health ? { health: options.health } : {}),
  });
  const runtime = createRhinoQ({
    client: tasks,
    adapters: [adapter],
    terminalProjection: options.mode === 'single' ? 'single-execution' : 'execution-only',
    ...(options.adoptionStore ? { adoptionStore: options.adoptionStore } : {}),
    ...(options.adoptionReplicaId ? { adoptionReplicaId: options.adoptionReplicaId } : {}),
  });
  return {
    tasks, adapter, runtime,
    start: () => runtime.start(),
    close: () => runtime.close(),
    async track(binding) {
      const ref = adapter.ref(binding.jobId);
      return runtime.track({ task: { ...binding.task, definitionVersion: binding.task.definitionVersion ?? 1 }, executionId: binding.executionId, ...(binding.itemKey ? { itemKey: binding.itemKey } : {}), ref });
    },
    async dispatch(input) {
      return runtime.dispatch('bullmq', {
        taskId: input.task.id, task: { ...input.task, definitionVersion: input.task.definitionVersion ?? 1 }, executionId: input.executionId, runtime: 'bullmq', scope: options.scope,
        ...(input.itemKey ? { itemKey: input.itemKey } : {}), payload: input.payload,
        idempotencyKey: input.idempotencyKey,
      });
    },
    reconcile(ref) { return runtime.reconcile('bullmq', ref); },
    cancel(taskId, ref) { return runtime.cancel(taskId, 'bullmq', ref); },
  };
}

async function readQueueJob(queue: BullMQPortableIntegrationOptions['queue'], ref: RuntimeRef): Promise<BullMQTaskObservation | undefined> {
  const job = await queue?.getJob?.(ref.externalId);
  if (!job) return undefined;
  const rawState = await job.getState();
  if (!['waiting', 'active', 'completed', 'failed'].includes(rawState)) return undefined;
  const attemptsMade = job.attemptsMade ?? 0;
  const attemptsAllowed = job.opts?.attempts ?? 1;
  return {
    jobId: ref.externalId,
    state: rawState as BullMQTaskObservation['state'],
    attempt: Math.max(1, attemptsMade + (rawState === 'active' ? 1 : 0)),
    data: job.progress,
    returnvalue: job.returnvalue,
    failedReason: job.failedReason,
    ...(rawState === 'failed' ? { terminal: attemptsMade >= attemptsAllowed } : {}),
  };
}
