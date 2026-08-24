export interface DefineRhinoQDeploymentOptions {
  /** Stable product/application identity, independent from a deploy target. */
  readonly app: string;
  /** Environment identity such as dev, pr-123, staging or production. */
  readonly stage: string;
  /** Optional provider region label; it does not select a provider by itself. */
  readonly region?: string;
  /** Optional application-owned account/project reference, never a credential. */
  readonly target?: string;
  /** Current Go Agent deployment boundary remains one tenant per process. */
  readonly tenantBoundary?: 'single-tenant-process';
}

export interface RhinoQDeploymentIdentity {
  readonly kind: 'rhinoq-deployment';
  readonly schemaVersion: 1;
  readonly app: string;
  readonly stage: string;
  readonly namespace: string;
  readonly region?: string;
  readonly target?: string;
  readonly tenantBoundary: 'single-tenant-process';
  readonly fingerprint: string;
  readonly note: 'deployment identity namespaces resources and evidence; it is not an authorization claim';
}

/** Create a deterministic deployment identity without inspecting cloud state. */
export function defineRhinoQDeployment(options: DefineRhinoQDeploymentOptions): RhinoQDeploymentIdentity {
  const app = segment(options?.app, 'app');
  const stage = segment(options?.stage, 'stage');
  const region = optionalLabel(options?.region, 'region');
  const target = optionalLabel(options?.target, 'target');
  const tenantBoundary = options?.tenantBoundary ?? 'single-tenant-process';
  if (tenantBoundary !== 'single-tenant-process') throw new TypeError('RhinoQ deployment tenantBoundary must be single-tenant-process');
  const unsigned = {
    kind: 'rhinoq-deployment' as const,
    schemaVersion: 1 as const,
    app,
    stage,
    namespace: `${app}-${stage}`,
    ...(region ? { region } : {}),
    ...(target ? { target } : {}),
    tenantBoundary,
    note: 'deployment identity namespaces resources and evidence; it is not an authorization claim' as const,
  };
  return Object.freeze({ ...unsigned, fingerprint: fingerprint(unsigned) });
}

/** Prefix one application-owned resource key with the canonical deployment namespace. */
export function rhinoQDeploymentResource(identity: RhinoQDeploymentIdentity, resource: string): string {
  if (!identity || identity.kind !== 'rhinoq-deployment' || identity.schemaVersion !== 1) throw new TypeError('RhinoQ deployment identity is invalid');
  return `${identity.namespace}-${segment(resource, 'resource')}`;
}

function segment(value: string | undefined, field: string): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(normalized) || normalized.endsWith('-')) {
    throw new TypeError(`RhinoQ deployment ${field} must be a lowercase DNS-safe segment`);
  }
  return normalized;
}

function optionalLabel(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\r\n\0]/.test(normalized)) throw new TypeError(`RhinoQ deployment ${field} is invalid`);
  return normalized;
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
