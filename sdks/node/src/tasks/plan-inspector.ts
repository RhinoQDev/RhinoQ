/** Bounded, read-only view of the compiler output for the operator Console. */
export interface RhinoQPlanManifestTask {
  key: string;
  name: string;
  version: number;
  adapter: string;
  runtime: string;
  scope: string;
  retry: { mode: string; maxAttempts?: number };
  externalEffect: boolean;
  capability?: string;
  resources?: {
    timeoutMs?: number; concurrency?: number; maxRssBytes?: number; workspaceBytes?: number;
    minDiskFreeBytes?: number; gpu?: string; region?: string; codec?: string;
  };
  schedule?: { expression: string; timezone?: string; enabled?: boolean };
  dataPath?: {
    schemaVersion?: 1;
    workload: string;
    input: { transport: string; maxInlineBytes?: number; queueCarries: string };
    output: { transport: string; checksumRequired: boolean };
    multipart?: { partBytes: number; maxParts: number; concurrency: number };
    admission?: {
      workspaceBytes?: number; diskFreeBytes?: number; minDiskFreeBytes?: number;
      gpu?: string; region?: string; codec?: string;
    };
    decisions?: readonly string[];
    needsDecision: readonly string[];
  };
}

export interface RhinoQPlanManifest {
  schemaVersion: 1;
  profile: string;
  tasks: readonly RhinoQPlanManifestTask[];
  capabilityGraph?: RhinoQPlanCapabilityGraph;
  deployment?: RhinoQPlanDeploymentIdentity;
}

export interface RhinoQPlanDeploymentIdentity {
  readonly kind: 'rhinoq-deployment';
  readonly schemaVersion: 1;
  readonly app: string;
  readonly stage: string;
  readonly namespace: string;
  readonly region?: string;
  readonly target?: string;
  readonly tenantBoundary: 'single-tenant-process';
  readonly fingerprint: string;
}

export interface RhinoQPlanCapabilityGraph {
  readonly kind: 'rhinoq-capability-graph';
  readonly schemaVersion: 1;
  readonly fingerprint: string;
  readonly links: readonly {
    readonly capability: string;
    readonly provider: string;
    readonly requiredBy: readonly string[];
    readonly binding: { readonly properties: Readonly<Record<string, string | number | boolean>>; readonly secretRefs: readonly string[]; readonly permissions: readonly string[] };
  }[];
  readonly unresolvedOptional: readonly { readonly capability: string; readonly requiredBy: string; readonly optional?: boolean }[];
}

/**
 * Canonical, deterministic description of one compiled RhinoQ application.
 *
 * This is deliberately a read-only projection of the existing application
 * manifest. It is not a second task declaration language and it contains no
 * handler code, credentials or provider instances.
 */
export interface RhinoQPlan {
  kind: 'rhinoq-plan';
  schemaVersion: 1;
  profile: string;
  fingerprint: string;
  fingerprintAlgorithm: 'fnv1a32';
  status: 'ready' | 'needs-decision';
  tasks: readonly RhinoQPlanManifestTask[];
  capabilities: readonly string[];
  requirements: readonly string[];
  needsDecision: readonly string[];
  limitations: readonly string[];
  capabilityGraph?: RhinoQPlanCapabilityGraph;
  deployment?: RhinoQPlanDeploymentIdentity;
  note: 'read-only compiled plan; no configuration was generated or changed';
}

export interface RhinoQPlanAdapterResult {
  readonly schemaVersion: 1;
  readonly source: 'json-plan' | 'legacy-manifest';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly plan?: RhinoQPlan;
  readonly warnings: readonly string[];
  readonly unsupported: readonly string[];
  readonly error?: string;
}

export type RhinoQCompilerPhase = 'normalize' | 'validate' | 'link' | 'project';

