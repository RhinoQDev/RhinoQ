import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * The notification registry is a small local JSON file, not a database table.
 *
 * That is what makes this reachable from Node at all: the Go engine's Rule and
 * delivery tables are private to the engine, and an SDK reading them directly
 * would be exactly the coupling RhinoQ forbids. A file both CLIs read is a
 * shared contract instead of a shared secret.
 *
 * No secret is ever written to it. An entry records the *name of an
 * environment variable*, and the value is read at send time, so a leaked
 * registry is a list of URLs rather than a set of working credentials.
 */
export const NOTIFY_REGISTRY_VERSION = 1;

export type NotifyKind = 'webhook' | 'slack';
export type NotifySeverity = 'info' | 'medium' | 'high' | 'critical';

export interface NotifyDestinationEntry {
  name: string;
  kind: NotifyKind;
  /** The endpoint. Empty when `urlEnv` is used instead. */
  url?: string;
  /** Names an environment variable holding the endpoint. */
  urlEnv?: string;
  /** Names the environment variable holding the HMAC secret. */
  secretEnv?: string;
  timeoutMs?: number;
  includeEvidence?: boolean;
  gracePeriodMs?: number;
  findingBaseUrl?: string;
  /** Route only messages at or above this severity. Defaults to info. */
  minimumSeverity?: NotifySeverity;
  /** Optional exact Rule IDs. Empty means every Rule. */
  ruleIds?: string[];
  /** Optional exact subject types. Empty means every subject type. */
  subjectTypes?: string[];
  createdAt?: string;
}

export interface NotifyRegistry {
  schemaVersion: number;
  destinations: NotifyDestinationEntry[];
}

export interface NotifyRouteInput {
  severity: NotifySeverity;
  ruleId: string;
  subjectType: string;
}

/** A destination with its environment values resolved, ready to send. */
export interface ResolvedNotifyDestination {
  name: string;
  kind: NotifyKind;
  url: string;
  secret: string;
  timeoutMs: number;
  includeEvidence: boolean;
  gracePeriodMs: number;
  findingBaseUrl: string;
}

export function notifyRegistryPath(env: Record<string, string | undefined> = process.env): string {
  const custom = env.RHINOQ_NOTIFY_CONFIG?.trim();
  return custom ? resolve(custom) : resolve('.rhinoq', 'notifications.json');
}

/**
 * Reads the registry. A missing file is an empty registry, not an error: it is
 * what every project looks like before the first `notify add`.
 *
 * A schema version this SDK does not write is refused rather than
 * best-effort parsed. Two CLIs sharing a file must not disagree about what a
 * field means.
 */
export async function loadNotifyRegistry(path: string): Promise<NotifyRegistry> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: NOTIFY_REGISTRY_VERSION, destinations: [] };
    }
    throw error;
  }
  let parsed: NotifyRegistry;
  try {
    parsed = JSON.parse(raw) as NotifyRegistry;
  } catch (error) {
    throw new Error(`${path} is not valid RhinoQ notify JSON: ${(error as Error).message}`);
  }
  if (parsed?.schemaVersion !== NOTIFY_REGISTRY_VERSION) {
    throw new Error(
      `${path} uses schema version ${String(parsed?.schemaVersion)}; this SDK writes version ${NOTIFY_REGISTRY_VERSION}`,
    );
  }
  for (const entry of parsed.destinations ?? []) {
    if (entry.minimumSeverity && !['info', 'medium', 'high', 'critical'].includes(entry.minimumSeverity)) {
      throw new Error(`${path} destination ${JSON.stringify(entry.name)} has invalid minimumSeverity ${JSON.stringify(entry.minimumSeverity)}`);
    }
  }
  return { schemaVersion: parsed.schemaVersion, destinations: parsed.destinations ?? [] };
}

export async function saveNotifyRegistry(path: string, registry: NotifyRegistry): Promise<void> {
  const ordered = [...registry.destinations].sort((left, right) => left.name.localeCompare(right.name));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...registry, destinations: ordered }, null, 2)}\n`, 'utf8');
}

/**
 * Resolves one destination's environment values.
 *
 * A configured-but-empty secret variable is a failure, not a fallback to
 * unsigned: silently weakening a destination somebody chose to sign is worse
 * than refusing to send.
 */
export function resolveNotifyDestination(
  registry: NotifyRegistry,
  name: string,
  env: Record<string, string | undefined> = process.env,
): ResolvedNotifyDestination {
  const entry = registry.destinations.find((item) => item.name === name);
  if (!entry) {
    throw new Error(`no destination named ${JSON.stringify(name)}`);
  }
  let url = entry.url ?? '';
  if (entry.urlEnv) {
    url = env[entry.urlEnv]?.trim() ?? '';
    if (!url) {
      throw new Error(`${entry.urlEnv} is empty, so destination ${JSON.stringify(name)} has no URL`);
    }
  }
  let secret = '';
  if (entry.secretEnv) {
    secret = env[entry.secretEnv] ?? '';
    if (!secret) {
      throw new Error(
        `${entry.secretEnv} is empty, so destination ${JSON.stringify(name)} cannot be signed. ` +
          'Sending unsigned would silently weaken a destination that was configured to be signed.',
      );
    }
  }
  return {
    name: entry.name,
    kind: entry.kind,
    url,
    secret,
    timeoutMs: entry.timeoutMs && entry.timeoutMs > 0 ? entry.timeoutMs : 10_000,
    includeEvidence: entry.includeEvidence === true,
    gracePeriodMs: entry.gracePeriodMs ?? 0,
    findingBaseUrl: entry.findingBaseUrl ?? '',
  };
}

/** Default environment variable name for a destination's HMAC secret. */
export function defaultSecretEnv(name: string): string {
  return `RHINOQ_NOTIFY_SECRET_${name.replace(/[-. ]/g, '_').toUpperCase()}`;
}

/** Pure routing only; the Go-owned delivery ledger remains the sender/dedup authority. */
export function routeNotifyDestinations(registry: NotifyRegistry, input: NotifyRouteInput): readonly NotifyDestinationEntry[] {
  if (!registry || registry.schemaVersion !== NOTIFY_REGISTRY_VERSION) throw new TypeError('a current RhinoQ notification registry is required');
  if (!['info', 'medium', 'high', 'critical'].includes(input?.severity)) throw new TypeError('notification severity must be info, medium, high or critical');
  if (!input.ruleId?.trim() || !input.subjectType?.trim()) throw new TypeError('notification route requires ruleId and subjectType');
  const rank: Record<NotifySeverity, number> = { info: 0, medium: 1, high: 2, critical: 3 };
  return Object.freeze(registry.destinations.filter((entry) => {
    const minimum = entry.minimumSeverity ?? 'info';
    if (rank[input.severity] < rank[minimum]) return false;
    if (entry.ruleIds?.length && !entry.ruleIds.includes(input.ruleId)) return false;
    if (entry.subjectTypes?.length && !entry.subjectTypes.includes(input.subjectType)) return false;
    return true;
  }).sort((left, right) => left.name.localeCompare(right.name)));
}
