import type { PoolConfig } from 'pg';

import { assertTenantId } from '../postgres/tenant.js';

export { assertTenantId, isValidTenantId } from '../postgres/tenant.js';

/**
 * Where the CLI found its PostgreSQL connection, and how to describe it in
 * output without printing the password.
 */
export interface ResolvedDatabaseConfig {
  pool: PoolConfig;
  /** The environment variable(s) the connection came from. */
  source: string;
  /** Password-free rendering, safe to log. */
  target: string;
}

export type Environment = Record<string, string | undefined>;

const URL_VARIABLES = ['RHINOQ_DATABASE_URL', 'DATABASE_URL'] as const;

// Discrete variables come in two families. RhinoQ's own names win so a project
// that already points libpq at a different database can keep both, and the
// libpq names are accepted because that is what managed PostgreSQL providers,
// docker-compose files and Kubernetes secrets emit.
const DISCRETE_FIELDS = {
  host: ['RHINOQ_DB_HOST', 'PGHOST'],
  port: ['RHINOQ_DB_PORT', 'PGPORT'],
  user: ['RHINOQ_DB_USER', 'PGUSER'],
  password: ['RHINOQ_DB_PASSWORD', 'PGPASSWORD'],
  database: ['RHINOQ_DB_NAME', 'PGDATABASE'],
  sslmode: ['RHINOQ_DB_SSLMODE', 'PGSSLMODE'],
} as const;

/** Every variable this resolver reads, for help text and error messages. */
export const DATABASE_ENVIRONMENT_VARIABLES: readonly string[] = [
  ...URL_VARIABLES,
  ...Object.values(DISCRETE_FIELDS).flat(),
];

/**
 * Resolves the PostgreSQL connection from the environment.
 *
 * A connection URL is still the shortest path, but plenty of applications never
 * have one: managed providers, Helm charts and docker-compose hand out host,
 * port, user, password and database as separate variables. Requiring the URL
 * made `npx rhinoq doctor` fail at its first step for those projects, which is
 * the one command that is supposed to explain what is wrong.
 *
 * Returns undefined when nothing is configured, so callers keep control of the
 * failure message and its NEXT action.
 */
export function resolveDatabaseConfig(env: Environment): ResolvedDatabaseConfig | undefined {
  for (const name of URL_VARIABLES) {
    const value = env[name]?.trim();
    if (value) {
      return {
        pool: { connectionString: value },
        source: name,
        target: describeURL(value),
      };
    }
  }
  return resolveDiscrete(env);
}

function resolveDiscrete(env: Environment): ResolvedDatabaseConfig | undefined {
  const found = new Map<keyof typeof DISCRETE_FIELDS, { name: string; value: string }>();
  for (const [field, names] of Object.entries(DISCRETE_FIELDS)) {
    for (const name of names) {
      const value = env[name]?.trim();
      if (value) {
        found.set(field as keyof typeof DISCRETE_FIELDS, { name, value });
        break;
      }
    }
  }
  // Partial discrete configuration is worse than none: connecting to a default
  // host that happens to answer is how a migration lands in the wrong database.
  // Host and database are required; the rest may legitimately come from libpq
  // defaults or a password file.
  if (!found.has('host') || !found.has('database')) {
    return undefined;
  }

  const host = found.get('host')!.value;
  const database = found.get('database')!.value;
  const rawPort = found.get('port')?.value;
  const port = rawPort === undefined ? 5432 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${found.get('port')!.name} must be a port from 1 to 65535, not ${JSON.stringify(rawPort)}`);
  }
  const user = found.get('user')?.value;
  const password = found.get('password')?.value;
  const sslmode = found.get('sslmode')?.value;

  return {
    pool: {
      host,
      port,
      database,
      ...(user === undefined ? {} : { user }),
      ...(password === undefined ? {} : { password }),
      ...sslOption(sslmode, found.get('sslmode')?.name),
    },
    source: [...found.values()].map((entry) => entry.name).join(', '),
    target: `${host}:${port}/${database}${user ? ` as ${user}` : ''}`,
  };
}

/**
 * Adds a PostgreSQL startup option without losing options already embedded in a
 * connection URL. node-postgres ignores the separate `options` field when the
 * URL already carries its own startup options, so merge into the URL itself.
 */
export function withPostgresOption(pool: PoolConfig, option: string): PoolConfig {
  const normalized = option.trim();
  if (!normalized) return pool;
  // The startup option list is space separated, so a tenant carrying whitespace
  // does not fail here — it appends a second option to the connection. The URL
  // branch below percent-encodes and would survive it; the branch above does
  // not, and neither branch should depend on which one a caller happens to hit.
  const tenant = /^-c\s*rhinoq\.tenant_id=(.*)$/s.exec(normalized);
  if (tenant) {
    assertTenantId(tenant[1]);
  }
  const poolOptions = pool.options?.trim();
  if (typeof pool.connectionString !== 'string' || !pool.connectionString.trim()) {
    return {
      ...pool,
      ...(poolOptions ? { options: `${poolOptions} ${normalized}` } : { options: normalized }),
    };
  }
  try {
    const url = new URL(pool.connectionString);
    const urlOptions = url.searchParams.get('options')?.trim();
    url.searchParams.set('options', [urlOptions, poolOptions, normalized].filter(Boolean).join(' '));
    const { options: _ignored, ...rest } = pool;
    return { ...rest, connectionString: url.toString() };
  } catch {
    return {
      ...pool,
      options: [poolOptions, normalized].filter(Boolean).join(' '),
    };
  }
}
// pg takes a boolean or a TLS options object rather than libpq's sslmode
// string, so an unmapped value would silently mean "no TLS". Refuse instead:
// a downgraded connection to a managed database is not something to guess at.
function sslOption(mode: string | undefined, name: string | undefined): { ssl?: boolean | { rejectUnauthorized: boolean } } {
  if (mode === undefined) return {};
  switch (mode.toLowerCase()) {
    case 'disable':
      return { ssl: false };
    case 'allow':
    case 'prefer':
    case 'require':
      return { ssl: { rejectUnauthorized: false } };
    case 'verify-ca':
    case 'verify-full':
      return { ssl: { rejectUnauthorized: true } };
    default:
      throw new Error(
        `${name ?? 'sslmode'} must be one of disable, allow, prefer, require, verify-ca, verify-full; got ${JSON.stringify(mode)}`,
      );
  }
}

// A connection URL usually carries the password inline, so it is never echoed
// whole. An unparsable value is reported as such rather than passed through.
function describeURL(value: string): string {
  try {
    const url = new URL(value);
    const port = url.port || '5432';
    const database = url.pathname.replace(/^\//, '') || '(default)';
    return `${url.hostname}:${port}/${database}${url.username ? ` as ${decodeURIComponent(url.username)}` : ''}`;
  } catch {
    return '(unparsable connection string)';
  }
}
