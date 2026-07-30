#!/usr/bin/env node

import * as pg from 'pg';

import {
  TASK_SCHEMA_NAME,
  TASK_SCHEMA_VERSION,
  migrateTaskSchema,
} from '../postgres/task-schema.js';
import { SDK_VERSION } from '../gateway/types.js';

const USAGE = `Usage:
  RHINOQ_DATABASE_URL=postgres://... npx rhinoq-task
  npx rhinoq-task postgres://...

Creates or upgrades the isolated rhinoq_task schema. The Task-only profile uses
exactly three tables and does not modify application tables.
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

  const databaseUrl = process.env.RHINOQ_DATABASE_URL ?? argument;
  if (!databaseUrl) {
    throw new TypeError(
      'Set RHINOQ_DATABASE_URL or pass a PostgreSQL URL as the first argument.',
    );
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
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
