import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli/task-migrate.js', import.meta.url));
const developerCLI = fileURLToPath(new URL('../dist/cli/rhinoq.js', import.meta.url));

// Read the expected version rather than pinning it. A release bump is routine,
// and a test that fails on it teaches people to edit the assertion instead of
// checking what it was actually asserting: that the CLI reports the version of
// the package it shipped inside.
const packageVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

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
  assert.equal(result.stdout.trim(), packageVersion);
  assert.equal(result.stderr, '');
});

test('developer CLI help and Rule generator work without hidden services or overwrites', () => {
  const help = spawnSync(process.execPath, [developerCLI, 'help'], { encoding: 'utf8', env: {} });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /npx rhinoq init/);
  assert.match(help.stdout, /createRhinoQApp/);
  assert.match(help.stdout, /npx rhinoq adopt --mode single/);
  assert.match(help.stdout, /lab run completed-but-missing-output --recover --confirm-disposable/);
  const version = spawnSync(process.execPath, [developerCLI, '--version'], { encoding: 'utf8', env: {} });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), packageVersion);
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

test('dev demo serves the end-user Task Center and operator Workbench without PostgreSQL', async () => {
  const child = spawn(process.execPath, [developerCLI, 'dev', '--demo', '--port=0'], {
    cwd: mkdtempSync(join(tmpdir(), 'rhinoq-demo-')),
    encoding: 'utf8',
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const urls = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`demo did not start: ${stdout}\n${stderr}`)), 10_000);
      const check = () => {
        const tasks = stdout.match(/URL RhinoQ Task Center: (http:\/\/127\.0\.0\.1:\d+\/task-center)/);
        const workbench = stdout.match(/URL RhinoQ Workbench: (http:\/\/127\.0\.0\.1:\d+\/rhinoq)/);
        if (!tasks || !workbench) return;
        clearTimeout(timer);
        resolve({ tasks: tasks[1], workbench: workbench[1] });
      };
      child.stdout.on('data', check);
      check();
    });
    const page = await fetch(urls.workbench);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /RhinoQ Workbench/);
    const taskCenter = await fetch(urls.tasks);
    assert.equal(taskCenter.status, 200);
    assert.match(await taskCenter.text(), /data-rhinoq-task-center/);
    const origin = new URL(urls.tasks).origin;
    const inbox = await fetch(`${origin}/tasks`);
    assert.equal(inbox.status, 200);
    const inboxPayload = await inbox.json();
    assert.equal(inboxPayload.tasks.length, 4);
    assert.ok(inboxPayload.tasks.some((task) => task.state === 'uncertain'));
    const capabilities = await fetch(`${origin}/tasks/_capabilities`);
    assert.equal(capabilities.status, 200);
    assert.equal((await capabilities.json()).retry, true);
    const result = await fetch(`${origin}/tasks/demo-complete/result`);
    assert.equal(result.status, 200);
    assert.match((await result.json()).url, /demo-results\/demo-complete\.csv/);
    const overview = await fetch(`${urls.workbench}/api/overview`);
    assert.equal(overview.status, 200);
    const payload = await overview.json();
    assert.equal(payload.actions, true);
    assert.equal(payload.counts.failed, 1);
    const failed = await fetch(`${urls.workbench}/api/tasks/demo-failed/flight-recorder`);
    assert.equal(failed.status, 200);
    assert.match(await failed.text(), /demo-failed/);
    const retried = await fetch(`${origin}/tasks/demo-failed/retry`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, commandId: 'demo-failed-retry-1' }),
    });
    assert.equal(retried.status, 200);
    const retriedTask = await retried.json();
    assert.equal(retriedTask.state, 'running');
    assert.equal(retriedTask.executions.length, 3);
  } finally {
    child.kill();
    await once(child, 'close').catch(() => undefined);
  }
});

