import type {
  ProviderConfirmation,
  ProviderOperationRecord,
} from '../gateway/types.js';

export interface ProviderOperationReconciliationClient {
  listProviderOperationsNeedingAttention(query?: { before?: string; limit?: number }): Promise<ProviderOperationRecord[]>;
  recheckProviderOperation(
    operation: ProviderOperationRecord,
    confirm: (operation: ProviderOperationRecord) => Promise<ProviderConfirmation>,
  ): Promise<ProviderOperationRecord>;
}

export type ProviderOperationVerifier = (
  operation: ProviderOperationRecord,
) => Promise<ProviderConfirmation>;

export interface ProviderOperationReconcilerOptions {
  client: ProviderOperationReconciliationClient;
  verifiers: Record<string, ProviderOperationVerifier>;
  /** Do not inspect operations newer than this safety window. Defaults to 30s. */
  minimumAgeMs?: number;
  batchLimit?: number;
  everyMs?: number;
  onError?: (error: unknown, operation?: ProviderOperationRecord) => void;
}

/**
 * Bounded read-back scheduler for unresolved provider effects. It can only
 * call verifiers; it never receives or repeats the mutation callback.
 */
export class ProviderOperationReconciler {
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private readonly minimumAgeMs: number;
  private readonly batchLimit: number;
  private readonly everyMs: number;

  constructor(private readonly options: ProviderOperationReconcilerOptions) {
    if (!options?.client || typeof options.client.listProviderOperationsNeedingAttention !== 'function' ||
        typeof options.client.recheckProviderOperation !== 'function') {
      throw new TypeError('provider operation reconciler requires a compatible client');
    }
    if (!options.verifiers || Object.values(options.verifiers).some((value) => typeof value !== 'function')) {
      throw new TypeError('provider operation reconciler requires verifier functions');
    }
    this.minimumAgeMs = boundedInteger(options.minimumAgeMs ?? 30_000, 0, 86_400_000, 'minimumAgeMs');
    this.batchLimit = boundedInteger(options.batchLimit ?? 100, 1, 500, 'batchLimit');
    this.everyMs = boundedInteger(options.everyMs ?? 30_000, 1_000, 86_400_000, 'everyMs');
  }

  async sweep(now = new Date()): Promise<{ selected: number; resolved: number; skipped: number; failed: number }> {
    if (this.sweeping) return { selected: 0, resolved: 0, skipped: 0, failed: 0 };
    this.sweeping = true;
    const result = { selected: 0, resolved: 0, skipped: 0, failed: 0 };
    try {
      const before = new Date(now.getTime() - this.minimumAgeMs).toISOString();
      const operations = await this.options.client.listProviderOperationsNeedingAttention({ before, limit: this.batchLimit });
      result.selected = operations.length;
      for (const operation of operations) {
        const verifier = this.options.verifiers[`${operation.provider}.${operation.operation}`];
        if (!verifier) { result.skipped++; continue; }
        try {
          const updated = await this.options.client.recheckProviderOperation(operation, verifier);
          if (updated.state !== operation.state || updated.version !== operation.version) result.resolved++;
        } catch (error) {
          result.failed++;
          try { this.options.onError?.(error, operation); } catch { /* telemetry must not stop reconciliation */ }
        }
      }
      return result;
    } catch (error) {
      result.failed++;
      try { this.options.onError?.(error); } catch { /* telemetry must not stop later sweeps */ }
      return result;
    } finally {
      this.sweeping = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep(); }, this.everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be ${min}..${max}`);
  return value;
}
