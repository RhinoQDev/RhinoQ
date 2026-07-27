import type { EnqueueInput, JobId, JobRecord } from '../contracts/index.js';

export interface JobStore {
  enqueue<TPayload>(input: EnqueueInput<TPayload>): Promise<JobId>;
  get(jobId: JobId): Promise<JobRecord | null>;
}

export interface Transaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface TransactionManager {
  begin(): Promise<Transaction>;
}

export interface Clock {
  now(): Promise<Date>;
}
