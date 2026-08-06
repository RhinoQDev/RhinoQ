import type { SqlExecutor } from '../postgres/producer.js';

/**
 * Did the work actually happen, out where the queue cannot see?
 *
 * A Rule is SQL, and it runs in a `READ ONLY` transaction under a role that is
 * required not to have network or filesystem functions. That is the right
 * design for something scheduled against production, and it means no Rule can
 * ever HEAD an object in a bucket or read a provider back. RhinoQ stores and
 * classifies evidence; something has to go and get it.
 *
 * Every adopter wrote that loop, and it is the same loop: ask, get one of three
 * answers, write the answer down where a Rule can read it. These verifiers are
 * that loop. They do not talk to RhinoQ and hold no state — a verifier is a
 * function from a subject to a `VerificationOutcome`, so it is testable on its
 * own and composes with whatever schedules it.
 *
 * The three answers matter more than the two:
 *
 * - `present`  — we looked, and it is there.
 * - `missing`  — we looked, and it is not. This is drift.
 * - `unknown`  — we could not look. A timeout, a 403, a DNS failure.
 *
 * Collapsing `unknown` into `missing` opens a Finding every time the network
 * hiccups; collapsing it into `present` is worse, because drift then disappears
 * whenever the check itself fails. Keep all three, and let the Rule decide how
 * long an `unknown` may persist before it becomes a Finding.
 */
export type VerificationStatus = 'present' | 'missing' | 'unknown';

export type UnknownReason =
  | 'provider_timeout'
  | 'permission_denied'
  | 'evidence_missing'
  | 'awaiting_confirmation'
  | 'transport_error';

export interface VerificationOutcome {
  status: VerificationStatus;
  /** Set only when `status` is `unknown`. Why we could not look. */
  unknownReason?: UnknownReason;
  /** Short, human-readable, safe to store. Never a credential or a payload. */
  detail?: string;
  /** What was checked, for the evidence row. */
  subject: string;
  checkedAt: string;
}

export type Verifier<Subject> = (subject: Subject) => Promise<VerificationOutcome>;

export interface ObjectExistsSubject {
  bucket: string;
  key: string;
}

export interface ObjectExistsOptions {
  /**
   * Performs the provider's existence check for one object. Supply the S3,
   * MinIO or GCS client the application already has; RhinoQ does not bundle a
   * cloud SDK and will not pick one for you.
   *
   * Return `true` when the object is there, `false` when the provider said it
   * is not, and throw for anything else — a throw becomes `unknown`, which is
   * the point.
   *
   * ```ts
   * head: async ({ bucket, key }) => {
   *   try {
   *     await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
   *     return true;
   *   } catch (error) {
   *     if (error.$metadata?.httpStatusCode === 404) return false;
   *     throw error;
   *   }
   * }
   * ```
   */
  head: (subject: ObjectExistsSubject) => Promise<boolean>;
  timeoutMs?: number;
}

/**
 * "The queue said this upload completed. Is the object in the bucket?"
 *
 * The single most common shape of a job that succeeded technically and failed
 * in the real world, and the one thing a SQL Rule structurally cannot check.
 */
export function objectExists(
  options: ObjectExistsOptions,
): Verifier<ObjectExistsSubject> {
  if (typeof options?.head !== 'function') {
    throw new TypeError('objectExists requires head(): the application owns its storage client');
  }
  return async (subject) => {
    const name = `${subject.bucket}/${subject.key}`;
    try {
      const present = await withTimeout(options.head(subject), options.timeoutMs);
      return outcome(name, present ? 'present' : 'missing');
    } catch (error) {
      return unknownOutcome(name, error);
    }
  };
}

export interface HttpReadBackSubject {
  url: string;
  headers?: Record<string, string>;
}

