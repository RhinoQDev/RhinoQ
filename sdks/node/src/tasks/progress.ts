export interface RhinoQProgressUpdate {
  completed: number;
  total?: number;
  message?: string;
}

export interface RhinoQProgressCoalescerOptions {
  /** Default flush cadence for progress that does not cross the delta bound. */
  flushIntervalMs?: number;
  /** Default completed-unit delta that triggers an immediate flush. */
  minCompletedDelta?: number;
  /** Clock injection is useful for deterministic tests and diagnostics. */
  now?: () => number;
}

export interface RhinoQProgressCoalescer {
  /** Keep only the newest update and flush it when a bound is reached. */
  report(update: RhinoQProgressUpdate): Promise<void>;
  /** Flush the newest pending update, even when it has not crossed a threshold. */
  flush(): Promise<void>;
  /** Stop timers and flush the last update before the worker returns. */
  close(): Promise<void>;
}

type ProgressWriter = (update: RhinoQProgressUpdate) => Promise<unknown> | unknown;

/**
 * Bounds progress writes without becoming a second Task state machine.
 *
 * The coalescer owns only an in-process delivery buffer. The durable Task
 * snapshot and its monotonic version remain authoritative in the Application
 * and Go engine. A failed write is surfaced to the caller; it is never hidden
 * or converted into a successful Task result.
 */
export function createRhinoQProgressCoalescer(
  writer: ProgressWriter,
  options: RhinoQProgressCoalescerOptions = {},
): RhinoQProgressCoalescer {
  if (typeof writer !== 'function') throw new TypeError('progress writer is required');
  const intervalMs = boundedInteger(options.flushIntervalMs ?? 100, 10, 60_000, 'progress flushIntervalMs');
  const minDelta = boundedNumber(options.minCompletedDelta ?? 1, 0, Number.MAX_SAFE_INTEGER, 'progress minCompletedDelta');
  const now = options.now ?? (() => Date.now());

  let pending: RhinoQProgressUpdate | undefined;
  let lastSent: RhinoQProgressUpdate | undefined;
  let lastSentAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let writeFailure: unknown;
  let closed = false;

  const schedule = (): void => {
    if (closed || timer || !pending) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush().catch(() => undefined);
    }, intervalMs);
    timer.unref?.();
  };

  const flush = async (): Promise<void> => {
    if (writeFailure) throw writeFailure;
    if (inFlight) return inFlight;
    const update = pending;
    if (!update) return;
    pending = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
    inFlight = (async () => {
      await writer(update);
      lastSent = update;
      lastSentAt = now();
    })().catch((error) => {
      writeFailure = error;
      throw error;
    }).finally(() => {
      inFlight = undefined;
      if (!writeFailure && pending) {
        if (isTerminal(pending) || shouldFlush(pending)) void flush();
        else schedule();
      }
    });
    return inFlight;
  };

  const report = async (update: RhinoQProgressUpdate): Promise<void> => {
    if (closed) throw new Error('RHINOQ_PROGRESS_CLOSED');
    validateUpdate(update);
    if (writeFailure) throw writeFailure;
    const newestKnown = pending ?? lastSent;
    if (newestKnown && update.completed < newestKnown.completed) return;
    pending = { ...update };
    if (!lastSent || isTerminal(update) || shouldFlush(update)) {
      await flush();
      return;
    }
    schedule();
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    while (pending || inFlight) {
      await flush();
      if (inFlight) await inFlight;
    }
    if (writeFailure) throw writeFailure;
  };

  function shouldFlush(update: RhinoQProgressUpdate): boolean {
    if (!lastSent) return true;
    if (update.completed - lastSent.completed >= minDelta) return true;
    return now() - lastSentAt >= intervalMs;
  }

  return Object.freeze({ report, flush, close });
}

function isTerminal(update: RhinoQProgressUpdate): boolean {
  return update.total !== undefined && update.completed >= update.total;
}

function validateUpdate(update: RhinoQProgressUpdate): void {
  if (!update || !Number.isFinite(update.completed) || update.completed < 0) {
    throw new RangeError('Task progress completed must be non-negative');
  }
  if (update.total !== undefined && (!Number.isFinite(update.total) || update.total < update.completed)) {
    throw new RangeError('Task progress total must be at least completed');
  }
  if (update.message !== undefined && typeof update.message !== 'string') {
    throw new TypeError('Task progress message must be a string');
  }
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer ${min}..${max}`);
  return value;
}

function boundedNumber(value: number, min: number, max: number, name: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} must be ${min}..${max}`);
  return value;
}