/**
 * Stable, transport-safe compiler feedback shared by CLI, CI and Workbench.
 * It deliberately mirrors RhinoQ's five-part Go diagnostic contract without
 * carrying an Error instance, credentials or application source.
 */
export interface RhinoQCompilerDiagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly phase: RhinoQCompilerPhase;
  readonly subject?: { readonly kind: 'application' | 'task' | 'capability'; readonly name: string };
  readonly whatHappened: string;
  readonly whyItMatters: string;
  readonly whatRhinoQDid: string;
  readonly howToFix: string;
  readonly verify: string;
}

export interface RhinoQPlanCompilation {
  readonly schemaVersion: 1;
  readonly status: 'valid' | 'invalid';
  readonly plan?: RhinoQPlan;
  readonly diagnostics: readonly RhinoQCompilerDiagnostic[];
  readonly phases: readonly { readonly phase: RhinoQCompilerPhase; readonly status: 'completed' | 'failed' | 'not-run' }[];
}

class RhinoQPlanCompileError extends TypeError {
  constructor(
    readonly code: string,
    readonly phase: RhinoQCompilerPhase,
    message: string,
    readonly howToFix: string,
    readonly subject?: RhinoQCompilerDiagnostic['subject'],
  ) {
    super(message);
    this.name = 'RhinoQPlanCompileError';
  }
}

export interface RhinoQPlanTaskInspection {
  key: string;
  name: string;
  factory: string;
  version: number;
  readiness: 'ready' | 'needs-decision';
  needsDecision: readonly string[];
  compiledCapsule: {
    adapter: string;
    runtime: string;
    scope: string;
    retry: { mode: string; maxAttempts?: number };
    externalEffect: boolean;
    resources?: RhinoQPlanManifestTask['resources'];
    schedule?: RhinoQPlanManifestTask['schedule'];
    dataPath?: {
      workload: string;
      inputTransport: string;
      outputTransport: string;
      checksumRequired: boolean;
    };
  };
}

export interface RhinoQPlanInspection {
  schemaVersion: 1;
  status: 'ready' | 'needs-decision' | 'not-configured';
  profile?: string;
  tasks: readonly RhinoQPlanTaskInspection[];
  needsDecision: readonly string[];
  deployment?: { readonly app: string; readonly stage: string; readonly namespace: string; readonly fingerprint: string; readonly tenantBoundary: 'single-tenant-process' };
  capabilityLinks?: readonly { readonly capability: string; readonly provider: string; readonly requiredBy: readonly string[]; readonly secretRefs: readonly string[]; readonly permissions: readonly string[] }[];
  unresolvedOptionalCapabilities?: readonly { readonly capability: string; readonly requiredBy: string }[];
  note: 'read-only compiled manifest; no configuration was generated or changed';
}

/** Compile the existing manifest into the canonical plan used by CLI/docs/UI. */
export function compileRhinoQPlan(manifest: RhinoQPlanManifest): RhinoQPlan {
  const result = compileRhinoQPlanResult(manifest);
  if (!result.plan) throw new TypeError(result.diagnostics[0]?.whatHappened ?? 'RhinoQ plan is invalid');
  return result.plan;
}

/** Compile without throwing so every interface can render the same evidence. */
export function compileRhinoQPlanResult(input: unknown): RhinoQPlanCompilation {
  try {
    return Object.freeze({
      schemaVersion: 1 as const,
      status: 'valid' as const,
      plan: compileValidatedRhinoQPlan(input as RhinoQPlanManifest),
      diagnostics: Object.freeze([] as RhinoQCompilerDiagnostic[]),
      phases: phaseTrace(),
    });
  } catch (error) {
    const diagnostic = compilerDiagnostic(error);
    return Object.freeze({
      schemaVersion: 1 as const,
      status: 'invalid' as const,
      diagnostics: Object.freeze([diagnostic]),
      phases: phaseTrace(diagnostic.phase),
    });
  }
}

