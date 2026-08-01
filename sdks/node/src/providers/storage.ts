import type {
  ProviderConfirmation,
  ProviderOperationOptions,
  ProviderOperationRecord,
} from '../gateway/types.js';

export interface ProvisioningResult {
  id: string;
  state: string;
  version?: string | number;
}

export interface ProvisioningReferenceAdapter<T extends ProvisioningResult> {
  provision(idempotencyKey: string): Promise<T>;
  inspect(operation: ProviderOperationRecord): Promise<T | undefined>;
  readyStates?: readonly string[];
  failedStates?: readonly string[];
}

/** Reference adapter for storage buckets, accounts and other provisioning APIs. */
export function provisioningProviderAdapter<T extends ProvisioningResult>(
  adapter: ProvisioningReferenceAdapter<T>,
): Pick<ProviderOperationOptions<T>, 'execute' | 'confirm' | 'providerId' | 'evidence'> {
  const ready = new Set(adapter.readyStates ?? ['ready', 'active', 'available']);
  const failed = new Set(adapter.failedStates ?? ['failed', 'error', 'deleted']);
  const describe = (result: T) => `${result.id}:${result.state}${result.version === undefined ? '' : `@${result.version}`}`;
  return {
    execute: (key) => adapter.provision(key),
    providerId: (result) => result.id,
    evidence: describe,
    confirm: async (operation): Promise<ProviderConfirmation> => {
      const result = await adapter.inspect(operation);
      if (!result) return { decision: 'not_happened', reason: 'provider lookup proved the resource does not exist' };
      const evidence = describe(result);
      if (ready.has(result.state)) return { decision: 'confirmed', evidence };
      if (failed.has(result.state)) return { decision: 'failed', reason: evidence };
      return { decision: 'pending', evidence };
    },
  };
}
