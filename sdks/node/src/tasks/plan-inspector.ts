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
    workload: string;
    input: { transport: string; queueCarries: string };
    output: { transport: string; checksumRequired: boolean };
    needsDecision: readonly string[];
  };
}

export interface RhinoQPlanManifest {
  schemaVersion: 1;
  profile: string;
  tasks: readonly RhinoQPlanManifestTask[];
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
