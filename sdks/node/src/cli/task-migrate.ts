#!/usr/bin/env node

import * as pg from 'pg';

import {
  TASK_SCHEMA_NAME,
  TASK_SCHEMA_VERSION,
  migrateTaskSchema,
} from '../postgres/task-schema.js';
import { SDK_VERSION } from '../gateway/types.js';
import { resolveDatabaseConfig } from './database-config.js';

const USAGE = `Usage:
  RHINOQ_DATABASE_URL=postgres://... npx rhinoq-task
  npx rhinoq-task postgres://...
  PGHOST=... PGDATABASE=... npx rhinoq-task

Creates or upgrades the isolated rhinoq_task schema. The Task-only profile uses
exactly three tables and does not modify application tables.

The connection comes from RHINOQ_DATABASE_URL, DATABASE_URL, the discrete
PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE variables (RHINOQ_DB_* also works),
or the first argument.
`;

async function main(): Promise<void> {
  const argument = process.argv[2];
  if (argument === '--help' || argument === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  if (argument === '--version' || argument === '-v') {
    process.stdout.write(`${SDK_VERSION}\n`);
    return;
  }

  // The explicit argument is only a fallback: an operator who has exported the
  // variables should not have to repeat the URL, and a URL on the command line
  // ends up in the shell history with its password.
  const resolved = resolveDatabaseConfig(process.env)
    ?? (argument ? { pool: { connectionString: argument } } : undefined);
  if (!resolved) {
    throw new TypeError(
      'No PostgreSQL connection found. Set RHINOQ_DATABASE_URL or DATABASE_URL, ' +
        'set PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE, or pass a PostgreSQL URL ' +
        'as the first argument.',
    );
  }
  const pool = new pg.Pool(resolved.pool);
  try {
    await migrateTaskSchema(pool);
    process.stdout.write(
      `RhinoQ Task schema ${TASK_SCHEMA_VERSION} (${TASK_SCHEMA_NAME}) ready; ` +
        '3 tables in rhinoq_task.\n',
    );
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
