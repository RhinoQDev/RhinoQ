import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { installPostgresTaskProfile, migrateTaskSchema } from '../dist/index.js';

// `OFFSET n` makes PostgreSQL produce and discard n rows before returning
// anything, so a deep page costs proportionally more than a shallow one — and
// the list stream re-runs the query on a timer, which makes that a standing
// cost. It is also unstable: a Task updated mid-walk shifts every later offset
// by one, so an offset walk silently skips or repeats rows.
const databaseUrl = process.env.RHINOQ_TEST_DATABASE_URL;

const TOTAL = 25;
const PAGE = 10;

async function freshProfile() {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', '-c rhinoq.tenant_id=default');
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  await pool.query('DROP SCHEMA IF EXISTS rhinoq_task CASCADE');
  await migrateTaskSchema(pool);
  return { pool, tasks: await installPostgresTaskProfile(pool) };
}

async function seed(tasks, count) {
  const ids = [];
  for (let index = 0; index < count; index++) {
    const id = `page-${String(index).padStart(3, '0')}`;
    await tasks.createTask({ id, type: 'bench', ownerId: 'owner', definitionVersion: 1 });
    ids.push(id);
  }
  return ids;
}

async function walk(tasks, limit) {
  const seen = [];
  let cursor;
  for (let guard = 0; guard < 100; guard++) {
    const page = await tasks.listTasksPage('owner', { cursor, limit });
    seen.push(...page.tasks.map((task) => task.id));
    if (!page.nextCursor) return seen;
    cursor = page.nextCursor;
  }
  throw new Error('cursor walk did not terminate');
}

test('a cursor walk visits every Task exactly once', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    const created = await seed(tasks, TOTAL);
    const seen = await walk(tasks, PAGE);

    assert.equal(seen.length, TOTAL, 'the walk must return every Task');
    assert.equal(new Set(seen).size, TOTAL, 'the walk must not repeat a Task');
    assert.deepEqual([...seen].sort(), [...created].sort());
  } finally {
    await pool.end();
  }
});

test('the last page omits nextCursor rather than returning an empty one', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    await seed(tasks, 3);
    const page = await tasks.listTasksPage('owner', { limit: 10 });
    assert.equal(page.tasks.length, 3);
    assert.equal(page.nextCursor, undefined, 'a caller must know to stop without a count query');
  } finally {
    await pool.end();
  }
});

// The correctness argument for keyset, separate from the speed one.
//
// Ordering is newest-first and `updated_at` only ever moves forward, so a Task
// written during the walk jumps toward the head and pushes everything after it
// one position later. An OFFSET walk counts positions, so the next page starts
// one row short of where it left off and returns a row the caller has already
// seen. Measured on this schema: the offset walk returns 25 rows of which 24
// are distinct.
//
// A keyset walk anchors on the last row it actually read rather than on a
// count, so the shift cannot duplicate anything.
//
// Neither walk can show the row that moved ahead of the reader — a forward walk
// over a list being reordered does not go back — and that is the semantics of
// the question, not a defect in either. Duplication is the part that differs.
test('a Task written mid-walk does not make the walk repeat a row', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    const created = await seed(tasks, TOTAL);

    const first = await tasks.listTasksPage('owner', { limit: PAGE });
    // Deliberately a Task on a later page: bumping one already on page 1
    // reorders nothing the reader has not passed, and would prove nothing.
    const moved = created[5];
    assert.ok(
      !first.tasks.some((task) => task.id === moved),
      'the bumped Task must start beyond the first page for this to test anything',
    );
    const snapshot = await tasks.getTask(moved);
    await tasks.transitionTask(moved, snapshot.entityVersion, 'queued');

    const seen = [...first.tasks.map((task) => task.id)];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await tasks.listTasksPage('owner', { cursor, limit: PAGE });
      seen.push(...page.tasks.map((task) => task.id));
      cursor = page.nextCursor;
    }

    const duplicated = seen.filter((id, index) => seen.indexOf(id) !== index);
    assert.deepEqual(duplicated, [], 'a keyset walk must not return a row twice');
    assert.equal(new Set(seen).size, seen.length);
  } finally {
    await pool.end();
  }
});

test('a malformed cursor is refused rather than silently restarting the walk', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    await seed(tasks, 2);
    for (const cursor of ['not-base64url!!', Buffer.from('{}').toString('base64url')]) {
      await assert.rejects(
        tasks.listTasksPage('owner', { cursor }),
        TypeError,
        `cursor ${cursor} must be refused`,
      );
    }
  } finally {
    await pool.end();
  }
});
