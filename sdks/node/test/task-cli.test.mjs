import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli/task-migrate.js', import.meta.url));

test('Task migration CLI exposes help without connecting to PostgreSQL', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], {
    encoding: 'utf8',
    env: {},
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /exactly three tables/);
  assert.equal(result.stderr, '');
});

test('Task migration CLI reports the package version without a database', () => {
  const result = spawnSync(process.execPath, [cli, '--version'], {
    encoding: 'utf8',
    env: {},
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0.1.0-beta.4');
  assert.equal(result.stderr, '');
});