export interface HttpReadBackOptions {
  /**
   * Decides whether the provider's own view agrees that the work happened.
   *
   * Anything other than a clean yes or no should throw, so it lands in
   * `unknown` rather than being voted on by a 502.
   */
  expect: (response: Response) => Promise<boolean> | boolean;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * "We told the provider to do it and got a 200. Does the provider agree?"
 *
 * A response that timed out on the way back is the classic case: the charge
 * exists, the caller never saw it, and every local record says the call failed.
 * Reading it back from the provider is the only source of truth, and a 5xx on
 * the read-back is `unknown` — not a verdict.
 */
export function httpReadBack(
  options: HttpReadBackOptions,
): Verifier<HttpReadBackSubject> {
  if (typeof options?.expect !== 'function') {
    throw new TypeError('httpReadBack requires expect(response)');
  }
  const doFetch = options.fetch ?? globalThis.fetch;
  return async (subject) => {
    try {
      const response = await withTimeout(
        doFetch(subject.url, { headers: subject.headers ?? {} }),
        options.timeoutMs,
      );
      if (response.status === 401 || response.status === 403) {
        return outcome(subject.url, 'unknown', 'permission_denied', `HTTP ${response.status}`);
      }
      if (response.status >= 500) {
        return outcome(subject.url, 'unknown', 'provider_timeout', `HTTP ${response.status}`);
      }
      if (response.status === 404) {
        return outcome(subject.url, 'missing', undefined, 'HTTP 404');
      }
      return outcome(subject.url, (await options.expect(response)) ? 'present' : 'missing');
    } catch (error) {
      return unknownOutcome(subject.url, error);
    }
  };
}

export interface RowMatchesSubject {
  id: string | number;
}

export interface RowMatchesOptions {
  query: SqlExecutor;
  /**
   * A parameterised predicate over the application's own tables, taking the
   * subject id as `$1`.
   *
   * ```ts
   * rowMatches({ query, sql: 'SELECT 1 FROM invoices WHERE id = $1 AND paid_at IS NOT NULL' })
   * ```
   *
   * This one *is* expressible as a Rule. It is here because a verification pass
   * usually needs to check several things at once, and mixing "ask the bucket"
   * with "ask my own table" in one pass beats splitting the evidence across two
   * mechanisms that run on different schedules.
   */
  sql: string;
  timeoutMs?: number;
}

/** "The provider says it happened. Does our own state say the same?" */
export function rowMatches(options: RowMatchesOptions): Verifier<RowMatchesSubject> {
  if (typeof options?.query?.query !== 'function') {
    throw new TypeError('rowMatches requires a PostgreSQL executor');
  }
  if (!options.sql?.trim()) {
    throw new TypeError('rowMatches requires sql with the subject id as $1');
  }
  return async (subject) => {
    const name = String(subject.id);
    try {
      const result = await withTimeout(
        options.query.query<unknown>(options.sql, [subject.id]),
        options.timeoutMs,
      );
      return outcome(name, result.rows.length > 0 ? 'present' : 'missing');
    } catch (error) {
      return unknownOutcome(name, error);
    }
  };
}

/**
 * Where a verifier's answers go so a Rule can read them.
 *
 * The verifier runs in the application, in an ordinary process, with the
 * network. The Rule runs in PostgreSQL with neither. This table is the seam:
 * one row per subject, overwritten on every check, carrying all three states
 * and the time each was last seen. A Rule over it is trivial to write and cheap
 * to plan — `missing_at IS NOT NULL AND missing_at > present_at` is drift.
 */
export const VERIFICATION_TABLE_SQL = String.raw`
CREATE TABLE IF NOT EXISTS rhinoq_verifications (
  verifier text NOT NULL,
  subject text NOT NULL,
  status text NOT NULL CHECK (status IN ('present', 'missing', 'unknown')),
  unknown_reason text,
  detail text,
  present_at timestamptz,
  missing_at timestamptz,
  unknown_at timestamptz,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (verifier, subject)
);

CREATE INDEX IF NOT EXISTS rhinoq_verifications_drift_idx
  ON rhinoq_verifications (verifier, missing_at)
  WHERE status = 'missing';
`;

/**
 * Writes one outcome down. Idempotent per (verifier, subject).
 *
 * The three timestamps are kept separately on purpose: "missing now, present an
 * hour ago" is a different incident from "never seen", and an `unknown` must
 * not overwrite the last real answer.
 */
export async function recordVerification(
  executor: SqlExecutor,
  verifier: string,
  result: VerificationOutcome,
): Promise<void> {
  if (!verifier?.trim()) {
    throw new TypeError('a verifier name is required');
  }
  await executor.query(
    `INSERT INTO rhinoq_verifications (
       verifier, subject, status, unknown_reason, detail,
       present_at, missing_at, unknown_at, checked_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       CASE WHEN $3 = 'present' THEN $6::timestamptz END,
       CASE WHEN $3 = 'missing' THEN $6::timestamptz END,
       CASE WHEN $3 = 'unknown' THEN $6::timestamptz END,
       $6::timestamptz
     )
     ON CONFLICT (verifier, subject) DO UPDATE SET
       status = EXCLUDED.status,
       unknown_reason = EXCLUDED.unknown_reason,
       detail = EXCLUDED.detail,
       present_at = COALESCE(EXCLUDED.present_at, rhinoq_verifications.present_at),
       missing_at = COALESCE(EXCLUDED.missing_at, rhinoq_verifications.missing_at),
       unknown_at = COALESCE(EXCLUDED.unknown_at, rhinoq_verifications.unknown_at),
       checked_at = EXCLUDED.checked_at`,
    [
      verifier,
      result.subject,
      result.status,
      result.unknownReason ?? null,
      result.detail ?? null,
      result.checkedAt,
    ],
  );
}

/** The three verifiers, grouped for discovery: `verifiers.objectExists(...)`. */
export const verifiers = { objectExists, httpReadBack, rowMatches } as const;

function outcome(
  subject: string,
  status: VerificationStatus,
  unknownReason?: UnknownReason,
  detail?: string,
): VerificationOutcome {
  return {
    subject,
    status,
    ...(unknownReason ? { unknownReason } : {}),
    ...(detail ? { detail } : {}),
    checkedAt: new Date().toISOString(),
  };
}

// Everything that is not a clean answer is `unknown`, with the closest reason
// available. Guessing here is what turns a DNS blip into a false Finding.
function unknownOutcome(subject: string, error: unknown): VerificationOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  const reason: UnknownReason =
    name === 'TimeoutError' || /timeout|abort/i.test(message) ? 'provider_timeout' :
    /denied|forbidden|unauthor|credential/i.test(message) ? 'permission_denied' :
    'transport_error';
  return outcome(subject, 'unknown', reason, message.slice(0, 200));
}

function withTimeout<T>(work: Promise<T>, timeoutMs = 10_000): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive number');
  }
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`verification timed out after ${timeoutMs}ms`);
        error.name = 'TimeoutError';
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    }),
  ]);
}