function compileValidatedRhinoQPlan(manifest: RhinoQPlanManifest): RhinoQPlan {
  const normalized = normalizePlanManifest(manifest);
  const validated = validatePlanManifest(normalized);
  const linked = linkPlanManifest(validated);
  return projectPlan(linked);
}

interface NormalizedPlanManifest {
  readonly profile: string;
  readonly tasks: readonly RhinoQPlanManifestTask[];
  readonly capabilityGraph?: RhinoQPlanCapabilityGraph;
  readonly deployment?: RhinoQPlanDeploymentIdentity;
}

function normalizePlanManifest(manifest: RhinoQPlanManifest): NormalizedPlanManifest {
  if (!manifest || manifest.schemaVersion !== 1) fail('RHINOQ_PLAN_SCHEMA_UNSUPPORTED', 'normalize', 'RhinoQ plan manifest schemaVersion must be 1', 'Regenerate the plan with a RhinoQ version that supports manifest schemaVersion 1.');
  if (typeof manifest.profile !== 'string' || !manifest.profile.trim()) fail('RHINOQ_PLAN_PROFILE_REQUIRED', 'normalize', 'RhinoQ plan manifest profile is required', 'Set a stable, non-empty execution profile name.');
  if (!Array.isArray(manifest.tasks)) fail('RHINOQ_PLAN_TASKS_REQUIRED', 'normalize', 'RhinoQ plan manifest tasks must be an array', 'Emit a tasks array, using an empty array when the application declares no Tasks.');
  const tasks = Object.freeze([...manifest.tasks]);
  return Object.freeze({ profile: manifest.profile.trim(), tasks, ...(manifest.capabilityGraph ? { capabilityGraph: manifest.capabilityGraph } : {}), ...(manifest.deployment ? { deployment: manifest.deployment } : {}) });
}

function validatePlanManifest(manifest: NormalizedPlanManifest): NormalizedPlanManifest {
  const tasks = Object.freeze([...manifest.tasks]
    .map((task) => Object.freeze(cloneManifestTask(task)))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  if (new Set(tasks.map((task) => task.key)).size !== tasks.length) fail('RHINOQ_PLAN_IDENTITY_CONFLICT', 'validate', 'RhinoQ plan task keys must be unique', 'Give every Task declaration a unique registry key.');
  if (new Set(tasks.map((task) => task.name)).size !== tasks.length) fail('RHINOQ_PLAN_IDENTITY_CONFLICT', 'validate', 'RhinoQ plan task names must be unique', 'Give every Task a unique public name.');
  return Object.freeze({ ...manifest, tasks });
}

function linkPlanManifest(manifest: NormalizedPlanManifest): NormalizedPlanManifest {
  const capabilityGraph = manifest.capabilityGraph ? cloneCapabilityGraph(manifest.capabilityGraph) : undefined;
  const deployment = manifest.deployment ? cloneDeployment(manifest.deployment) : undefined;
  return Object.freeze({ ...manifest, ...(capabilityGraph ? { capabilityGraph } : {}), ...(deployment ? { deployment } : {}) });
}

function projectPlan(manifest: NormalizedPlanManifest): RhinoQPlan {
  const { tasks } = manifest;
  const capabilities = Object.freeze([...new Set(tasks.map((task) => task.capability ?? 'task'))].sort());
  const requirements = Object.freeze([...new Set(tasks.flatMap((task) => taskRequirements(task)))].sort());
  const needsDecision = Object.freeze(tasks.flatMap((task) => (task.dataPath?.needsDecision ?? []).map((decision) => `${task.name}: ${decision}`)));
  const limitations = Object.freeze([...new Set(tasks.flatMap(taskLimitations))].sort());
  const unsigned = {
    kind: 'rhinoq-plan' as const,
    schemaVersion: 1 as const,
    profile: manifest.profile,
    fingerprintAlgorithm: 'fnv1a32' as const,
    status: needsDecision.length ? 'needs-decision' as const : 'ready' as const,
    tasks,
    capabilities,
    requirements,
    needsDecision,
    limitations,
    ...(manifest.capabilityGraph ? { capabilityGraph: manifest.capabilityGraph } : {}),
    ...(manifest.deployment ? { deployment: manifest.deployment } : {}),
    note: 'read-only compiled plan; no configuration was generated or changed' as const,
  };
  return Object.freeze({ ...unsigned, fingerprint: stableFingerprint(unsigned) });
}

/** Adapt an explicit JSON artifact without applying it or importing source. */
export function adaptRhinoQPlanJson(input: unknown): RhinoQPlanAdapterResult {
  const isCanonical = Boolean(input && typeof input === 'object' && (input as { kind?: unknown }).kind === 'rhinoq-plan');
  const compilation = compileRhinoQPlanResult(input);
  if (compilation.plan) {
    const plan = compilation.plan;
    const warnings = isCanonical ? [] : ['input is a legacy application manifest; it was projected into RhinoQPlan without applying changes'];
    return Object.freeze({
      schemaVersion: 1 as const,
      source: isCanonical ? 'json-plan' as const : 'legacy-manifest' as const,
      confidence: isCanonical ? 'high' as const : 'medium' as const,
      plan,
      warnings: Object.freeze(warnings),
      unsupported: Object.freeze([] as string[]),
    });
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    source: isCanonical ? 'json-plan' as const : 'legacy-manifest' as const,
    confidence: 'low' as const,
    warnings: Object.freeze([] as string[]),
    unsupported: Object.freeze(['invalid or unsupported plan input']),
    error: compilation.diagnostics[0]?.whatHappened ?? 'RhinoQ plan is invalid',
  });
}

