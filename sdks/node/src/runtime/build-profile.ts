import type { RhinoQModuleNamespace } from './modules.js';

export interface RhinoQBuildProfileModule {
  readonly id: string;
  readonly namespace: RhinoQModuleNamespace;
  readonly version: string;
  readonly checksum?: string;
}

export interface RhinoQBuildProfile {
  readonly kind: 'rhinoq-build-profile';
  readonly schemaVersion: 1;
  readonly name: string;
  readonly selectedOnly: true;
  readonly modules: readonly RhinoQBuildProfileModule[];
  readonly fingerprint: string;
  readonly limitations: readonly string[];
}

/**
 * Compile a selected-module profile without installing or bundling anything.
 * A lock checksum is optional at this proposal stage and should be required by
 * release tooling before publishing an artifact.
 */
export function compileRhinoQBuildProfile(input: {
  name: string;
  modules: readonly RhinoQBuildProfileModule[];
}): RhinoQBuildProfile {
  const name = input?.name?.trim();
  if (!name) throw new TypeError('RhinoQ build profile name is required');
  if (!Array.isArray(input.modules)) throw new TypeError('RhinoQ build profile modules must be an array');
  const modules = Object.freeze([...input.modules].map(validateModule)
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (new Set(modules.map((module) => module.id)).size !== modules.length) throw new TypeError('RhinoQ build profile cannot select a module twice');
  const limitations = Object.freeze([
    ...(modules.some((module) => !module.checksum) ? ['profile is a proposal until every selected module has a checksum'] : []),
    'profile composition does not install dependencies or build a container',
    'provider readiness and security review remain release/adopter gates',
  ]);
  const unsigned = { kind: 'rhinoq-build-profile' as const, schemaVersion: 1 as const, name, selectedOnly: true as const, modules, limitations };
  return Object.freeze({ ...unsigned, fingerprint: fingerprint(unsigned) });
}

function validateModule(module: RhinoQBuildProfileModule): RhinoQBuildProfileModule {
  if (!module?.id?.trim() || !module.id.includes('/')) throw new TypeError('build profile module id must be namespaced, for example processor/ffmpeg');
  const namespace = module.id.split('/', 1)[0] ?? '';
  if (!['runtime', 'processor', 'provider', 'storage', 'surface'].includes(namespace)) throw new TypeError(`build profile module namespace is invalid: ${namespace}`);
  if (module.namespace !== namespace) throw new TypeError(`build profile module namespace does not match ${module.id}`);
  if (!module.version?.trim() || module.version.length > 128) throw new TypeError(`build profile module version is required: ${module.id}`);
  if (module.checksum !== undefined && !/^[a-z0-9]+:[a-f0-9]{16,128}$/i.test(module.checksum)) throw new TypeError(`build profile module checksum is invalid: ${module.id}`);
  return Object.freeze({ id: module.id.trim(), namespace: module.namespace, version: module.version.trim(), ...(module.checksum ? { checksum: module.checksum.trim() } : {}) });
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
