import { createHash } from 'node:crypto';

export interface RuntimeIdentityInput {
  runtime: string; scope: string; applicationKey: string;
  ownerId?: string; tenantId?: string; replicaId?: string;
}
export interface RuntimeIdentityOptions { requireOwner?: boolean; requireTenant?: boolean; requireReplica?: boolean }

/** Creates stable opaque IDs without guessing identity from payload data. */
export function deterministicRuntimeId(kind: 'task' | 'execution', applicationKey: string): string {
  const key = applicationKey?.trim();
  if (!key) throw identityError('applicationKey', 'runtime identity boundary', 'Pass a stable application key; never use a random value or array index.');
  return `${kind}_${createHash('sha256').update(`${kind}\0${key}`).digest('hex').slice(0, 32)}`;
}

/** Fails at startup before an adapter observes or mutates runtime state. */
export function validateRuntimeIdentity(input: RuntimeIdentityInput, options: RuntimeIdentityOptions = {}): RuntimeIdentityInput {
  for (const field of ['runtime', 'scope', 'applicationKey'] as const) {
    if (!input?.[field]?.trim()) throw identityError(field, 'runtime adapter startup', `Configure a stable ${field}.`);
  }
  if (options.requireOwner && !input.ownerId?.trim()) throw identityError('ownerId', 'owner resolver', 'Return an authenticated owner ID; do not derive it from request parameters.');
  if (options.requireTenant && !input.tenantId?.trim()) throw identityError('tenantId', 'tenant authorization boundary', 'Return an authorized tenant ID for every request.');
  if (options.requireReplica && !input.replicaId?.trim()) throw identityError('replicaId', 'durable adoption aggregation', 'Set a stable deployment replica ID.');
  return { ...input };
}

function identityError(field: string, boundary: string, nextAction: string): TypeError {
  const error = new TypeError(`missing identity ${field} at ${boundary}; ${nextAction}`);
  Object.assign(error, { code: 'RHINOQ_IDENTITY_REQUIRED', field, boundary, nextAction, docs: 'docs/adopter-responsibilities.md' });
  return error;
}
