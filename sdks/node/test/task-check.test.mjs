import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';

test('Task endpoint checker exposes read-only help without network access', async () => {
  const result = await run(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /read-only/);
  assert.match(result.stdout, /RHINOQ_TASK_HEADERS_JSON/);
});

test('Task endpoint checker validates two non-regressing snapshots', async () => {
  let version = 1;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(snapshot(version++)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const result = await run([`http://127.0.0.1:${address.port}/tasks`, 'task-1']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /task-1 running v2/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli/task-check.js', ...args], {
      cwd: new URL('..', import.meta.url),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function snapshot(entityVersion) {
  return {
    schemaVersion: 1, entityVersion, id: 'task-1', type: 'report.export',
    state: 'running', progress: { completed: 0 }, executions: [], hasResult: false,
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:01Z',
  };
}
