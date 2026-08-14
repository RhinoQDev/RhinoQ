/**
 * Small lifecycle contract shared by replaceable RhinoQ modules.
 *
 * A module can be loaded without starting a provider. Provisioning and
 * validation are explicit, and cleanup is idempotent. The contract is
 * intentionally narrower than a plugin framework: it carries no Task state,
 * lease, retry or effect semantics.
 */
export type RhinoQModuleNamespace = 'runtime' | 'processor' | 'provider' | 'storage' | 'surface';
export type RhinoQModuleState = 'loaded' | 'provisioned' | 'validated' | 'cleaned';

export interface RhinoQModuleDescriptor {
  readonly id: string;
  readonly namespace: RhinoQModuleNamespace;
  readonly version: number;
  readonly contractVersion: 1;
}

export interface RhinoQLifecycleModule {
  readonly descriptor: RhinoQModuleDescriptor;
  state(): RhinoQModuleState;
  provision(): Promise<void>;
  validate(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface CreateRhinoQModuleOptions {
  descriptor: RhinoQModuleDescriptor;
  provision?(): Promise<void> | void;
  validate?(): Promise<void> | void;
  cleanup?(): Promise<void> | void;
}

/** Create one explicit, idempotently cleaned module lifecycle. */
export function createRhinoQModule(options: CreateRhinoQModuleOptions): RhinoQLifecycleModule {
  validateDescriptor(options?.descriptor);
  let current: RhinoQModuleState = 'loaded';
  let cleanupPromise: Promise<void> | undefined;
  return Object.freeze({
    descriptor: Object.freeze({ ...options.descriptor }),
    state: () => current,
    async provision() {
      if (current === 'cleaned') throw new Error(`RhinoQ module ${options.descriptor.id} is already cleaned`);
      if (current !== 'loaded') return;
      await options.provision?.();
      current = 'provisioned';
    },
    async validate() {
      if (current === 'cleaned') throw new Error(`RhinoQ module ${options.descriptor.id} is already cleaned`);
      if (current === 'loaded') throw new Error(`RhinoQ module ${options.descriptor.id} must be provisioned before validation`);
      if (current === 'validated') return;
      await options.validate?.();
      current = 'validated';
    },
    async cleanup() {
      if (current === 'cleaned') return cleanupPromise;
      cleanupPromise ??= Promise.resolve()
        .then(() => options.cleanup?.())
        .then(() => { current = 'cleaned'; })
        .catch((error) => {
          cleanupPromise = undefined;
          throw error;
        });
      return cleanupPromise;
    },
  });
}

function validateDescriptor(descriptor: RhinoQModuleDescriptor | undefined): void {
  if (!descriptor || typeof descriptor !== 'object') throw new TypeError('RhinoQ module descriptor is required');
  if (!descriptor.id?.trim()) throw new TypeError('RhinoQ module descriptor id is required');
  if (!['runtime', 'processor', 'provider', 'storage', 'surface'].includes(descriptor.namespace)) {
    throw new TypeError('RhinoQ module descriptor namespace is invalid');
  }
  if (!Number.isSafeInteger(descriptor.version) || descriptor.version < 1) throw new RangeError('RhinoQ module descriptor version must be positive');
  if (descriptor.contractVersion !== 1) throw new TypeError('RhinoQ module contractVersion must be 1');
}
