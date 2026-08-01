import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli/task-migrate.js', import.meta.url));
const developerCLI = fileURLToPath(new URL('../dist/cli/rhinoq.js', import.meta.url));

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
  assert.equal(result.stdout.trim(), '0.1.0-beta.6');
  assert.equal(result.stderr, '');
});

test('developer CLI help and Rule generator work without hidden services or overwrites', () => {
  const help = spawnSync(process.execPath, [developerCLI, 'help'], { encoding: 'utf8', env: {} });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /npx rhinoq init/);
  const version = spawnSync(process.execPath, [developerCLI, '--version'], { encoding: 'utf8', env: {} });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '0.1.0-beta.6');
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-cli-'));
  try {
    const first = spawnSync(process.execPath, [developerCLI, 'verify', 'add', 'completed-report-has-output'], { cwd, encoding:'utf8', env:{} });
    assert.equal(first.status, 0, first.stderr);
    const path = join(cwd, '.rhinoq', 'rules', 'completed-report-has-output.sql');
    const generated = readFileSync(path, 'utf8');
    assert.match(generated, /output_url IS NULL/);
    const second = spawnSync(process.execPath, [developerCLI, 'verify', 'add', 'completed-report-has-output'], { cwd, encoding:'utf8', env:{} });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(path, 'utf8'), generated);
    assert.match(second.stdout, /KEEP/);
  } finally { rmSync(cwd, { recursive:true, force:true }); }
});
