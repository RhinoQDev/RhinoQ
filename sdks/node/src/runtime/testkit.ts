import type { RuntimeAdapter, RuntimeHealth, RuntimeObservation, RuntimeRef } from './contracts.js';
import {
  validateRuntimeAdapter, validateRuntimeObservation, validateRuntimeRef,
} from './contracts.js';

export interface RuntimeAdapterContractResult {
  adapter: string;
  checks: string[];
  observation?: RuntimeObservation;
  health?: RuntimeHealth;
}

/**
 * Read-only conformance checks for adapter authors. Mutation capabilities are
 * shape-checked but never invoked against an unknown environment.
 */
export async function checkRuntimeAdapterContract(
  adapter: RuntimeAdapter,
  ref?: RuntimeRef,
): Promise<RuntimeAdapterContractResult> {
  validateRuntimeAdapter(adapter);
  const checks = ['capability shape'];
  let observation: RuntimeObservation | undefined;
  let health: RuntimeHealth | undefined;

  if (adapter.capabilities.inspect) {
    if (!ref) throw new TypeError('adapter contract check requires a RuntimeRef for inspect capability');
    validateRuntimeRef(ref);
    if (ref.runtime !== adapter.name || ref.scope !== adapter.scope) {
      throw new TypeError('adapter contract RuntimeRef does not match adapter name and scope');
    }
    observation = validateRuntimeObservation(await adapter.inspect!(ref));
    if (identity(observation.ref) !== identity(ref)) {
      throw new TypeError('adapter inspect returned a different RuntimeRef');
    }
    checks.push('inspect identity', 'observation shape');
  }

  if (adapter.health) {
    health = await adapter.health();
    if (!['healthy', 'degraded', 'unavailable', 'unknown'].includes(health.status)) {
      throw new TypeError('adapter health status is invalid');
    }
    if (!Number.isFinite(Date.parse(health.checkedAt))) {
      throw new TypeError('adapter health checkedAt must be an ISO-8601 timestamp');
    }
    checks.push('health shape');
  }

  return { adapter: adapter.name, checks, ...(observation ? { observation } : {}), ...(health ? { health } : {}) };
}

function identity(ref: RuntimeRef): string {
  return JSON.stringify([ref.runtime, ref.scope, ref.externalId]);
}
