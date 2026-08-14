export type RhinoQOperationalSetting = string | number | boolean | null;

export interface RhinoQOperationalConfig {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly fingerprint: string;
  readonly settings: Readonly<Record<string, RhinoQOperationalSetting>>;
}

export interface RhinoQOperationalApproval {
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export interface RhinoQOperationalConfigTransaction {
  readonly schemaVersion: 1;
  readonly baseRevision: number;
  readonly next: RhinoQOperationalConfig;
  readonly previous: RhinoQOperationalConfig;
}

export interface RhinoQAtomicOperationalConfigStore {
  current(): RhinoQOperationalConfig;
  stage(settings: Readonly<Record<string, RhinoQOperationalSetting>>, expectedRevision?: number): RhinoQOperationalConfigTransaction;
  commit(transaction: RhinoQOperationalConfigTransaction, approval: RhinoQOperationalApproval): RhinoQOperationalConfig;
  rollback(transaction: RhinoQOperationalConfigTransaction, approval: RhinoQOperationalApproval): RhinoQOperationalConfig;
}

/**
 * Bounded local transaction helper for application-owned operational settings.
 * It provides version fencing and approval, not distributed persistence or a
 * Control Plane. Connect the commit/rollback callbacks to the application's
 * own durable config system when a process boundary exists.
 */
export function createRhinoQAtomicOperationalConfigStore(
  initial: Readonly<Record<string, RhinoQOperationalSetting>> = {},
): RhinoQAtomicOperationalConfigStore {
  let current = makeConfig(1, initial);
  return Object.freeze({
    current: () => current,
    stage(settings: Readonly<Record<string, RhinoQOperationalSetting>>, expectedRevision = current.revision) {
      if (expectedRevision !== current.revision) throw new Error(`operational config revision conflict: expected ${expectedRevision}, current ${current.revision}`);
      return Object.freeze({
        schemaVersion: 1 as const,
        baseRevision: current.revision,
        previous: current,
        next: makeConfig(current.revision + 1, settings),
      });
    },
    commit(transaction: RhinoQOperationalConfigTransaction, approval: RhinoQOperationalApproval) {
      validateCommitTransaction(transaction, current);
      validateApproval(approval);
      current = transaction.next;
      return current;
    },
    rollback(transaction: RhinoQOperationalConfigTransaction, approval: RhinoQOperationalApproval) {
      validateRollbackTransaction(transaction, current);
      validateApproval(approval);
      current = makeConfig(current.revision + 1, transaction.previous.settings);
      return current;
    },
  });
}

function makeConfig(revision: number, settings: Readonly<Record<string, RhinoQOperationalSetting>>): RhinoQOperationalConfig {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new RangeError('operational config revision must be positive');
  const normalized: Record<string, RhinoQOperationalSetting> = {};
  for (const key of Object.keys(settings ?? {}).sort()) {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(key)) throw new TypeError(`operational config key is invalid: ${key}`);
    const value = settings[key]!;
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new TypeError(`operational config value must be a primitive: ${key}`);
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`operational config number must be finite: ${key}`);
    normalized[key] = value;
  }
  const frozenSettings = Object.freeze(normalized);
  return Object.freeze({ schemaVersion: 1, revision, fingerprint: fingerprint(frozenSettings), settings: frozenSettings });
}

function validateCommitTransaction(transaction: RhinoQOperationalConfigTransaction, current: RhinoQOperationalConfig): void {
  if (!transaction || transaction.schemaVersion !== 1 || transaction.baseRevision !== current.revision || transaction.previous.fingerprint !== current.fingerprint) {
    throw new Error(`operational config transaction is stale at revision ${current.revision}`);
  }
  if (transaction.next.revision !== current.revision + 1) throw new Error('operational config transaction revision is invalid');
}

function validateRollbackTransaction(transaction: RhinoQOperationalConfigTransaction, current: RhinoQOperationalConfig): void {
  if (!transaction || transaction.schemaVersion !== 1 || transaction.next.revision !== current.revision || transaction.next.fingerprint !== current.fingerprint) {
    throw new Error(`operational config transaction is stale at revision ${current.revision}`);
  }
}

function validateApproval(approval: RhinoQOperationalApproval): void {
  if (!approval?.approvalId?.trim() || !approval.approvedBy?.trim() || !Number.isFinite(Date.parse(approval.approvedAt))) {
    throw new TypeError('operational config approval requires approvalId, approvedBy and an ISO timestamp');
  }
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
