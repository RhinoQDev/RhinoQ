import type { RhinoQPlan } from '../tasks/plan-inspector.js';

export interface CompileRhinoQSSTDeploymentOptions {
  readonly plan: RhinoQPlan;
  readonly worker: {
    /** Application-owned container image reference. */
    readonly image: string;
    /** Explicit command because RhinoQ cannot infer an adopter image layout. */
    readonly command: readonly string[];
    readonly cpu?: string;
    readonly memory?: string;
  };
  readonly migration?: {
    readonly image?: string;
    readonly command: readonly string[];
  };
  readonly workbench?: boolean;
}

export interface RhinoQSSTDeploymentSpec {
  readonly kind: 'rhinoq-sst-deployment';
  readonly schemaVersion: 1;
  readonly app: string;
  readonly stage: string;
  readonly namespace: string;
  readonly planFingerprint: string;
  readonly worker: {
    readonly name: string;
    readonly image: string;
    readonly command: readonly string[];
    readonly handlers: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly cpu?: string;
    readonly memory?: string;
  };
  readonly migration?: { readonly name: string; readonly image: string; readonly command: readonly string[]; readonly environment: Readonly<Record<string, string>> };
  readonly requiredLinks: readonly string[];
  readonly workbench: boolean;
  readonly limitations: readonly string[];
  readonly fingerprint: string;
}

export interface RhinoQSSTMaterializer<Resource = unknown> {
  service(name: string, args: {
    image: string;
    command: readonly string[];
    environment: Readonly<Record<string, string>>;
    links: readonly Resource[];
    cpu?: string;
    memory?: string;
    workbench: boolean;
  }): Resource;
  migration?(name: string, args: {
    image: string;
    command: readonly string[];
    environment: Readonly<Record<string, string>>;
    links: readonly Resource[];
  }): Resource;
}

/** Compile an SST-facing spec; this function creates no cloud resources. */
export function compileRhinoQSSTDeployment(options: CompileRhinoQSSTDeploymentOptions): RhinoQSSTDeploymentSpec {
  const plan = options?.plan;
  if (!plan || plan.kind !== 'rhinoq-plan' || plan.schemaVersion !== 1) throw new TypeError('RhinoQ SST deployment requires a canonical plan');
  if (!plan.deployment) throw new TypeError('RhinoQ SST deployment requires plan.deployment from defineRhinoQDeployment()');
  const image = required(options.worker?.image, 'worker image');
  const command = commandList(options.worker?.command, 'worker command');
  const migration = options.migration ? Object.freeze({
    name: `${plan.deployment.namespace}-migrate`,
    image: required(options.migration.image ?? image, 'migration image'),
    command: commandList(options.migration.command, 'migration command'),
    environment: environment(plan),
  }) : undefined;
  const requiredLinks = Object.freeze([...new Set(plan.capabilityGraph?.links.map((link) => link.capability) ?? [])].sort(compare));
  const unsigned = {
    kind: 'rhinoq-sst-deployment' as const,
    schemaVersion: 1 as const,
    app: plan.deployment.app,
    stage: plan.deployment.stage,
    namespace: plan.deployment.namespace,
    planFingerprint: plan.fingerprint,
    worker: Object.freeze({
      name: `${plan.deployment.namespace}-worker`, image, command,
      handlers: Object.freeze(plan.tasks.map((task) => task.name).sort(compare)),
      environment: environment(plan),
      ...(options.worker.cpu ? { cpu: options.worker.cpu } : {}),
      ...(options.worker.memory ? { memory: options.worker.memory } : {}),
    }),
    ...(migration ? { migration } : {}),
    requiredLinks,
    workbench: options.workbench === true,
    limitations: Object.freeze([
      'the application owns VPC, cluster, database, image, secrets and provider resource selection',
      'materialization declares SST resources but does not move lease, retry, effect or Task-state authority out of RhinoQ',
    ]),
  };
  return Object.freeze({ ...unsigned, fingerprint: fingerprint(unsigned) });
}

/**
 * Materialize an already compiled spec through factories supplied by the SST
 * composition root. Every required capability link must be supplied exactly
 * once; RhinoQ never resolves cloud resources or credentials itself.
 */
export function materializeRhinoQSSTDeployment<Resource>(options: {
  spec: RhinoQSSTDeploymentSpec;
  materializer: RhinoQSSTMaterializer<Resource>;
  links: Readonly<Record<string, Resource>>;
}): { readonly worker: Resource; readonly migration?: Resource } {
  const { spec, materializer } = options;
  if (!spec || spec.kind !== 'rhinoq-sst-deployment' || spec.schemaVersion !== 1) throw new TypeError('RhinoQ SST deployment spec is invalid');
  if (!materializer || typeof materializer.service !== 'function') throw new TypeError('RhinoQ SST materializer.service is required');
  const missing = spec.requiredLinks.filter((capability) => !(capability in (options.links ?? {})));
  if (missing.length) throw new TypeError(`RhinoQ SST deployment is missing resource links: ${missing.join(', ')}`);
  const links = Object.freeze(spec.requiredLinks.map((capability) => options.links[capability]!));
  const migration = spec.migration
    ? (() => {
      if (typeof materializer.migration !== 'function') throw new TypeError('RhinoQ SST materializer.migration is required by the compiled spec');
      return materializer.migration(spec.migration.name, { image: spec.migration.image, command: spec.migration.command, environment: spec.migration.environment, links });
    })()
    : undefined;
  const worker = materializer.service(spec.worker.name, {
    image: spec.worker.image, command: spec.worker.command, environment: spec.worker.environment,
    links, ...(spec.worker.cpu ? { cpu: spec.worker.cpu } : {}), ...(spec.worker.memory ? { memory: spec.worker.memory } : {}),
    workbench: spec.workbench,
  });
  return Object.freeze({ worker, ...(migration === undefined ? {} : { migration }) });
}

function environment(plan: RhinoQPlan): Readonly<Record<string, string>> {
  return Object.freeze({
    RHINOQ_APP: plan.deployment!.app,
    RHINOQ_STAGE: plan.deployment!.stage,
    RHINOQ_DEPLOYMENT_NAMESPACE: plan.deployment!.namespace,
    RHINOQ_PLAN_FINGERPRINT: plan.fingerprint,
    RHINOQ_REGISTERED_HANDLERS: plan.tasks.map((task) => task.name).sort(compare).join(','),
  });
}

function commandList(value: readonly string[] | undefined, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== 'string' || !part.trim() || /[\r\n\0]/.test(part))) throw new TypeError(`RhinoQ SST ${field} is required and must contain safe argv entries`);
  return Object.freeze(value.map((part) => part.trim()));
}

function required(value: string | undefined, field: string): string {
  if (!value?.trim() || /[\r\n\0]/.test(value)) throw new TypeError(`RhinoQ SST ${field} is required`);
  return value.trim();
}

function fingerprint(value: unknown): string {
  const input = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
