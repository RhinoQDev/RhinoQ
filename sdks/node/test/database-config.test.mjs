import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { resolveDatabaseConfig, withPostgresOption } from '../dist/cli/database-config.js';

const developerCLI = fileURLToPath(new URL('../dist/cli/rhinoq.js', import.meta.url));

test('a connection URL still wins, and is never echoed with its password', () => {
  const resolved = resolveDatabaseConfig({
    DATABASE_URL: 'postgres://app:s3cret@db.internal:6432/reports',
    PGHOST: 'ignored.example',
    PGDATABASE: 'ignored',
  });

  assert.equal(resolved.pool.connectionString, 'postgres://app:s3cret@db.internal:6432/reports');
  assert.equal(resolved.source, 'DATABASE_URL');
  assert.equal(resolved.target, 'db.internal:6432/reports as app');
  assert.doesNotMatch(resolved.target, /s3cret/);
});


test('withPostgresOption merges into a URL that already has startup options', () => {
  const resolved = withPostgresOption(
    { connectionString: 'postgres://app:secret@db.internal:5432/reports?options=-c%20rhinoq.tenant_id%3Dtnt_system' },
    '-c rhinoq.maintenance=on',
  );
  const url = new URL(resolved.connectionString);
  assert.equal(url.searchParams.get('options'), '-c rhinoq.tenant_id=tnt_system -c rhinoq.maintenance=on');
  assert.equal(resolved.options, undefined);
});

test('withPostgresOption adds startup options to discrete pool configuration', () => {
  const resolved = withPostgresOption({ host: 'db.internal', database: 'reports', options: '-c statement_timeout=5000' }, '-c rhinoq.tenant_id=tnt_acme');
  assert.equal(resolved.options, '-c statement_timeout=5000 -c rhinoq.tenant_id=tnt_acme');
});
test('RHINOQ_DATABASE_URL takes precedence over DATABASE_URL', () => {
  const resolved = resolveDatabaseConfig({
    RHINOQ_DATABASE_URL: 'postgres://rhinoq@127.0.0.1:5432/rhinoq',
    DATABASE_URL: 'postgres://app@127.0.0.1:5432/app',
  });

  assert.equal(resolved.source, 'RHINOQ_DATABASE_URL');
  assert.match(resolved.pool.connectionString, /\/rhinoq$/);
});

// Managed providers, Helm charts and docker-compose hand out discrete
// variables. Requiring a URL made doctor fail at its first step for exactly the
// projects that most needed it to explain something.
test('discrete libpq variables are a complete configuration', () => {
  const resolved = resolveDatabaseConfig({
    PGHOST: 'db.internal',
    PGPORT: '6432',
    PGUSER: 'app',
    PGPASSWORD: 's3cret',
    PGDATABASE: 'reports',
    PGSSLMODE: 'require',
  });

  assert.deepEqual(resolved.pool, {
    host: 'db.internal',
    port: 6432,
    database: 'reports',
    user: 'app',
    password: 's3cret',
    ssl: { rejectUnauthorized: false },
  });
  assert.equal(resolved.target, 'db.internal:6432/reports as app');
  assert.doesNotMatch(resolved.target, /s3cret/);
});

test('RHINOQ_DB_* wins over the libpq names field by field', () => {
  const resolved = resolveDatabaseConfig({
    RHINOQ_DB_HOST: 'rhinoq.internal',
    RHINOQ_DB_NAME: 'rhinoq',
    PGHOST: 'app.internal',
    PGDATABASE: 'app',
    PGUSER: 'shared',
  });

  assert.equal(resolved.pool.host, 'rhinoq.internal');
  assert.equal(resolved.pool.database, 'rhinoq');
  assert.equal(resolved.pool.user, 'shared');
  assert.equal(resolved.pool.port, 5432);
});

// A half-configured environment must not fall through to a default host. That
// is how a migration lands in whichever database happens to answer on 5432.
test('discrete configuration without a host or a database resolves to nothing', () => {
  assert.equal(resolveDatabaseConfig({ PGUSER: 'app', PGPASSWORD: 'x' }), undefined);
  assert.equal(resolveDatabaseConfig({ PGHOST: 'db.internal' }), undefined);
  assert.equal(resolveDatabaseConfig({ PGDATABASE: 'reports' }), undefined);
  assert.equal(resolveDatabaseConfig({}), undefined);
});

test('an unusable port or sslmode is refused rather than silently downgraded', () => {
  assert.throws(
    () => resolveDatabaseConfig({ PGHOST: 'db', PGDATABASE: 'app', PGPORT: 'not-a-port' }),
    /PGPORT must be a port/,
  );
  assert.throws(
    () => resolveDatabaseConfig({ PGHOST: 'db', PGDATABASE: 'app', PGSSLMODE: 'yes-please' }),
    /PGSSLMODE must be one of/,
  );
});

test('sslmode disable produces an explicit plaintext connection', () => {
  const resolved = resolveDatabaseConfig({ PGHOST: 'db', PGDATABASE: 'app', PGSSLMODE: 'disable' });
  assert.equal(resolved.pool.ssl, false);
});

test('verify-full asks pg to validate the certificate chain', () => {
  const resolved = resolveDatabaseConfig({ PGHOST: 'db', PGDATABASE: 'app', PGSSLMODE: 'verify-full' });
  assert.deepEqual(resolved.pool.ssl, { rejectUnauthorized: true });
});

// The regression this closes: `npx rhinoq doctor` used to stop at "DATABASE_URL
// is not set" for a project whose platform only exports discrete variables.
test('doctor accepts discrete variables and reports the target it resolved', () => {
  const result = spawnSync(process.execPath, [developerCLI, 'doctor'], {
    encoding: 'utf8',
    env: {
      PGHOST: '127.0.0.1',
      PGPORT: '59999',
      PGUSER: 'rhinoq',
      PGDATABASE: 'rhinoq',
      PGSSLMODE: 'disable',
    },
  });

  assert.match(result.stdout, /INFO PostgreSQL target 127\.0\.0\.1:59999\/rhinoq as rhinoq from PGHOST, PGPORT, PGUSER, PGDATABASE, PGSSLMODE/);
  // It gets as far as connecting, which is the point; nothing listens there.
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /no PostgreSQL connection/);
});

test('doctor without any connection names both shapes in its NEXT action', () => {
  const result = spawnSync(process.execPath, [developerCLI, 'doctor'], { encoding: 'utf8', env: {} });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no PostgreSQL connection in the environment/);
  assert.match(result.stderr, /DATABASE_URL/);
  assert.match(result.stderr, /PGHOST/);
});
