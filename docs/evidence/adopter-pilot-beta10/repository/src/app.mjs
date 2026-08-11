import pg from 'pg';
import { installPostgresTaskProfile } from '@rhinoq/node';
import { createHttpHandler } from './http.mjs';

export async function createApp(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const tasks = await installPostgresTaskProfile(pool);
  return { pool, tasks, taskHandler: createHttpHandler(tasks) };
}
