import type { TaskExecution } from '../gateway/types.js';

export interface CancellableBullMQJob {
  getState(): Promise<string>;
  remove(): Promise<void>;
}

export interface BullMQCancellationOptions {
  queue: { getJob(id: string): Promise<CancellableBullMQJob | undefined> };
  /** Must durably signal a running worker checkpoint before acknowledging. */
  cooperativeSignal?(jobId: string, execution: TaskExecution): Promise<boolean>;
}

/** Safe cancelJob callback for BullMQTaskBridge. */
export function bullMQCancellation(options: BullMQCancellationOptions) {
  if (!options?.queue || typeof options.queue.getJob !== 'function') throw new TypeError('bullMQCancellation requires Queue.getJob');
  return async (jobId: string, execution: TaskExecution) => {
    const job = await options.queue.getJob(jobId);
    if (!job) return { status: 'failed' as const, reason: `BullMQ job ${jobId} was not found` };
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'paused' || state === 'waiting-children') {
      try { await job.remove(); return { status: 'acknowledged' as const }; }
      catch { return { status: 'failed' as const, reason: `BullMQ job ${jobId} could not be removed` }; }
    }
    if (state === 'active') {
      if (!options.cooperativeSignal) {
        return { status: 'cannot_cancel_safely' as const, reason: 'Active BullMQ work has no durable cooperative cancellation signal' };
      }
      return await options.cooperativeSignal(jobId, execution)
        ? { status: 'acknowledged' as const }
        : { status: 'cannot_cancel_safely' as const, reason: 'The worker did not durably acknowledge cancellation' };
    }
    return { status: 'failed' as const, reason: `BullMQ job ${jobId} is already ${state}` };
  };
}
