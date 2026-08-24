import type { RhinoQCapabilityBinding, RhinoQCapabilityComponent, RhinoQCapabilityId, RhinoQComponentId } from './capability-link.js';
import { createRhinoQModule, type RhinoQLifecycleModule } from './modules.js';

export interface CreateRhinoQProviderComponentOptions<Provides extends RhinoQCapabilityId> {
  readonly id: Extract<RhinoQComponentId, `provider/${string}` | `storage/${string}`>;
  readonly version: number;
  readonly provides: readonly Provides[];
  readonly requires?: readonly RhinoQCapabilityId[];
  readonly binding?: RhinoQCapabilityBinding;
  provision?(): Promise<void> | void;
  validate?(): Promise<void> | void;
  cleanup?(): Promise<void> | void;
}

export interface RhinoQProviderComponent<Provides extends RhinoQCapabilityId = RhinoQCapabilityId> {
  /** Pure declaration safe for compiler, plan and CI. */
  readonly declaration: RhinoQCapabilityComponent<Provides>;
  /** Explicit imperative lifecycle used only by application composition. */
  readonly lifecycle: RhinoQLifecycleModule;
}

/**
 * Compose a provider declaration and lifecycle without letting plan
 * compilation invoke provisioning, validation or cleanup callbacks.
 */
export function createRhinoQProviderComponent<Provides extends RhinoQCapabilityId>(
  options: CreateRhinoQProviderComponentOptions<Provides>,
): RhinoQProviderComponent<Provides> {
  if (!options?.id || !/^(provider|storage)\/[a-z0-9][a-z0-9._-]*$/i.test(options.id)) throw new TypeError('RhinoQ provider component id must use provider/ or storage/ namespace');
  if (!Number.isSafeInteger(options.version) || options.version < 1) throw new RangeError('RhinoQ provider component version must be positive');
  if (!Array.isArray(options.provides) || options.provides.length === 0) throw new TypeError('RhinoQ provider component must provide at least one capability');
  const namespace = options.id.startsWith('storage/') ? 'storage' as const : 'provider' as const;
  const declaration = Object.freeze({
    id: options.id,
    version: options.version,
    contractVersion: 1 as const,
    provides: Object.freeze([...options.provides]),
    ...(options.requires?.length ? { requires: Object.freeze([...options.requires]) } : {}),
    ...(options.binding ? { binding: options.binding } : {}),
  });
  const lifecycle = createRhinoQModule({
    descriptor: { id: options.id, namespace, version: options.version, contractVersion: 1 },
    provision: options.provision,
    validate: options.validate,
    cleanup: options.cleanup,
  });
  return Object.freeze({ declaration, lifecycle });
}
