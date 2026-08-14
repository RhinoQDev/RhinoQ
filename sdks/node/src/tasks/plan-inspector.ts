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
  note: 'read-only compiled manifest; no configuration was generated or changed';
}

/** Compile the existing manifest into the canonical plan used by CLI/docs/UI. */
export function compileRhinoQPlan(manifest: RhinoQPlanManifest): RhinoQPlan {
  if (!manifest || manifest.schemaVersion !== 1) throw new TypeError('RhinoQ plan manifest schemaVersion must be 1');
  if (typeof manifest.profile !== 'string' || !manifest.profile.trim()) throw new TypeError('RhinoQ plan manifest profile is required');
  if (!Array.isArray(manifest.tasks)) throw new TypeError('RhinoQ plan manifest tasks must be an array');

  const tasks = Object.freeze([...manifest.tasks]
    .map((task) => Object.freeze(cloneManifestTask(task)))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  if (new Set(tasks.map((task) => task.key)).size !== tasks.length) throw new TypeError('RhinoQ plan task keys must be unique');
  if (new Set(tasks.map((task) => task.name)).size !== tasks.length) throw new TypeError('RhinoQ plan task names must be unique');
  const capabilities = Object.freeze([...new Set(tasks.map((task) => task.capability ?? 'task'))].sort());
  const requirements = Object.freeze([...new Set(tasks.flatMap((task) => taskRequirements(task)))].sort());
  const needsDecision = Object.freeze(tasks.flatMap((task) => (task.dataPath?.needsDecision ?? []).map((decision) => `${task.name}: ${decision}`)));
  const limitations = Object.freeze([...new Set(tasks.flatMap(taskLimitations))].sort());
  const unsigned = {
    kind: 'rhinoq-plan' as const,
    schemaVersion: 1 as const,
    profile: manifest.profile.trim(),
    fingerprintAlgorithm: 'fnv1a32' as const,
    status: needsDecision.length ? 'needs-decision' as const : 'ready' as const,
    tasks,
    capabilities,
    requirements,
    needsDecision,
    limitations,
    note: 'read-only compiled plan; no configuration was generated or changed' as const,
  };
  return Object.freeze({ ...unsigned, fingerprint: stableFingerprint(unsigned) });
}

/** Adapt an explicit JSON artifact without applying it or importing source. */
export function adaptRhinoQPlanJson(input: unknown): RhinoQPlanAdapterResult {
  const isCanonical = Boolean(input && typeof input === 'object' && (input as { kind?: unknown }).kind === 'rhinoq-plan');
  try {
    const plan = compileRhinoQPlan(input as RhinoQPlanManifest);
    const warnings = isCanonical ? [] : ['input is a legacy application manifest; it was projected into RhinoQPlan without applying changes'];
    return Object.freeze({
      schemaVersion: 1 as const,
      source: isCanonical ? 'json-plan' as const : 'legacy-manifest' as const,
      confidence: isCanonical ? 'high' as const : 'medium' as const,
      plan,
      warnings: Object.freeze(warnings),
      unsupported: Object.freeze([] as string[]),
    });
  } catch (error) {
    return Object.freeze({
      schemaVersion: 1 as const,
      source: isCanonical ? 'json-plan' as const : 'legacy-manifest' as const,
      confidence: 'low' as const,
      warnings: Object.freeze([] as string[]),
      unsupported: Object.freeze(['invalid or unsupported plan input']),
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
  return {
    schemaVersion: 1,
    status: needsDecision.length ? 'needs-decision' : 'ready',
    profile: manifest.profile,
    tasks: Object.freeze(tasks),
    needsDecision: Object.freeze(needsDecision),
    note: 'read-only compiled manifest; no configuration was generated or changed',
  };
}

function cloneManifestTask(task: RhinoQPlanManifestTask): RhinoQPlanManifestTask {
  if (!task || typeof task !== 'object') throw new TypeError('RhinoQ plan task must be an object');
  if (!task.key?.trim() || !task.name?.trim()) throw new TypeError('RhinoQ plan task key and name are required');
  if (!Number.isSafeInteger(task.version) || task.version < 1) throw new TypeError(`RhinoQ plan task ${task.name} version must be positive`);
  for (const [field, value] of [['adapter', task.adapter], ['runtime', task.runtime], ['scope', task.scope]] as const) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`RhinoQ plan task ${task.name} ${field} is required`);
  }
  if (!task.retry || !['never', 'runtime'].includes(task.retry.mode)) throw new TypeError(`RhinoQ plan task ${task.name} retry mode is invalid`);
  if (task.retry.mode === 'runtime') {
    const maxAttempts = task.retry.maxAttempts;
    if (typeof maxAttempts !== 'number' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new TypeError(`RhinoQ plan task ${task.name} retry maxAttempts is invalid`);
    }
  }
  if (typeof task.externalEffect !== 'boolean') throw new TypeError(`RhinoQ plan task ${task.name} externalEffect is invalid`);
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
  if (dataPath.schemaVersion !== undefined && dataPath.schemaVersion !== 1) throw new TypeError(`RhinoQ plan task ${name} data path schemaVersion is invalid`);
  if (!dataPath.workload?.trim() || !dataPath.input || !dataPath.output || !Array.isArray(dataPath.needsDecision)) {
    throw new TypeError(`RhinoQ plan task ${name} data path is invalid`);
  }
  if (!dataPath.input.transport?.trim() || !dataPath.input.queueCarries?.trim() || !dataPath.output.transport?.trim() || dataPath.output.checksumRequired !== true) {
    throw new TypeError(`RhinoQ plan task ${name} data path transport/checksum is invalid`);
  }
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
