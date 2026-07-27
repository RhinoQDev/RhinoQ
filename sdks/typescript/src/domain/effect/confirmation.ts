import type { ConfirmationPolicy, EffectState } from "../../contracts/index.js";

export function confirmEffect(
  policy: ConfirmationPolicy,
  result: unknown,
): EffectState {
  if (policy.kind === "on-return") return "confirmed";
  if (policy.kind === "predicate" && policy.test(result)) return "confirmed";
  if (policy.kind === "verify" || policy.kind === "external-signal")
    return "pending";
  return "uncertain";
}
