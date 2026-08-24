import type { RhinoQCompilerDiagnostic, RhinoQPlan } from './plan-inspector.js';

export type RhinoQCompilerWorkflowAction = 'validate' | 'diff' | 'doctor' | 'dev';

export interface RhinoQCompilerWorkflowResult {
  readonly kind: 'rhinoq-compiler-workflow';
  readonly schemaVersion: 1;
  readonly action: RhinoQCompilerWorkflowAction;
  readonly status: 'ready' | 'needs-decision' | 'changed' | 'unchanged';
  readonly planFingerprint: string;
  readonly diagnostics: readonly RhinoQCompilerDiagnostic[];
  readonly diff?: { readonly schemaVersion: 1; readonly previous: string; readonly current: string; readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[]; readonly deploymentChanged: boolean; readonly capabilityGraphChanged: boolean };
  readonly dev?: { readonly namespace: string; readonly environment: Readonly<Record<string, string>>; readonly handlers: readonly string[] };
}

/** One pure workflow shared by plan, doctor, diff and dev entry points. */
export function runRhinoQCompilerWorkflow(input: {
  action: RhinoQCompilerWorkflowAction;
  plan: RhinoQPlan;
  previous?: RhinoQPlan;
}): RhinoQCompilerWorkflowResult {
  const { action, plan } = input;
  if (!plan || plan.kind !== 'rhinoq-plan' || plan.schemaVersion !== 1) throw new TypeError('RhinoQ compiler workflow requires a canonical plan');
  const diagnostics: RhinoQCompilerDiagnostic[] = [];
  for (const decision of plan.needsDecision) diagnostics.push(diagnostic('RHINOQ_PLAN_NEEDS_DECISION', 'warning', 'validate', decision, 'Resolve the decision in the Task declaration or provider capability evidence.'));
  if (action === 'doctor' || action === 'dev') {
    if (!plan.deployment) diagnostics.push(diagnostic('RHINOQ_DEPLOYMENT_NOT_CONFIGURED', action === 'dev' ? 'error' : 'warning', 'project', 'The canonical plan has no deployment identity.', 'Add defineRhinoQDeployment() to the application compiler.'));
    for (const gap of plan.capabilityGraph?.unresolvedOptional ?? []) diagnostics.push(diagnostic('RHINOQ_CAPABILITY_OPTIONAL_UNRESOLVED', 'info', 'link', `${gap.capability} requested by ${gap.requiredBy} is not linked.`, 'Link a provider when the optional capability is needed in this stage.'));
  }
  if (action === 'diff') {
    if (!input.previous) throw new TypeError('RhinoQ compiler diff requires a previous canonical plan');
    const diff = diffPlans(input.previous, plan);
    const changed = diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0 || diff.deploymentChanged || diff.capabilityGraphChanged;
    return freeze({ kind: 'rhinoq-compiler-workflow', schemaVersion: 1, action, status: changed ? 'changed' : 'unchanged', planFingerprint: plan.fingerprint, diagnostics, diff });
  }
  const blocking = diagnostics.some((item) => item.severity === 'error') || plan.status === 'needs-decision';
  const dev = action === 'dev' && plan.deployment ? {
    namespace: plan.deployment.namespace,
    environment: Object.freeze({ RHINOQ_APP: plan.deployment.app, RHINOQ_STAGE: plan.deployment.stage, RHINOQ_DEPLOYMENT_NAMESPACE: plan.deployment.namespace, RHINOQ_PLAN_FINGERPRINT: plan.fingerprint }),
    handlers: Object.freeze(plan.tasks.map((task) => task.name).sort(compare)),
  } : undefined;
  return freeze({ kind: 'rhinoq-compiler-workflow', schemaVersion: 1, action, status: blocking ? 'needs-decision' : 'ready', planFingerprint: plan.fingerprint, diagnostics, ...(dev ? { dev } : {}) });
}

function diffPlans(previous: RhinoQPlan, current: RhinoQPlan): NonNullable<RhinoQCompilerWorkflowResult['diff']> {
  const before = new Map(previous.tasks.map((task) => [task.name, JSON.stringify(task)]));
  const after = new Map(current.tasks.map((task) => [task.name, JSON.stringify(task)]));
  return Object.freeze({
    schemaVersion: 1, previous: previous.fingerprint, current: current.fingerprint,
    added: Object.freeze([...after.keys()].filter((name) => !before.has(name)).sort(compare)),
    removed: Object.freeze([...before.keys()].filter((name) => !after.has(name)).sort(compare)),
    changed: Object.freeze([...after.keys()].filter((name) => before.has(name) && before.get(name) !== after.get(name)).sort(compare)),
    deploymentChanged: previous.deployment?.fingerprint !== current.deployment?.fingerprint,
    capabilityGraphChanged: previous.capabilityGraph?.fingerprint !== current.capabilityGraph?.fingerprint,
  });
}

function diagnostic(code: string, severity: RhinoQCompilerDiagnostic['severity'], phase: RhinoQCompilerDiagnostic['phase'], whatHappened: string, howToFix: string): RhinoQCompilerDiagnostic {
  return Object.freeze({ code, severity, phase, subject: Object.freeze({ kind: 'application', name: 'rhinoq-plan' }), whatHappened, whyItMatters: 'The selected workflow cannot safely infer missing deployment or capability facts.', whatRhinoQDid: 'RhinoQ kept the workflow read-only and did not start an adapter or change configuration.', howToFix, verify: 'Regenerate the canonical plan and rerun the same command.' });
}

function freeze<T extends object>(value: T): Readonly<T> { return Object.freeze({ ...value, diagnostics: Object.freeze([...(value as T & { diagnostics: RhinoQCompilerDiagnostic[] }).diagnostics]) }); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