export function inspectRhinoQPlan(manifest?: RhinoQPlanManifest): RhinoQPlanInspection {
  if (!manifest) {
    return {
      schemaVersion: 1,
      status: 'not-configured',
      tasks: [],
      needsDecision: ['start the typed application compiler to expose a plan'],
      note: 'read-only compiled manifest; no configuration was generated or changed',
    };
  }
  const tasks = manifest.tasks.map((task) => {
    const needsDecision = [...(task.dataPath?.needsDecision ?? [])];
    const dataPath = task.dataPath ? {
      workload: task.dataPath.workload,
      inputTransport: task.dataPath.input.transport,
      outputTransport: task.dataPath.output.transport,
      checksumRequired: task.dataPath.output.checksumRequired,
    } : undefined;
    return {
      key: task.key,
      name: task.name,
      factory: task.capability ?? 'task',
      version: task.version,
      readiness: needsDecision.length ? 'needs-decision' as const : 'ready' as const,
      needsDecision: Object.freeze(needsDecision),
      compiledCapsule: {
        adapter: task.adapter,
        runtime: task.runtime,
        scope: task.scope,
        retry: Object.freeze({ ...task.retry }),
        externalEffect: task.externalEffect,
        ...(task.resources ? { resources: Object.freeze({ ...task.resources }) } : {}),
        ...(task.schedule ? { schedule: Object.freeze({ ...task.schedule }) } : {}),
        ...(dataPath ? { dataPath: Object.freeze(dataPath) } : {}),
      },
    };
  });
  const needsDecision = tasks.flatMap((task) => task.needsDecision.map((decision) => `${task.name}: ${decision}`));
  const deployment = manifest.deployment ? Object.freeze({
    app: manifest.deployment.app, stage: manifest.deployment.stage, namespace: manifest.deployment.namespace,
    fingerprint: manifest.deployment.fingerprint, tenantBoundary: manifest.deployment.tenantBoundary,
  }) : undefined;
  const capabilityLinks = manifest.capabilityGraph ? Object.freeze(manifest.capabilityGraph.links.map((link) => Object.freeze({
    capability: link.capability, provider: link.provider, requiredBy: Object.freeze([...link.requiredBy]),
    secretRefs: Object.freeze([...link.binding.secretRefs]), permissions: Object.freeze([...link.binding.permissions]),
  }))) : undefined;
  const unresolvedOptionalCapabilities = manifest.capabilityGraph ? Object.freeze(manifest.capabilityGraph.unresolvedOptional.map((item) => Object.freeze({ capability: item.capability, requiredBy: item.requiredBy }))) : undefined;
  return {
    schemaVersion: 1,
    status: needsDecision.length ? 'needs-decision' : 'ready',
    profile: manifest.profile,
    tasks: Object.freeze(tasks),
    needsDecision: Object.freeze(needsDecision),
    ...(deployment ? { deployment } : {}),
    ...(capabilityLinks ? { capabilityLinks } : {}),
    ...(unresolvedOptionalCapabilities ? { unresolvedOptionalCapabilities } : {}),
    note: 'read-only compiled manifest; no configuration was generated or changed',
  };
}

