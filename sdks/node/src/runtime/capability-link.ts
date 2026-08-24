import type { RhinoQModuleNamespace } from './modules.js';

export type RhinoQCapabilityId = `${RhinoQModuleNamespace}:${string}`;
export type RhinoQComponentId = `${RhinoQModuleNamespace}/${string}`;
export type RhinoQBindingScalar = string | number | boolean;

export interface RhinoQSecretReference {
  /** Logical reference only. Secret values never enter a plan or fingerprint. */
  readonly ref: string;
}

export interface RhinoQCapabilityBinding {
  readonly properties?: Readonly<Record<string, RhinoQBindingScalar>>;
  readonly secrets?: Readonly<Record<string, RhinoQSecretReference>>;
  readonly permissions?: readonly string[];
}

export interface RhinoQCapabilityComponent<Provides extends RhinoQCapabilityId = RhinoQCapabilityId> {
  readonly id: RhinoQComponentId;
  readonly version: number;
  readonly contractVersion: 1;
  readonly provides: readonly Provides[];
  readonly requires?: readonly RhinoQCapabilityId[];
  readonly binding?: RhinoQCapabilityBinding;
}

export interface RhinoQCapabilityRequirement<Capability extends RhinoQCapabilityId = RhinoQCapabilityId> {
  readonly capability: Capability;
  readonly requiredBy: string;
  readonly optional?: boolean;
}

export interface RhinoQCapabilityLink {
  readonly capability: RhinoQCapabilityId;
  readonly provider: RhinoQComponentId;
  readonly requiredBy: readonly string[];
  readonly binding: {
    readonly properties: Readonly<Record<string, RhinoQBindingScalar>>;
    readonly secretRefs: readonly string[];
    readonly permissions: readonly string[];
  };
}

export interface RhinoQCapabilityGraph {
  readonly kind: 'rhinoq-capability-graph';
  readonly schemaVersion: 1;
  readonly components: readonly RhinoQCapabilityComponent[];
  readonly links: readonly RhinoQCapabilityLink[];
  readonly unresolvedOptional: readonly RhinoQCapabilityRequirement[];
  readonly fingerprint: string;
  readonly note: 'bindings contain public metadata and secret references only; runtime values are resolved by the application';
}

/**
 * Link typed requirements to exactly one provider without provisioning it.
 * Ambiguous and missing required capabilities fail closed before runtime.
 */
export function linkRhinoQCapabilities(input: {
  components: readonly RhinoQCapabilityComponent[];
  requirements: readonly RhinoQCapabilityRequirement[];
}): RhinoQCapabilityGraph {
  if (!Array.isArray(input?.components)) throw new TypeError('RhinoQ capability components must be an array');
  if (!Array.isArray(input?.requirements)) throw new TypeError('RhinoQ capability requirements must be an array');
  const components = Object.freeze(input.components.map(normalizeComponent)
    .sort((left, right) => compare(left.id, right.id)));
  if (new Set(components.map((component) => component.id)).size !== components.length) {
    throw new TypeError('RhinoQ capability component ids must be unique');
  }

  const providers = new Map<RhinoQCapabilityId, RhinoQCapabilityComponent[]>();
  for (const component of components) {
    for (const capability of component.provides) {
      const entries = providers.get(capability) ?? [];
      entries.push(component);
      providers.set(capability, entries);
    }
  }
  for (const component of components) {
    for (const capability of component.requires ?? []) {
      const candidates = providers.get(capability) ?? [];
      if (candidates.length === 0) throw new TypeError(`RhinoQ component ${component.id} requires missing capability ${capability}`);
      if (candidates.length > 1) throw new TypeError(`RhinoQ component ${component.id} requires ambiguous capability ${capability}: ${candidates.map((item) => item.id).join(', ')}`);
    }
  }

  const requirements = input.requirements.map(normalizeRequirement);
  const grouped = new Map<RhinoQCapabilityId, RhinoQCapabilityRequirement[]>();
  for (const requirement of requirements) {
    const entries = grouped.get(requirement.capability) ?? [];
    entries.push(requirement);
    grouped.set(requirement.capability, entries);
  }
  const links: RhinoQCapabilityLink[] = [];
  const unresolvedOptional: RhinoQCapabilityRequirement[] = [];
  for (const capability of [...grouped.keys()].sort(compare)) {
    const consumers = grouped.get(capability)!;
    const candidates = providers.get(capability) ?? [];
    if (candidates.length > 1) throw new TypeError(`RhinoQ capability ${capability} has multiple providers: ${candidates.map((item) => item.id).join(', ')}`);
    if (candidates.length === 0) {
      const required = consumers.filter((item) => !item.optional);
      if (required.length) throw new TypeError(`RhinoQ capability ${capability} required by ${required.map((item) => item.requiredBy).sort(compare).join(', ')} has no provider`);
      unresolvedOptional.push(...consumers);
      continue;
    }
    const provider = candidates[0]!;
    links.push(Object.freeze({
      capability,
      provider: provider.id,
      requiredBy: Object.freeze([...new Set(consumers.map((item) => item.requiredBy))].sort(compare)),
      binding: publicBinding(provider.binding),
    }));
  }
  const unsigned = {
    kind: 'rhinoq-capability-graph' as const,
    schemaVersion: 1 as const,
    components,
    links: Object.freeze(links),
    unresolvedOptional: Object.freeze(unresolvedOptional.sort((left, right) => compare(`${left.capability}:${left.requiredBy}`, `${right.capability}:${right.requiredBy}`))),
    note: 'bindings contain public metadata and secret references only; runtime values are resolved by the application' as const,
  };
  return Object.freeze({ ...unsigned, fingerprint: fingerprint(unsigned) });
}

