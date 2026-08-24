export type RhinoQCapabilityStatus = 'implemented' | 'bounded' | 'integrated' | 'provider-required' | 'roadmap' | 'not-built';
export type RhinoQCapabilityEvidence = 'technical' | 'integration' | 'external' | 'business' | 'none';

export interface RhinoQCapabilityRegistryEntry {
  readonly id: string;
  readonly title: string;
  readonly status: RhinoQCapabilityStatus;
  readonly evidence: RhinoQCapabilityEvidence;
  readonly owner: 'Go engine' | 'Go runtime' | 'Node SDK' | 'Application' | 'Provider' | 'Product';
  readonly claim: string;
  readonly limit: string;
}

/**
 * Small product registry used by CLI/docs. Status is deliberately evidence
 * aware: implementation is not the same thing as an external or business
 * readiness claim.
 */
export const RHINOQ_CAPABILITY_REGISTRY: readonly RhinoQCapabilityRegistryEntry[] = Object.freeze([
  { id: 'task-lifecycle', title: 'Durable Task lifecycle', status: 'implemented', evidence: 'integration', owner: 'Go engine', claim: 'Task, Execution, lease, retry and version fencing share one authoritative contract.', limit: 'Deployment-shaped chaos and adopter evidence remain release gates.' },
  { id: 'golden-path', title: 'Typed application golden path', status: 'implemented', evidence: 'technical', owner: 'Node SDK', claim: 'One execution profile compiles typed handlers, a manifest and one mountable surface.', limit: 'Adopter before/after artifacts are still required for net integration LOC claims.' },
  { id: 'canonical-plan', title: 'Canonical read-only plan', status: 'implemented', evidence: 'technical', owner: 'Node SDK', claim: 'A deterministic plan exposes tasks, requirements, limitations and Needs decision without mutation.', limit: 'It describes configuration; it does not prove runtime capacity or provider health.' },
  { id: 'typed-capability-linking', title: 'Typed capability linking', status: 'implemented', evidence: 'technical', owner: 'Node SDK', claim: 'Pure compile phases link each required capability to exactly one component and keep secret values outside the fingerprinted plan.', limit: 'A link is configuration evidence, not provider readiness or authorization.' },
  { id: 'stage-deployment', title: 'Stage deployment identity', status: 'implemented', evidence: 'technical', owner: 'Node SDK', claim: 'Dev, PR, staging and production plans receive deterministic namespaces without changing Task identity.', limit: 'Stage is not tenant authorization and does not provision infrastructure.' },
  { id: 'sst-deployment', title: 'SST deployment adapter', status: 'integrated', evidence: 'technical', owner: 'Node SDK', claim: 'Canonical plans compile to explicit SST worker/migration intent and adopter-owned resource materializers.', limit: 'VPC, database, image, IAM, credentials and production evidence remain adopter-owned.' },
  { id: 'realtime', title: 'Bounded realtime UI path', status: 'implemented', evidence: 'technical', owner: 'Node SDK', claim: 'SSE with polling fallback and stale-version rejection keeps one authoritative read path.', limit: 'Fan-out campaign evidence is required at each adopter topology.' },
  { id: 'selective-checkpoints', title: 'Selective execution checkpoints', status: 'bounded', evidence: 'technical', owner: 'Go runtime', claim: 'Opt-in checkpoints are checksum/version fenced and replay-safe for deterministic work.', limit: 'They are not a workflow engine or an external-effect ledger.' },
  { id: 'autopilot-canary', title: 'Autopilot canary', status: 'bounded', evidence: 'technical', owner: 'Application', claim: 'An explicitly approved application-owned canary has a bounded observation gate and rollback.', limit: 'No autonomous production tuning and no Control Plane are claimed.' },
  { id: 'processor-packs', title: 'Provider processor packs', status: 'bounded', evidence: 'technical', owner: 'Provider', claim: 'Processor lifecycle, readiness, workspace and cleanup are standardized without bundling native providers.', limit: 'Provider-specific correctness and cost evidence remain application-owned.' },
  { id: 'external-effects', title: 'External-effect confirmation', status: 'implemented', evidence: 'integration', owner: 'Go engine', claim: 'Unknown provider results fail closed or become uncertain and can be reconciled by readback.', limit: 'Business truth still requires an application-owned verifier.' },
  { id: 'tenant-rbac', title: 'Tenant/RBAC matrix', status: 'integrated', evidence: 'technical', owner: 'Application', claim: 'Owner and tenant hooks fence supported reads and writes at the application surface.', limit: 'Full tenant-wide RBAC and deployment review remain controlled-pilot gates.' },
  { id: 'control-plane', title: 'Multi-cluster Control Plane', status: 'not-built', evidence: 'none', owner: 'Product', claim: 'Not started automatically.', limit: 'Requires adopter evidence and maintainer approval after the release gates.' },
]);

export function listRhinoQCapabilities(): readonly RhinoQCapabilityRegistryEntry[] {
  return RHINOQ_CAPABILITY_REGISTRY;
}