function cloneManifestTask(task: RhinoQPlanManifestTask): RhinoQPlanManifestTask {
  if (!task || typeof task !== 'object') fail('RHINOQ_PLAN_TASK_INVALID', 'validate', 'RhinoQ plan task must be an object', 'Emit each Task as a structured manifest entry.');
  if (!task.key?.trim() || !task.name?.trim()) fail('RHINOQ_PLAN_TASK_IDENTITY_REQUIRED', 'validate', 'RhinoQ plan task key and name are required', 'Set both the registry key and public Task name.');
  const subject = { kind: 'task' as const, name: task.name };
  if (!Number.isSafeInteger(task.version) || task.version < 1) fail('RHINOQ_PLAN_TASK_VERSION_INVALID', 'validate', `RhinoQ plan task ${task.name} version must be positive`, 'Set a positive integer definition version.', subject);
  for (const [field, value] of [['adapter', task.adapter], ['runtime', task.runtime], ['scope', task.scope]] as const) {
    if (typeof value !== 'string' || !value.trim()) fail('RHINOQ_PLAN_TASK_ROUTE_REQUIRED', 'validate', `RhinoQ plan task ${task.name} ${field} is required`, `Link Task ${task.name} to a non-empty ${field}.`, subject);
  }
  if (!task.retry || !['never', 'runtime'].includes(task.retry.mode)) fail('RHINOQ_PLAN_RETRY_INVALID', 'validate', `RhinoQ plan task ${task.name} retry mode is invalid`, 'Use retry mode `never` or `runtime`.', subject);
  if (task.retry.mode === 'runtime') {
    const maxAttempts = task.retry.maxAttempts;
    if (typeof maxAttempts !== 'number' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      fail('RHINOQ_PLAN_RETRY_INVALID', 'validate', `RhinoQ plan task ${task.name} retry maxAttempts is invalid`, 'Set retry.maxAttempts to a positive integer.', subject);
    }
  }
  if (typeof task.externalEffect !== 'boolean') fail('RHINOQ_PLAN_EFFECT_INVALID', 'validate', `RhinoQ plan task ${task.name} externalEffect is invalid`, 'Set externalEffect explicitly to true or false.', subject);
  if (task.dataPath) validateDataPath(task.name, task.dataPath);
  return {
    key: task.key.trim(),
    name: task.name.trim(),
    version: task.version,
    adapter: task.adapter,
    runtime: task.runtime,
    scope: task.scope,
    retry: Object.freeze({ ...task.retry }),
    externalEffect: task.externalEffect,
    ...(task.capability ? { capability: task.capability } : {}),
    ...(task.resources ? { resources: Object.freeze({ ...task.resources }) } : {}),
    ...(task.schedule ? { schedule: Object.freeze({ ...task.schedule }) } : {}),
    ...(task.dataPath ? {
      dataPath: Object.freeze({
        ...(task.dataPath.schemaVersion === undefined ? {} : { schemaVersion: task.dataPath.schemaVersion }),
        workload: task.dataPath.workload,
        input: Object.freeze({ ...task.dataPath.input }),
        output: Object.freeze({ ...task.dataPath.output }),
        ...(task.dataPath.multipart ? { multipart: Object.freeze({ ...task.dataPath.multipart }) } : {}),
        ...(task.dataPath.admission ? { admission: Object.freeze({ ...task.dataPath.admission }) } : {}),
        ...(task.dataPath.decisions ? { decisions: Object.freeze([...task.dataPath.decisions]) } : {}),
        needsDecision: Object.freeze([...task.dataPath.needsDecision]),
      }),
    } : {}),
  };
}

