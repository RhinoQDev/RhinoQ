import type { RuntimeAdapter, RuntimeHealth, RuntimeObservation, RuntimeRef } from './contracts.js';
import {
  validateRuntimeAdapter, validateRuntimeEvent, validateRuntimeObservation, validateRuntimeRef,
} from './contracts.js';
import type { RuntimeEvent } from './contracts.js';

export interface RuntimeAdapterContractResult {
  adapter: string;
  checks: string[];
  observation?: RuntimeObservation;
  health?: RuntimeHealth;
}

export interface RuntimeParityResult { adapters: string[]; fixture: string; checks: string[] }

/**
 * Public parity fixture for adapter authors. Each adapter maps the same neutral
 * facts; provider-only differences belong in capabilities, never Task meaning.
 */
export function checkRuntimeEventParity(
  adapters: Array<{ name: string; map(fixture: readonly RuntimeEvent[]): readonly RuntimeEvent[] }>,
  fixture: readonly RuntimeEvent[],
): RuntimeParityResult {
  if (adapters.length < 2) throw new TypeError('runtime parity requires at least two adapters');
  const expected = canonical(fixture.map(validateRuntimeEvent));
  for (const adapter of adapters) {
    if (!adapter.name?.trim() || typeof adapter.map !== 'function') throw new TypeError('runtime parity adapter requires name and map');
    const actual = canonical([...adapter.map(fixture)].map(validateRuntimeEvent));
    if (actual !== expected) throw new TypeError(`runtime parity mismatch for ${adapter.name}: lifecycle semantics differ from the shared fixture`);
  }
  return { adapters: adapters.map((adapter) => adapter.name), fixture: expected, checks: ['state', 'attempt', 'progress', 'result', 'uncertainty'] };
}

function canonical(events: readonly RuntimeEvent[]): string {
  return JSON.stringify(events.map((event) => ({
    type: event.type, attempt: event.attempt,
    ...('progress' in event ? { progress: event.progress } : {}),
    ...('resultReference' in event ? { resultReference: event.resultReference } : {}),
    ...('reason' in event ? { reason: event.reason } : {}),
    ...('terminal' in event ? { terminal: event.terminal } : {}),
  })));
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
