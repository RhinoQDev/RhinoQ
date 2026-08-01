import type {
  ProviderConfirmation,
  ProviderOperationOptions,
  ProviderOperationRecord,
} from '../gateway/types.js';

export interface StripeOperationResult {
  id: string;
  status?: string | null;
}

export interface StripeReferenceAdapter<T extends StripeOperationResult> {
  execute(idempotencyKey: string): Promise<T>;
  /** May retrieve by provider id or reconcile by application metadata/key. */
  retrieve(operation: ProviderOperationRecord): Promise<T | undefined>;
  confirmedStatuses?: readonly string[];
  failedStatuses?: readonly string[];
}

/**
 * Reference adapter only: the application keeps ownership of Stripe's SDK,
 * API version, parameters and secrets. RhinoQ owns unknown-result semantics.
 */
export function stripeProviderAdapter<T extends StripeOperationResult>(
  adapter: StripeReferenceAdapter<T>,
): Pick<ProviderOperationOptions<T>, 'execute' | 'confirm' | 'providerId' | 'evidence'> {
  const confirmed = new Set(adapter.confirmedStatuses ?? ['succeeded', 'paid', 'complete']);
  const failed = new Set(adapter.failedStatuses ?? ['failed', 'canceled', 'cancelled']);
  return {
    execute: (key) => adapter.execute(key),
    providerId: (result) => result.id,
    evidence: (result) => `${result.id}:${result.status ?? 'accepted'}`,
    confirm: async (operation): Promise<ProviderConfirmation> => {
      const result = await adapter.retrieve(operation);
      if (!result) return { decision: 'unknown', reason: 'Stripe lookup returned no matching object' };
      const status = result.status ?? '';
      const evidence = `${result.id}:${status || 'present'}`;
      if (confirmed.has(status)) return { decision: 'confirmed', evidence };
      if (failed.has(status)) return { decision: 'failed', reason: evidence };
      return { decision: 'pending', evidence };
    },
  };
}
