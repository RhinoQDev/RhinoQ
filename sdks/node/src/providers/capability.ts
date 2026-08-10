import type { ProviderConfirmationPolicy, ProviderRetryPolicy } from '../gateway/types.js';

export interface EffectCapabilityInput {
  stableIdentity: boolean;
  confirmation: ProviderConfirmationPolicy;
  retryPolicy: ProviderRetryPolicy;
  verifierRegistered: boolean;
  providerSupportsIdempotency: boolean;
}

export interface EffectCapabilityReport extends EffectCapabilityInput {
  level: 'at-least-once' | 'idempotent-delivery' | 'effectively-exactly-once';
  blockers: string[];
}

/** Honest, machine-readable claim for one declared external effect. */
export function effectCapabilityReport(input: EffectCapabilityInput): EffectCapabilityReport {
  const blockers: string[] = [];
  if (!input.stableIdentity) blockers.push('stable command/effect identity is missing');
  if (!input.providerSupportsIdempotency) blockers.push('provider does not enforce the RhinoQ idempotency key');
  if (input.confirmation !== 'on-return' && !input.verifierRegistered) blockers.push('independent confirmation verifier is missing');
  if (input.retryPolicy !== 'when-not-happened') blockers.push('retry is not gated by proof that the prior mutation did not happen');
  let level: EffectCapabilityReport['level'] = 'at-least-once';
  if (input.stableIdentity && input.providerSupportsIdempotency) level = 'idempotent-delivery';
  if (blockers.length === 0) level = 'effectively-exactly-once';
  return { ...input, level, blockers };
}