function validateDataPath(name: string, dataPath: NonNullable<RhinoQPlanManifestTask['dataPath']>): void {
  const subject = { kind: 'task' as const, name };
  if (dataPath.schemaVersion !== undefined && dataPath.schemaVersion !== 1) fail('RHINOQ_PLAN_DATA_PATH_SCHEMA_UNSUPPORTED', 'validate', `RhinoQ plan task ${name} data path schemaVersion is invalid`, 'Regenerate the data-path plan with schemaVersion 1.', subject);
  if (!dataPath.workload?.trim() || !dataPath.input || !dataPath.output || !Array.isArray(dataPath.needsDecision)) {
    fail('RHINOQ_PLAN_DATA_PATH_INVALID', 'validate', `RhinoQ plan task ${name} data path is invalid`, 'Compile the Task through the supported data-path planner.', subject);
  }
  if (!dataPath.input.transport?.trim() || !dataPath.input.queueCarries?.trim() || !dataPath.output.transport?.trim() || dataPath.output.checksumRequired !== true) {
    fail('RHINOQ_PLAN_DATA_PATH_INVALID', 'validate', `RhinoQ plan task ${name} data path transport/checksum is invalid`, 'Declare bounded transports and require an output checksum.', subject);
  }
}

function cloneCapabilityGraph(graph: RhinoQPlanCapabilityGraph): RhinoQPlanCapabilityGraph {
  if (!graph || graph.kind !== 'rhinoq-capability-graph' || graph.schemaVersion !== 1 || typeof graph.fingerprint !== 'string') {
    fail('RHINOQ_CAPABILITY_GRAPH_INVALID', 'link', 'RhinoQ capability graph is invalid', 'Recompile capability links with linkRhinoQCapabilities().');
  }
  if (!Array.isArray(graph.links) || !Array.isArray(graph.unresolvedOptional)) fail('RHINOQ_CAPABILITY_GRAPH_INVALID', 'link', 'RhinoQ capability graph links are invalid', 'Recompile capability links with linkRhinoQCapabilities().');
  const links = Object.freeze(graph.links.map((link) => Object.freeze({
    capability: link.capability,
    provider: link.provider,
    requiredBy: Object.freeze([...link.requiredBy]),
    binding: Object.freeze({
      properties: Object.freeze({ ...link.binding.properties }),
      secretRefs: Object.freeze([...link.binding.secretRefs]),
      permissions: Object.freeze([...link.binding.permissions]),
    }),
  })).sort((left, right) => left.capability < right.capability ? -1 : left.capability > right.capability ? 1 : 0));
  return Object.freeze({
    kind: 'rhinoq-capability-graph', schemaVersion: 1, fingerprint: graph.fingerprint, links,
    unresolvedOptional: Object.freeze(graph.unresolvedOptional.map((item) => Object.freeze({ ...item }))),
  });
}

