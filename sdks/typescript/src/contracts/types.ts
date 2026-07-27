export type JobId = string & { readonly __brand: 'JobId' };
export type JobName = string & { readonly __brand: 'JobName' };

export type JobState =
  | 'pending'
  | 'leased'
  | 'succeeded'
  | 'retry_wait'
  | 'dead'
  | 'cancelled'
  | 'blocked';

export type EffectState =
  | 'pending'
  | 'confirmed'
  | 'uncertain'
  | 'rejected'
  | 'not_happened';

export type OutcomeState =
  | 'pending'
  | 'achieved'
  | 'mismatch'
  | 'unverifiable'
  | 'stale';

export type ConfirmationPolicy =
  | { kind: 'on-return' }
  | { kind: 'external-signal' }
  | { kind: 'verify' }
  | { kind: 'predicate'; test: (result: unknown) => boolean };

export interface JobRecord<TPayload = unknown> {
  id: JobId;
  name: JobName;
  payload: TPayload;
  state: JobState;
  attempts: number;
  createdAt: Date;
  notBefore: Date;
}

export interface EnqueueInput<TPayload = unknown> {
  name: JobName;
  payload: TPayload;
  idempotencyKey?: string;
  notBefore?: Date;
  correlationId?: string;
}

export interface EffectRecord {
  jobId: JobId;
  name: string;
  state: EffectState;
  idempotencyKey: string;
  irreversible: boolean;
  externalRef?: string;
}
