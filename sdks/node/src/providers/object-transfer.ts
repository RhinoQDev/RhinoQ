import type {
  ProviderConfirmation,
  ProviderOperationOptions,
  ProviderOperationRecord,
} from '../gateway/types.js';

/**
 * The identity of an object at the destination, as a readback reports it.
 *
 * At least one of `etag`, `size` or `versionId` has to be comparable, or the
 * readback can only say "something is there" — which is not the same as "my
 * transfer put it there".
 */
export interface TransferredObject {
  /** Destination key or path. */
  key: string;
  /** Content hash the destination reports. The strongest identity available. */
  etag?: string;
  /** Byte length. Weaker than an etag, but two truncated uploads differ here. */
  size?: number;
  /** Immutable version, on a versioned bucket. Strongest of all: it is unique. */
  versionId?: string;
}

export interface ObjectTransferReferenceAdapter {
  /**
   * Performs the transfer — download from the source, write to the
   * destination. It must be safe to repeat for one idempotency key: use it as
   * the upload ID, or write to a deterministic key.
   */
  transfer(idempotencyKey: string): Promise<TransferredObject>;
  /**
   * Reads the destination back. Return undefined when nothing is at the key.
   * This is a HEAD, not a GET: the point is identity, not content.
   */
  head(operation: ProviderOperationRecord): Promise<TransferredObject | undefined>;
  /**
   * The identity the transfer is supposed to produce, known before it runs —
   * the source object's etag or Content-Length.
   *
   * Without it a readback cannot tell the operation's own object from one that
   * was already at that key, so the confirmation is `unknown` rather than
   * `confirmed`. Supply it whenever the source can be interrogated.
   */
  expected?(operation: ProviderOperationRecord): Promise<Partial<TransferredObject> | undefined>;
}

/**
 * Reference adapter for "fetch from a CDN, put it in object storage" and every
 * other transfer whose outcome is an object rather than a status field.
 *
 * Stripe and provisioning both answer "did it happen?" by reading a state the
 * provider maintains. A transfer has no such field. The only evidence is the
 * destination itself, and reading it back is where the interesting mistakes
 * live:
 *
 * - Nothing at the key is `not_happened`. A retry is safe: there is no object
 *   to overwrite and no partial charge to repeat.
 * - An object whose identity matches what the transfer was supposed to produce
 *   is `confirmed`.
 * - An object whose identity does **not** match is `failed`, never a retry.
 *   Retrying would overwrite whatever is actually there, and on an unversioned
 *   bucket that is not recoverable.
 * - An object with no comparable identity is `unknown`. "Something exists at
 *   this key" is not proof that this operation put it there, and treating it
 *   as confirmation is how a failed transfer is recorded as a success because
 *   last week's file happens to sit at the same path.
 *
 * The egress and request cost of a repeated transfer is real, which is why
 * `unknown` stays unknown here instead of being optimistically retried.
 */
export function objectTransferProviderAdapter(
  adapter: ObjectTransferReferenceAdapter,
): Pick<ProviderOperationOptions<TransferredObject>, 'execute' | 'confirm' | 'providerId' | 'evidence'> {
  return {
    execute: (key) => adapter.transfer(key),
    providerId: (result) => result.versionId ?? result.key,
    evidence: describeObject,
    confirm: async (operation): Promise<ProviderConfirmation> => {
      const observed = await adapter.head(operation);
      if (!observed) {
        return {
          decision: 'not_happened',
          reason: 'the destination key is empty, so nothing was transferred',
        };
      }
      const evidence = describeObject(observed);
      const expected = await adapter.expected?.(operation);
      const comparison = compareIdentity(expected, observed);
      switch (comparison.verdict) {
        case 'match':
          return { decision: 'confirmed', evidence };
        case 'mismatch':
          return {
            decision: 'failed',
            reason:
              `the destination holds a different object (${comparison.detail}). ` +
              'Retrying would overwrite it, which an unversioned bucket cannot undo.',
          };
        default:
          return {
            decision: 'unknown',
            evidence,
            reason:
              'an object exists at the destination but nothing identifies it as this transfer. ' +
              'Supply expected() with the source etag, size or versionId to make this conclusive.',
          };
      }
    },
  };
}

type IdentityComparison =
  | { verdict: 'match' }
  | { verdict: 'mismatch'; detail: string }
  | { verdict: 'indeterminate' };

/**
 * Compares in strength order. A versionId is unique, an etag is a content
 * hash, a size only catches truncation — but a size that differs is still a
 * different object, and saying so beats saying nothing.
 */
function compareIdentity(
  expected: Partial<TransferredObject> | undefined,
  observed: TransferredObject,
): IdentityComparison {
  if (!expected) {
    return { verdict: 'indeterminate' };
  }
  if (expected.versionId !== undefined && observed.versionId !== undefined) {
    return expected.versionId === observed.versionId
      ? { verdict: 'match' }
      : { verdict: 'mismatch', detail: `versionId ${observed.versionId} ≠ ${expected.versionId}` };
  }
  if (expected.etag !== undefined && observed.etag !== undefined) {
    return normalizeETag(expected.etag) === normalizeETag(observed.etag)
      ? { verdict: 'match' }
      : { verdict: 'mismatch', detail: `etag ${observed.etag} ≠ ${expected.etag}` };
  }
  if (expected.size !== undefined && observed.size !== undefined) {
    return expected.size === observed.size
      ? { verdict: 'match' }
      : { verdict: 'mismatch', detail: `size ${observed.size} ≠ ${expected.size}` };
  }
  return { verdict: 'indeterminate' };
}

// S3 quotes etags and appends a part count for multipart uploads. Comparing
// raw strings would report every multipart upload as a mismatch.
function normalizeETag(value: string): string {
  return value.trim().replace(/^"|"$/g, '').toLowerCase();
}

function describeObject(result: TransferredObject): string {
  const parts = [result.key];
  if (result.versionId !== undefined) parts.push(`v=${result.versionId}`);
  if (result.etag !== undefined) parts.push(`etag=${normalizeETag(result.etag)}`);
  if (result.size !== undefined) parts.push(`size=${result.size}`);
  return parts.join(' ');
}