function cloneDeployment(deployment: RhinoQPlanDeploymentIdentity): RhinoQPlanDeploymentIdentity {
  if (!deployment || deployment.kind !== 'rhinoq-deployment' || deployment.schemaVersion !== 1
    || !deployment.app?.trim() || !deployment.stage?.trim() || !deployment.namespace?.trim()
    || deployment.tenantBoundary !== 'single-tenant-process' || typeof deployment.fingerprint !== 'string') {
    fail('RHINOQ_DEPLOYMENT_IDENTITY_INVALID', 'project', 'RhinoQ deployment identity is invalid', 'Create deployment identity with defineRhinoQDeployment().');
  }
  return Object.freeze({
    kind: 'rhinoq-deployment', schemaVersion: 1,
    app: deployment.app, stage: deployment.stage, namespace: deployment.namespace,
    ...(deployment.region ? { region: deployment.region } : {}),
    ...(deployment.target ? { target: deployment.target } : {}),
    tenantBoundary: 'single-tenant-process', fingerprint: deployment.fingerprint,
  });
}

function taskRequirements(task: RhinoQPlanManifestTask): string[] {
  const requirements = [`adapter:${task.adapter}`, `runtime:${task.runtime}`, `scope:${task.scope}`];
  if (task.resources?.gpu && task.resources.gpu !== 'none') requirements.push(`gpu:${task.resources.gpu}`);
  if (task.resources?.codec) requirements.push(`codec:${task.resources.codec}`);
  if (task.resources?.region) requirements.push(`region:${task.resources.region}`);
  if (task.resources?.workspaceBytes !== undefined) requirements.push(`workspace:${task.resources.workspaceBytes}`);
  if (task.dataPath?.output.checksumRequired) requirements.push('output:checksum');
  return requirements;
}

function taskLimitations(task: RhinoQPlanManifestTask): string[] {
  const limitations: string[] = [];
  if (task.externalEffect) limitations.push(`${task.name}: external effect requires application-owned idempotency and confirmation`);
  if (task.dataPath?.input.transport === 'private-reference') limitations.push(`${task.name}: input payload is reference-only; storage/provider access remains application-owned`);
  if (task.dataPath?.output.transport === 'stream-to-storage') limitations.push(`${task.name}: output storage lifecycle remains provider/application-owned`);
  return limitations;
}

function stableFingerprint(value: unknown): string {
  const input = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function compilerDiagnostic(error: unknown): RhinoQCompilerDiagnostic {
  const whatHappened = error instanceof Error ? error.message : String(error);
  const typed = error instanceof RhinoQPlanCompileError ? error : undefined;
  return Object.freeze({
    code: typed?.code ?? 'RHINOQ_PLAN_INVALID',
    severity: 'error' as const,
    phase: typed?.phase ?? 'normalize',
    subject: Object.freeze(typed?.subject ?? { kind: 'application' as const, name: 'rhinoq-plan' }),
    whatHappened,
    whyItMatters: 'RhinoQ cannot produce a deterministic, safe deployment and runtime plan from ambiguous input.',
    whatRhinoQDid: 'Compilation stopped before starting an adapter, opening a database or changing configuration.',
    howToFix: typed?.howToFix ?? 'Correct the reported manifest field and compile the plan again.',
    verify: 'Run `npx rhinoq plan --json <manifest-or-plan.json>` and confirm that compilation succeeds.',
  });
}

function fail(
  code: string,
  phase: RhinoQCompilerPhase,
  message: string,
  howToFix: string,
  subject?: RhinoQCompilerDiagnostic['subject'],
): never {
  throw new RhinoQPlanCompileError(code, phase, message, howToFix, subject);
}

function phaseTrace(failed?: RhinoQCompilerPhase): RhinoQPlanCompilation['phases'] {
  const order: readonly RhinoQCompilerPhase[] = ['normalize', 'validate', 'link', 'project'];
  const failedAt = failed === undefined ? -1 : order.indexOf(failed);
  return Object.freeze(order.map((phase, index) => Object.freeze({
    phase,
    status: failed === undefined ? 'completed' as const : index < failedAt ? 'completed' as const : index === failedAt ? 'failed' as const : 'not-run' as const,
  })));
}
