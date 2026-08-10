import { createHash } from 'node:crypto';
import type { TaskSnapshot } from '../gateway/types.js';
import type { BullMQTaskBridge } from '../bullmq/task-bridge.js';

export interface TaskDefinitionOptions {
  type: string;
  jobName: string;
  mode: 'single' | 'fanout';
  definitionVersion?: number;
  jobOptions?: Record<string, unknown>;
  /** Admission bound before any Task/Execution row is reserved. Defaults to 1,000. */
  maxBatchSize?: number;
}

export interface DefinedTaskInput {
  id: string;
  ownerId?: string;
  data: unknown;
  jobId?: string;
}

export interface DefinedTaskItem extends DefinedTaskInput { itemKey: string; }

export class BullMQTaskDefinition {
  constructor(private readonly bridge: BullMQTaskBridge, private readonly options: TaskDefinitionOptions) {
    if (!options?.type?.trim() || !options.jobName?.trim()) throw new TypeError('Task definition type and jobName are required');
    if (options.mode !== 'single' && options.mode !== 'fanout') throw new TypeError("Task definition mode must be 'single' or 'fanout'");
  }

  dispatch(input: DefinedTaskInput): Promise<TaskSnapshot> {
    if (this.options.mode !== 'single') throw new TypeError('fanout definitions use dispatchMany');
    return this.bridge.dispatch(this.binding(input, 'default'));
  }

  dispatchMany(taskId: string, ownerId: string | undefined, items: DefinedTaskItem[]): Promise<TaskSnapshot> {
    if (this.options.mode !== 'fanout') throw new TypeError('single definitions use dispatch');
    if (!items.length) throw new RangeError('dispatchMany requires at least one item');
    const maximum = this.options.maxBatchSize ?? 1_000;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 10_000) throw new RangeError('maxBatchSize must be 1..10000');
    if (items.length > maximum) throw new RangeError(`batch contains ${items.length} items; maxBatchSize is ${maximum}`);
    return this.bridge.dispatchMany(items.map((item) => this.binding({ ...item, id: taskId, ownerId }, item.itemKey)));
  }

  dispatchBatch(input: { id: string; ownerId?: string; items: Array<{ itemKey: string; data: unknown; jobId?: string }> }): Promise<TaskSnapshot> {
    return this.dispatchMany(input.id, input.ownerId, input.items.map(item => ({ id: input.id, ownerId: input.ownerId, ...item })));
  }

  private binding(input: DefinedTaskInput, itemKey: string) {
    if (!input.id?.trim()) throw new TypeError('Task id is required');
    const key = stable(`${input.id}\0${itemKey}`);
    return {
      task: { id: input.id, type: this.options.type, ...(input.ownerId ? { ownerId: input.ownerId } : {}), definitionVersion: this.options.definitionVersion ?? 1 },
      executionId: `${input.id}#${itemKey}#1`,
      itemKey,
      jobId: input.jobId ?? `rq-${key}`,
      job: { name: this.options.jobName, data: input.data, ...(this.options.jobOptions ? { options: this.options.jobOptions } : {}) },
    };
  }
}

function stable(value: string): string { return createHash('sha256').update(value).digest('base64url').slice(0, 24); }
