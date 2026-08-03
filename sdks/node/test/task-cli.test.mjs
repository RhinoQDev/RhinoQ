import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
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
  assert.equal(result.stdout.trim(), '0.1.0-beta.7');
  assert.equal(result.stderr, '');
});

test('developer CLI help and Rule generator work without hidden services or overwrites', () => {
  const help = spawnSync(process.execPath, [developerCLI, 'help'], { encoding: 'utf8', env: {} });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /npx rhinoq init/);
  const version = spawnSync(process.execPath, [developerCLI, '--version'], { encoding: 'utf8', env: {} });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '0.1.0-beta.7');
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-cli-'));
  try {
    const first = spawnSync(process.execPath, [developerCLI, 'verify', 'add', 'completed-report-has-output'], { cwd, encoding:'utf8', env:{} });
    assert.equal(first.status, 0, first.stderr);
    const path = join(cwd, '.rhinoq', 'rules', 'completed-report-has-output.sql');
    const generated = readFileSync(path, 'utf8');
    const golden = readFileSync(new URL('../../../testdata/rules/completed-report-has-output.sql', import.meta.url), 'utf8');
    assert.equal(generated, golden);
    assert.doesNotMatch(generated, /--|\/\*|;\s*$/m);
    assert.match(generated, /\$1/);
    assert.match(generated, /\$2/);
    assert.match(generated, /\$3/);
    const second = spawnSync(process.execPath, [developerCLI, 'verify', 'add', 'completed-report-has-output'], { cwd, encoding:'utf8', env:{} });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(path, 'utf8'), generated);
    assert.match(second.stdout, /KEEP/);
    const apply = spawnSync(process.execPath, [developerCLI, 'verify', 'apply', 'completed-report-has-output'], { cwd, encoding:'utf8', env:{} });
    assert.equal(apply.status, 1);
    assert.match(apply.stderr, /RHINOQ_AGENT_URL\/RHINOQ_GATEWAY_URL/);
  } finally { rmSync(cwd, { recursive:true, force:true }); }
});

test('verify apply sends the Rule through the Go Gateway and keeps it disabled', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString('utf8') });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && request.url === '/v1/rules') {
      response.end(JSON.stringify({ rule: { id: 'completed-report-has-output', version: 1, status: 'draft' } }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/rules/completed-report-has-output/disable') {
      response.end(JSON.stringify({ rule: { id: 'completed-report-has-output', version: 1, status: 'disabled' } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-cli-gateway-'));
  try {
    const add = spawnSync(process.execPath, [developerCLI, 'verify', 'add', 'completed-report-has-output'], { cwd, encoding:'utf8', env:{} });
    assert.equal(add.status, 0, add.stderr);
    const child = spawn(process.execPath, [developerCLI, 'verify', 'apply', 'completed-report-has-output', '--subject-type', 'report'], {
      cwd,
      env: { ...process.env, RHINOQ_AGENT_URL: `http://127.0.0.1:${address.port}`, RHINOQ_AGENT_TOKEN: 'test-token' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [status] = await once(child, 'close');
    assert.equal(status, 0, stderr);
    assert.match(stdout, /status=disabled/);
    assert.equal(requests.length, 2);
    const payload = JSON.parse(requests[0].body);
    assert.equal(payload.scope, 'table');
    assert.equal(payload.subjectType, 'report');
    assert.match(payload.query, /\$1/);
    assert.match(payload.query, /\$2/);
    assert.match(payload.query, /\$3/);
  } finally {
    server.close();
    rmSync(cwd, { recursive:true, force:true });
  }
});