function normalizeComponent(component: RhinoQCapabilityComponent): RhinoQCapabilityComponent {
  if (!component?.id || !/^(runtime|processor|provider|storage|surface)\/[a-z0-9][a-z0-9._-]*$/i.test(component.id)) throw new TypeError('RhinoQ capability component id must be namespaced');
  if (!Number.isSafeInteger(component.version) || component.version < 1) throw new RangeError(`RhinoQ capability component ${component.id} version must be positive`);
  if (component.contractVersion !== 1) throw new TypeError(`RhinoQ capability component ${component.id} contractVersion must be 1`);
  if (!Array.isArray(component.provides) || component.provides.length === 0) throw new TypeError(`RhinoQ capability component ${component.id} must provide at least one capability`);
  const provides = Object.freeze([...new Set(component.provides.map(validateCapability))].sort(compare));
  const requires = Object.freeze([...new Set((component.requires ?? []).map(validateCapability))].sort(compare));
  return Object.freeze({ id: component.id, version: component.version, contractVersion: 1, provides, ...(requires.length ? { requires } : {}), ...(component.binding ? { binding: normalizeBinding(component.binding) } : {}) });
}

function normalizeRequirement(requirement: RhinoQCapabilityRequirement): RhinoQCapabilityRequirement {
  if (!requirement?.requiredBy?.trim()) throw new TypeError('RhinoQ capability requirement requiredBy is required');
  return Object.freeze({ capability: validateCapability(requirement.capability), requiredBy: requirement.requiredBy.trim(), ...(requirement.optional ? { optional: true } : {}) });
}

function validateCapability(value: RhinoQCapabilityId): RhinoQCapabilityId {
  if (typeof value !== 'string' || !/^(runtime|processor|provider|storage|surface):[a-z0-9][a-z0-9._-]*$/i.test(value)) throw new TypeError(`RhinoQ capability id is invalid: ${String(value)}`);
  return value;
}

function normalizeBinding(binding: RhinoQCapabilityBinding): RhinoQCapabilityBinding {
  const properties = Object.freeze({ ...(binding.properties ?? {}) });
  for (const [key, value] of Object.entries(properties)) {
    if (!key.trim() || !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new TypeError(`RhinoQ capability binding property is invalid: ${key}`);
  }
  const secrets = Object.freeze({ ...(binding.secrets ?? {}) });
  for (const [key, value] of Object.entries(secrets)) {
    if (!key.trim() || !value?.ref?.trim()) throw new TypeError(`RhinoQ capability secret reference is invalid: ${key}`);
  }
  const permissions = Object.freeze([...new Set(binding.permissions ?? [])].map((value) => value.trim()).filter(Boolean).sort(compare));
  return Object.freeze({ properties, secrets, permissions });
}

function publicBinding(binding?: RhinoQCapabilityBinding): RhinoQCapabilityLink['binding'] {
  return Object.freeze({
    properties: Object.freeze({ ...(binding?.properties ?? {}) }),
    secretRefs: Object.freeze(Object.values(binding?.secrets ?? {}).map((secret) => secret.ref).sort(compare)),
    permissions: Object.freeze([...(binding?.permissions ?? [])]),
  });
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

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
