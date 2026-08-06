// The verification pass, as a job you would put on a schedule.
//
// A Rule is SQL running in a READ ONLY transaction under a role that is
// required not to have network or filesystem functions. That is the right
// design for something pointed at production on a timer, and it means no Rule
// can stat a file or HEAD an object. Something has to go and look; this is it.
// It writes what it found into `rhinoq_verifications`, which a Rule can read.
//
//   npm run verify
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import {
  installPostgresTaskProfile,
  latestAttemptPerItem,
  objectExists,
  recordVerification,
  VERIFICATION_TABLE_SQL,
} from '@rhinoq/node';

const STORAGE = join(import.meta.dirname, 'storage');
const pool = new pg.Pool({ connectionString: process.env.RHINOQ_DATABASE_URL });
const tasks = await installPostgresTaskProfile(pool);
await pool.query(VERIFICATION_TABLE_SQL);

const outputExists = objectExists({
  head: async ({ key }) => {
    try {
      await stat(join(STORAGE, `${key}.txt`));
      return true;
    } catch (error) {
      // ENOENT is a verdict. Everything else is "we could not look", and the
      // difference is the whole point: a permissions error must not be allowed
      // to vote that the object is fine, or drift disappears whenever the
      // check itself is broken.
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  },
});

const recent = await tasks.listTasksByState({
  states: ['succeeded', 'failed'],
  limit: 20,
});

let checked = 0;
const drift = [];
for (const task of recent) {
  const results = await tasks.getTaskExecutionResults(task.id);
  // The list contains every attempt. One item is its latest one; checking the
  // superseded attempts would verify the same file several times and count it
  // several times too.
  for (const execution of latestAttemptPerItem(results.executions)) {
    if (execution.state !== 'succeeded') continue;
    const outcome = await outputExists({ bucket: 'storage', key: execution.itemKey });
    await recordVerification(pool, 'output-file-exists', outcome);
    checked += 1;
    if (outcome.status !== 'present') {
      drift.push({ task: task.id, item: execution.itemKey, ...outcome });
    }
  }
}

console.log(`checked ${checked} finished item(s) across ${recent.length} batch(es)`);
for (const row of drift) {
  console.log(
    `  ${row.status.toUpperCase()} ${row.task}/${row.item}` +
    (row.unknownReason ? ` (${row.unknownReason}: ${row.detail})` : ''),
  );
}
if (drift.length === 0) console.log('  every output is where the queue said it was');

await pool.end();
process.exitCode = drift.some((row) => row.status === 'missing') ? 1 : 0;