test('up dry-run creates a PostgreSQL 16 local plan without Docker', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-up-dry-run-'));
  try {
    const result = spawnSync(process.execPath, [developerCLI, 'up', '--dry-run', '--db-port=55433'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PostgreSQL 16 on 127\.0\.0\.1:55433/);
    assert.match(readFileSync(join(cwd, '.rhinoq', 'compose.local.yml'), 'utf8'), /postgres:16-alpine/);
    assert.match(readFileSync(join(cwd, '.env.rhinoq.local'), 'utf8'), /127\.0\.0\.1:55433/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('connect keeps adoption preview-first and add task creates a bounded vertical slice', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-connect-add-'));
  try {
    const connect = spawnSync(process.execPath, [developerCLI, 'connect'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(connect.status, 0, connect.stderr);
    assert.match(connect.stdout, /nothing is written/i);
    assert.equal(connect.stdout.includes('PASS generated'), false);

    const preview = spawnSync(process.execPath, [developerCLI, 'add', 'task', 'report.export'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /preview only/i);

    const apply = spawnSync(process.execPath, [developerCLI, 'add', 'task', 'report.export', '--apply'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(apply.status, 0, apply.stderr);
    const generated = readFileSync(join(cwd, 'src', 'rhinoq.tasks.mjs'), 'utf8');
    assert.match(generated, /defineRhinoQApplication/);
    assert.match(generated, /context\.progress\(0, 1/);
    assert.match(generated, /context\.progress\(1, 1/);
    assert.match(generated, /result:/);
    assert.match(generated, /createReportExportRoute/);
    assert.match(generated, /runReportExportWorker/);
    const smokeTest = readFileSync(join(cwd, 'test', 'rhinoq.tasks.test.mjs'), 'utf8');
    assert.match(smokeTest, /manifest/);
    assert.match(smokeTest, /plan\.status/);
    assert.match(smokeTest, /taskCenterPath/);
    assert.match(apply.stdout, /\/task-center/);
    const journey = JSON.parse(readFileSync(join(cwd, '.rhinoq', 'journeys', 'reportExport.json'), 'utf8'));
    assert.equal(journey.resultResolver, 'application_required');
    const doctorJourney = spawnSync(process.execPath, [developerCLI, 'doctor', '--journey'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(doctorJourney.status, 0, doctorJourney.stderr);
    assert.match(doctorJourney.stdout, /declaration → dispatch route → declared worker → result metadata → owner Task URL/);
    assert.match(doctorJourney.stdout, /result resolver remain application-required/);
    const kept = spawnSync(process.execPath, [developerCLI, 'add', 'task', 'report.export', '--apply'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(kept.stdout, /KEEP/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('doctor --fix repairs only local plumbing when PostgreSQL is unavailable', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-doctor-fix-'));
  try {
    const result = spawnSync(process.execPath, [developerCLI, 'doctor', '--fix'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /local files were fixed/i);
    assert.match(readFileSync(join(cwd, '.rhinoq', 'config.json'), 'utf8'), /taskProfileVersion/);
    assert.match(readFileSync(join(cwd, '.env.rhinoq.example'), 'utf8'), /DATABASE_URL/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('init report-export generates a fail-closed consumer without overwriting', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-init-report-'));
  try {
    const first = spawnSync(process.execPath, [developerCLI, 'init', '--example', 'report-export'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /URL Task Center/);
    const root = join(cwd, 'rhinoq-report-export');
    const app = readFileSync(join(root, 'app.mjs'), 'utf8');
    assert.match(app, /owner-a-session/);
    assert.match(app, /tenantFromNodeRequest/);
    assert.match(app, /name: 'report\.export'/);
    assert.match(app, /context\.progress\(0, 1/);
    assert.match(app, /context\.progress\(1, 1/);
    assert.match(app, /dispatch is intentionally not enabled/);
    const surface = JSON.parse(readFileSync(join(root, '.rhinoq', 'product-surface.json'), 'utf8'));
    assert.equal(surface.result, false);
    assert.equal(surface.verifier, false);
    const second = spawnSync(process.execPath, [developerCLI, 'init', '--example', 'report-export'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /KEEP/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('setup previews one complete plan and generates a native PostgreSQL worker without overwriting', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-setup-'));
  try {
    writeFileSync(join(cwd, 'go.mod'), 'module example.com/app\n\ngo 1.25.0\n');
    const preview = spawnSync(process.execPath, [developerCLI, 'setup'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /execution runtime\s+postgres \(auto-selected\)/);
    assert.match(preview.stdout, /capability detect/);
    assert.match(preview.stdout, /preview only; no schema or file was changed/);
    assert.equal(readFileSync(join(cwd, 'go.mod'), 'utf8'), 'module example.com/app\n\ngo 1.25.0\n');

    const apply = spawnSync(process.execPath, [developerCLI, 'setup', '--runtime', 'postgres', '--apply'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(apply.status, 0, apply.stderr);
    const worker = join(cwd, 'internal', 'rhinoqworker', 'worker.go');
    assert.match(readFileSync(worker, 'utf8'), /queue\.Handle\("reports", "report\.export"/);
    assert.match(apply.stdout, /doctor\/eval deferred/);
    const setup = JSON.parse(readFileSync(join(cwd, '.rhinoq', 'setup.json'), 'utf8'));
    assert.equal(setup.runtime, 'postgres');
    assert.equal(setup.schemaVersion, 2);
    assert.ok(setup.capabilities.includes('database:postgres-required'));
    assert.match(readFileSync(join(cwd, '.env.rhinoq.example'), 'utf8'), /RHINOQ_OPERATOR_TOKEN=/);
    assert.match(readFileSync(join(cwd, '.env.rhinoq.example'), 'utf8'), /RHINOQ_ARTIFACT_BUCKET=/);

    writeFileSync(worker, 'package rhinoqworker\n// user-owned\n');
    const repeat = spawnSync(process.execPath, [developerCLI, 'setup', '--runtime', 'postgres', '--apply'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(readFileSync(worker, 'utf8'), 'package rhinoqworker\n// user-owned\n');
    assert.match(repeat.stdout, /KEEP/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('setup manual generates the project-profile mount instead of a low-level start shell', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-setup-manual-'));
  try {
    const apply = spawnSync(process.execPath, [developerCLI, 'setup', '--runtime', 'manual', '--apply'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(apply.status, 0, apply.stderr);
    const app = readFileSync(join(cwd, 'rhinoq.app.mjs'), 'utf8');
    assert.match(app, /defineRhinoQProject/);
    assert.doesNotMatch(app, /defineRhinoQApplication/);
    assert.equal(JSON.parse(readFileSync(join(cwd, '.rhinoq', 'setup.json'), 'utf8')).projectProfile, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('transport fallback demo labels simulated evidence', () => {
  const result = spawnSync(process.execPath, [developerCLI, 'demo', 'transport-fallback'], { encoding: 'utf8', env: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /simulated browser transport demo/);
  assert.match(result.stdout, /polling_fallback/);
  assert.match(result.stdout, /service-backed browser campaign/);
});

test('Failure Lab refuses to connect without explicit disposable confirmation', () => {
  const result = spawnSync(
    process.execPath,
    [developerCLI, 'lab', 'run', 'completed-but-missing-output'],
    { encoding: 'utf8', env: {} },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires disposable database confirmation/);
  assert.match(result.stderr, /--confirm-disposable/);
  assert.doesNotMatch(result.stderr, /PostgreSQL connection/);
});

test('verify apply sends the Rule through the Go Gateway and keeps it disabled', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString('utf8') });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && request.url === '/v1/rules') {
      const wire = JSON.parse(readFileSync(new URL('../../../testdata/contracts/rule-record-v1.json', import.meta.url), 'utf8'));
      response.end(JSON.stringify({ rule: wire }));
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
    // The apply probes for an existing Rule first so it can show a diff before
    // bumping a version; an unknown Rule answers 404 and the apply continues.
    assert.equal(requests.length, 3);
    assert.deepEqual(
      { method: requests[0].method, url: requests[0].url },
      { method: 'GET', url: '/v1/rules/completed-report-has-output' },
    );
    const payload = JSON.parse(requests[1].body);
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

test('verify run warns when the baseline matches no subjects', async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    response.setHeader('content-type', 'application/json');
    if (request.url.endsWith('/enable') || request.url.endsWith('/disable')) {
      response.end(JSON.stringify({ rule: { id: 'completed-report-has-output', status: 'enabled' } }));
      return;
    }
    if (request.url.endsWith('/evaluate')) {
      response.end(JSON.stringify({ observations: [], hasMore: false }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-cli-empty-'));
  try {
    const add = spawnSync(process.execPath, [developerCLI, 'verify', 'add', 'completed-report-has-output'], { cwd, encoding:'utf8', env:{} });
    assert.equal(add.status, 0, add.stderr);
    const child = spawn(process.execPath, [developerCLI, 'verify', 'run', 'completed-report-has-output'], {
      cwd,
      env: { ...process.env, RHINOQ_AGENT_URL: `http://127.0.0.1:${address.port}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [status] = await once(child, 'close');
    assert.equal(status, 0, stderr);
    assert.match(stdout, /INFO 0 subject matched/);
    assert.match(stdout, /baseline may exclude older rows/);
  } finally {
    server.close();
    rmSync(cwd, { recursive:true, force:true });
  }
});

// The mock Gateway runs in this process, so a blocking spawnSync would stop it
// answering and deadlock the test. Every CLI run that talks to it goes through
// here instead.
async function runCLI(args, options = {}) {
  const child = spawn(process.execPath, [developerCLI, ...args], {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [status] = await once(child, 'close');
  return { status, stdout, stderr };
}

// A re-apply appends a new immutable version, and Findings stay attached to the
// version that observed them. Bumping silently therefore cuts the history an
// operator was reading, so the change is shown and the bump needs --force.
test('verify apply on a changed Rule prints a diff and refuses without --force', async () => {
  const existing = JSON.parse(readFileSync(new URL('../../../testdata/contracts/rule-record-v1.json', import.meta.url), 'utf8'));
  existing.version = 2;
  existing.query = 'SELECT id::text AS subject_id\nWHERE created_at >= $1 AND id::text > $2\nLIMIT $3\n';
  const posts = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    if (request.method === 'POST') posts.push(request.url);
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/v1/rules/completed-report-has-output') {
      response.end(JSON.stringify({ rule: existing }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/rules') {
      response.end(JSON.stringify({ rule: { ...existing, version: 3, status: 'draft' } }));
      return;
    }
    response.end(JSON.stringify({ rule: { id: 'completed-report-has-output', version: 3, status: 'disabled' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-cli-diff-'));
  const env = { ...process.env, RHINOQ_AGENT_URL: `http://127.0.0.1:${address.port}`, RHINOQ_AGENT_TOKEN: 'test-token' };
  try {
    assert.equal(spawnSync(process.execPath, [developerCLI, 'verify', 'add', 'completed-report-has-output'], { cwd, encoding: 'utf8', env: {} }).status, 0);

    const refused = await runCLI(['verify', 'apply', 'completed-report-has-output', '--subject-type', 'report'], { cwd, env });
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stdout, /already exists at v2/);
    assert.match(refused.stdout, /query line 1 - SELECT id::text AS subject_id/);
    assert.match(refused.stdout, /query line 1 \+ SELECT id::text AS subject_id,/);
    assert.match(refused.stdout, /will not be reopened/);
    assert.match(refused.stderr, /--force/);
    assert.equal(posts.length, 0, 'a refused apply must not register anything');

    const forced = await runCLI(['verify', 'apply', 'completed-report-has-output', '--subject-type', 'report', '--force'], { cwd, env });
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, /query line 1 -/);
    assert.equal(posts[0], '/v1/rules');
  } finally {
    server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('verify apply on an identical Rule registers nothing', async () => {
  const golden = readFileSync(new URL('../../../testdata/rules/completed-report-has-output.sql', import.meta.url), 'utf8');
  const existing = JSON.parse(readFileSync(new URL('../../../testdata/contracts/rule-record-v1.json', import.meta.url), 'utf8'));
  existing.query = golden;
  const posts = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    if (request.method === 'POST') posts.push(request.url);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ rule: existing }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-cli-same-'));
  try {
    assert.equal(spawnSync(process.execPath, [developerCLI, 'verify', 'add', 'completed-report-has-output'], { cwd, encoding: 'utf8', env: {} }).status, 0);
    const result = await runCLI(['verify', 'apply', 'completed-report-has-output', '--subject-type', 'report'], {
      cwd,
      env: { ...process.env, RHINOQ_AGENT_URL: `http://127.0.0.1:${address.port}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /KEEP Rule completed-report-has-output@v1 already matches/);
    assert.equal(posts.length, 0, 'an unchanged apply must not bump the version');
  } finally {
    server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

// A trial is where people create Rules they never meant to keep. Without a
// delete the list only grows, and an operator who cannot clean it stops reading
// it, which is worse than the probe Rule they were trying to remove.
test('verify delete previews before it removes', async () => {
  const calls = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    calls.push({ method: request.method, url: request.url });
    response.setHeader('content-type', 'application/json');
    const applied = request.url.includes('dryRun=false');
    response.end(JSON.stringify({
      deletion: {
        ruleId: 'probe-rule', versions: [1], explanations: 1, schedules: 1,
        outcomes: 3, findings: 0, findingEvents: 0, applied,
      },
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const env = { ...process.env, RHINOQ_AGENT_URL: `http://127.0.0.1:${address.port}` };
  try {
    const preview = await runCLI(['verify', 'delete', 'probe-rule'], { env });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /subject outcomes 3/);
    assert.match(preview.stdout, /INFO nothing was deleted/);
    assert.match(calls[0].url, /dryRun=true/);

    const applied = await runCLI(['verify', 'delete', 'probe-rule', '--apply'], { env });
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /PASS Rule probe-rule deleted/);
    assert.equal(calls[1].method, 'DELETE');
    assert.match(calls[1].url, /dryRun=false/);
  } finally {
    server.close();
  }
});

// The two doctors share a name and differ four-fold in depth. A PASS from the
// Node one must not read as "the runtime was checked".
test('Node CLI help separates its doctor from the Go runtime doctor', () => {
  const result = spawnSync(process.execPath, [developerCLI, 'help'], { encoding: 'utf8', env: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npx rhinoq eval/);
  assert.match(result.stdout, /isolated Task profile only/);
  assert.match(result.stdout, /rhinoq doctor/);
});

test('eval fails with one actionable database contract when PostgreSQL is absent', () => {
  const result = spawnSync(process.execPath, [developerCLI, 'eval'], { encoding: 'utf8', env: {} });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL no PostgreSQL connection/);
  assert.match(result.stderr, /then run: npx rhinoq eval/);
});

test('adopt previews first, generates once and never overwrites', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-adopt-'));
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      dependencies: { pg: '8.22.0', bullmq: '5.0.0' },
    }));
    const preview = spawnSync(process.execPath, [developerCLI, 'adopt', '--mode', 'fanout'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /preview only/);
    assert.match(preview.stdout, /extra process\s+none/);
    assert.match(preview.stdout, /framework-neutral/);
    const ambiguous = spawnSync(process.execPath, [developerCLI, 'adopt', '--apply'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /explicit Task mode/);
    const apply = spawnSync(process.execPath, [developerCLI, 'adopt', '--mode', 'fanout', '--apply'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(apply.status, 0, apply.stderr);
    const generated = readFileSync(join(cwd, 'rhinoq.integration.mjs'), 'utf8');
    assert.match(generated, /createBullMQIntegration/);
    assert.match(generated, /mode: 'fanout'/);
    assert.match(generated, /export async function startRhinoQ/);
    assert.doesNotMatch(generated, /application-infrastructure/);
    const syntax = spawnSync(process.execPath, ['--check', join(cwd, 'rhinoq.integration.mjs')], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    writeFileSync(join(cwd, 'rhinoq.integration.mjs'), 'user-owned');
    const repeat = spawnSync(process.execPath, [developerCLI, 'adopt', '--mode', 'single', '--apply'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(readFileSync(join(cwd, 'rhinoq.integration.mjs'), 'utf8'), 'user-owned');
    assert.match(repeat.stdout, /no integration file was changed/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('adopt preview explains missing prerequisites without failing', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-adopt-missing-'));
  try {
    writeFileSync(join(cwd, 'package.json'), '{"dependencies":{}}');
    const result = spawnSync(process.execPath, [developerCLI, 'adopt'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MISSING: install pg/);
    assert.match(result.stdout, /npm install @rhinoq\/node pg bullmq/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('observe adoption previews and generates a runtime-neutral fail-closed resolver workflow', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-adopt-observe-'));
  try {
    const preview = spawnSync(process.execPath, [developerCLI, 'adopt', '--adapter', 'custom', '--observe'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /observe-only adoption plan/);
    assert.match(preview.stdout, /preview only/);
    const apply = spawnSync(process.execPath, [developerCLI, 'adopt', '--adapter', 'custom', '--observe', '--apply'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(apply.status, 0, apply.stderr);
    const generated = readFileSync(join(cwd, 'rhinoq.observe.mjs'), 'utf8');
    assert.match(generated, /createRhinoQApp/);
    assert.match(generated, /PostgresAdoptionReportStore/);
    assert.match(generated, /if \(!identity\) return undefined/);
    assert.match(generated, /resolveIdentity\(event\.ref\)/);
    const report = JSON.parse(readFileSync(join(cwd, 'rhinoq-adoption-report.json'), 'utf8'));
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.durable, true);
    assert.ok(report.requirements.some((item) => item.callback === 'owner' && item.configured === false));
    const syntax = spawnSync(process.execPath, ['--check', join(cwd, 'rhinoq.observe.mjs')], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('adopt describes PostgreSQL as new infrastructure and can generate local evaluation compose', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-adopt-postgres-'));
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies: { pg: '8.22.0', bullmq: '5.0.0' } }));
    const preview = spawnSync(process.execPath, [developerCLI, 'adopt', '--mode', 'single'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /required new service/);
    const apply = spawnSync(process.execPath, [developerCLI, 'adopt', '--mode', 'single', '--local-postgres', '--apply'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(apply.status, 0, apply.stderr);
    const compose = readFileSync(join(cwd, 'compose.rhinoq.yml'), 'utf8');
    assert.match(compose, /127\.0\.0\.1:55432:5432/);
    assert.match(compose, /healthcheck/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Nest adoption detects every queue and refuses an ambiguous apply', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-adopt-nest-'));
  try {
    mkdirSync(join(cwd, 'src', 'mail'), { recursive: true });
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies: {
      pg: '8.22.0', bullmq: '5.0.0', '@nestjs/common': '11.0.0', '@nestjs/bullmq': '11.0.0',
    } }));
    writeFileSync(join(cwd, 'src', 'app.module.ts'), `import { Module } from '@nestjs/common';\n@Module({ imports: [] })\nexport class AppModule {}\n`);
    writeFileSync(join(cwd, 'src', 'mail', 'mail.module.ts'), `BullModule.registerQueue({ name: 'mail-queue' });\nBullModule.registerQueue({ name: "audit-queue" });\n`);
    writeFileSync(join(cwd, 'src', 'mail', 'mail.service.ts'), `export class MailService { constructor(private readonly mailQueue: any) {} send(data: unknown) { return this.mailQueue.add('send', data); } }\n`);

    const preview = spawnSync(process.execPath, [developerCLI, 'adopt', '--mode', 'single'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /audit-queue/);
    assert.match(preview.stdout, /mail-queue/);
    assert.match(preview.stdout, /select queues explicitly/i);
    assert.match(preview.stdout, /mail\.service\.ts:1/);

    const ambiguous = spawnSync(process.execPath, [developerCLI, 'adopt', '--mode', 'single', '--apply'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /multiple BullMQ queues/i);

    const apply = spawnSync(process.execPath, [developerCLI, 'adopt', '--task', 'mail-queue=mail.send:single', '--owner-property', 'user.id', '--apply'], { cwd, encoding: 'utf8', env: {} });
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(readFileSync(join(cwd, 'src', 'rhinoq.module.ts'), 'utf8'), /mail-queue/);
    assert.match(readFileSync(join(cwd, 'src', 'rhinoq.module.ts'), 'utf8'), /from '@rhinoq\/node'/);
    assert.match(readFileSync(join(cwd, 'src', 'rhinoq.module.ts'), 'utf8'), /ownerFromNodeRequest/);
    assert.match(readFileSync(join(cwd, 'src', 'rhinoq.module.ts'), 'utf8'), /forRoutes\('\/tasks'/);
    assert.match(readFileSync(join(cwd, 'src', 'rhinoq.module.ts'), 'utf8'), /createNodeTaskCenterMiddleware/);
    assert.match(readFileSync(join(cwd, 'src', 'rhinoq.module.ts'), 'utf8'), /RHINOQ_TASK_MANIFEST/);
    assert.match(readFileSync(join(cwd, 'src', 'rhinoq.module.ts'), 'utf8'), /"taskType": "mail\.send"/);
    assert.match(readFileSync(join(cwd, 'src', 'app.module.ts'), 'utf8'), /RhinoQAdoptionModule/);
    assert.match(apply.stdout, /verified AppModule import/i);
    assert.match(apply.stdout, /replace raw queue\.add at src[\\/]mail[\\/]mail\.service\.ts:1/);

    const multi = mkdtempSync(join(tmpdir(), 'rhinoq-adopt-nest-multi-'));
    try {
      mkdirSync(join(multi, 'src'), { recursive: true });
      writeFileSync(join(multi, 'package.json'), readFileSync(join(cwd, 'package.json')));
      writeFileSync(join(multi, 'src', 'app.module.ts'), `import { Module } from '@nestjs/common';\n@Module({ imports: [] })\nexport class AppModule {}\n`);
      writeFileSync(join(multi, 'src', 'queues.ts'), `BullModule.registerQueue({ name: 'mail-queue' }, { name: 'audit-queue' });`);
      const result = spawnSync(process.execPath, [developerCLI, 'adopt', '--mode', 'single', '--queue', 'mail-queue', '--queue', 'audit-queue', '--owner-property', 'user.id', '--apply'], { cwd: multi, encoding: 'utf8', env: {} });
      assert.equal(result.status, 0, result.stderr);
      const generated = readFileSync(join(multi, 'src', 'rhinoq.module.ts'), 'utf8');
      assert.match(generated, /mail-queue/); assert.match(generated, /audit-queue/);
      assert.equal((generated.match(/new Pool\(\)/g) ?? []).length, 1);
      assert.equal((generated.match(/new QueueEvents/g) ?? []).length, 2);
      assert.equal((generated.match(/integrationToken: RHINOQ_INTEGRATION_/g) ?? []).length, 2);
      assert.match(generated, /aggregateRhinoQHealth/);
      assert.match(generated, /queues: await Promise\.all|const queues = await Promise\.all/);
    } finally { rmSync(multi, { recursive: true, force: true }); }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('adopt runtime verification checks health and the mounted Task Center', async () => {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push({ url: request.url, authorization: request.headers.authorization });
    if (request.url === '/tasks/_health') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok', database: 'up', projector: 'projecting' }));
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<title>RhinoQ Task Center</title>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    const result = await runCLI(['adopt', '--verify-url', `http://127.0.0.1:${address.port}`], {
      env: { ...process.env, RHINOQ_ADOPT_VERIFY_HEADERS: JSON.stringify({ authorization: 'Bearer test-session' }) },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS application runtime health/);
    assert.match(result.stdout, /PASS Task Center reachable/);
    assert.deepEqual(calls.map((call) => call.url), ['/tasks/_health', '/task-center']);
    assert.ok(calls.every((call) => call.authorization === 'Bearer test-session'));
  } finally { server.close(); }
});
