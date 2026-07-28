import type { RetryClass } from '../gateway/types.js';

export class ClassifiedError extends Error {
  readonly retryClass: RetryClass;
  readonly retryAfterMs?: number;

  constructor(
    retryClass: RetryClass,
    error: unknown,
    retryAfterMs?: number,
  ) {
    super(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
    this.name = 'ClassifiedError';
    this.retryClass = retryClass;
    this.retryAfterMs = retryAfterMs;
  }
}

export class PayloadDecodeError extends Error {
  constructor(jobName: string, cause: unknown) {
    super(`payload for ${jobName} is not valid JSON`, { cause });
    this.name = 'PayloadDecodeError';
  }
}

export function classify(
  error: unknown,
  retryClass: RetryClass,
  retryAfterMs?: number,
): ClassifiedError {
  if (retryClass === 'rate_limited' && (!Number.isFinite(retryAfterMs) || (retryAfterMs ?? 0) <= 0)) {
    throw new RangeError('rate_limited errors require a positive retryAfterMs');
  }
  return new ClassifiedError(retryClass, error, retryAfterMs);
}

export function transient(error: unknown): ClassifiedError {
  return classify(error, 'transient');
}

export function permanent(error: unknown): ClassifiedError {
  return classify(error, 'permanent');
}

export function dependencyDown(error: unknown): ClassifiedError {
  return classify(error, 'dependency_down');
}

export function rateLimited(error: unknown, retryAfterMs: number): ClassifiedError {
  return classify(error, 'rate_limited', retryAfterMs);
}

export function cancelled(error: unknown): ClassifiedError {
  return classify(error, 'cancelled');
}
