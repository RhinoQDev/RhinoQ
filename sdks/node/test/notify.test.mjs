import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  assertSendableURL,
  defaultSecretEnv,
  loadNotifyRegistry,
  notificationBody,
  resolveNotifyDestination,
  sendNotification,
  sendTestNotification,
} from '../dist/index.js';

const developerCLI = fileURLToPath(new URL('../dist/cli/rhinoq.js', import.meta.url));
const goldenURL = new URL('../../../testdata/contracts/notification-message-v1.json', import.meta.url);

// The notification message is the only RhinoQ payload that leaves the system
// entirely: somebody else's receiver parses it. Now that Node can send one, the
// two implementations must produce a payload one receiver accepts.
test('the Node webhook body matches the shared Go notification contract v1', () => {
  const golden = JSON.parse(readFileSync(goldenURL, 'utf8'));
  const body = notificationBody('webhook', golden);

  assert.deepEqual(JSON.parse(body), golden);
  // Field order matches internal/contracts/notification.Message, so one
  // receiver implementation sees the same shape from either language.
  assert.deepEqual(Object.keys(JSON.parse(body)), [
    'id', 'type', 'ruleId', 'subjectType', 'subjectId', 'invariantVersion',
    'status', 'severity', 'escalation', 'link', 'occurrenceCount', 'evidence',
    'observedAt',
  ]);
});

test('the Slack body carries the finding, its evidence and its link', () => {
  const golden = JSON.parse(readFileSync(goldenURL, 'utf8'));
  const payload = JSON.parse(notificationBody('slack', golden));

  assert.match(payload.text, /RhinoQ finding finding_9f2c1d4b7a6e0358/);
  assert.match(payload.text, /report\/report-4471/);
  assert.match(payload.text, /7 sightings/);
  assert.match(payload.text, /Open: https:\/\/ops\.example\.com/);
  assert.equal(payload.blocks[0].text.text, payload.text);
});

// An unsigned event over plaintext HTTP is indistinguishable from one anybody
// on the path invented. Loopback is the exception because that is how the
// delivery probe is tested.
test('a non-HTTPS endpoint is refused unless it is loopback', () => {
  assert.doesNotThrow(() => assertSendableURL('https://example.com/hooks/rhinoq'));
  assert.doesNotThrow(() => assertSendableURL('http://localhost:8080/hooks'));
  assert.doesNotThrow(() => assertSendableURL('http://127.0.0.1:8080/hooks'));
  assert.throws(() => assertSendableURL('http://example.com/hooks'), /must use HTTPS/);
  assert.throws(() => assertSendableURL('not-a-url'), /invalid/);
});

test('a signed delivery carries an HMAC over the exact bytes sent', async () => {
  const received = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
    response.writeHead(204).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/hooks`;
  try {
    const destination = {
      name: 'ops', kind: 'webhook', url, secret: 'a-shared-secret',
      timeoutMs: 5_000, includeEvidence: false, gracePeriodMs: 0, findingBaseUrl: '',
    };
    const receipt = await sendTestNotification(destination, { now: new Date('2026-08-03T15:30:00.000Z') });

    assert.equal(receipt.status, 'sent');
    assert.equal(receipt.type, 'rhinoq.notification.test');
    assert.equal(received.length, 1);
    assert.equal(received[0].headers['x-rhinoq-event-id'], receipt.id);

    const expected = `v1=${createHmac('sha256', 'a-shared-secret').update(received[0].body).digest('hex')}`;
    assert.equal(received[0].headers['x-rhinoq-signature'], expected);

    // The probe writes nothing and carries no business data.
    const message = JSON.parse(received[0].body);
    assert.equal(message.subjectId, 'delivery-probe');
    assert.match(message.evidence, /No business data is included/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('an unsigned destination sends no signature header at all', async () => {
  const received = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    received.push(request.headers);
    response.writeHead(200).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await sendNotification(
      {
        name: 'ops', kind: 'webhook', url: `http://127.0.0.1:${server.address().port}/hooks`,
        secret: '', timeoutMs: 5_000, includeEvidence: false, gracePeriodMs: 0, findingBaseUrl: '',
      },
      JSON.parse(readFileSync(goldenURL, 'utf8')),
    );
    assert.equal(received[0]['x-rhinoq-signature'], undefined);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('a non-2xx response is a delivery failure, not a silent success', async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(403).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await assert.rejects(
      sendTestNotification({
        name: 'ops', kind: 'webhook', url: `http://127.0.0.1:${server.address().port}/hooks`,
        secret: '', timeoutMs: 5_000, includeEvidence: false, gracePeriodMs: 0, findingBaseUrl: '',
      }),
      /returned 403/,
    );
  } finally {
    server.close();
    await once(server, 'close');
  }
});

// A configured-but-empty secret variable must not fall back to unsigned:
// silently weakening a destination somebody chose to sign is worse than
// refusing to send.
test('an empty secret variable refuses the send instead of downgrading it', () => {
  const registry = {
    schemaVersion: 1,
    destinations: [{ name: 'ops', kind: 'webhook', url: 'https://example.com/h', secretEnv: 'RHINOQ_NOTIFY_SECRET_OPS' }],
  };
  assert.throws(() => resolveNotifyDestination(registry, 'ops', {}), /cannot be signed/);
  const resolved = resolveNotifyDestination(registry, 'ops', { RHINOQ_NOTIFY_SECRET_OPS: 's3cret' });
  assert.equal(resolved.secret, 's3cret');
  assert.equal(resolved.timeoutMs, 10_000);
});

test('an empty URL variable is reported rather than sent to nowhere', () => {
  const registry = {
    schemaVersion: 1,
    destinations: [{ name: 'ops', kind: 'slack', urlEnv: 'RHINOQ_NOTIFY_URL_OPS' }],
  };
  assert.throws(() => resolveNotifyDestination(registry, 'ops', {}), /has no URL/);
  assert.throws(() => resolveNotifyDestination(registry, 'missing', {}), /no destination named/);
});

test('the default secret variable name is derived from the destination', () => {
  assert.equal(defaultSecretEnv('ops'), 'RHINOQ_NOTIFY_SECRET_OPS');
  assert.equal(defaultSecretEnv('team-a.eu'), 'RHINOQ_NOTIFY_SECRET_TEAM_A_EU');
});

// The registry is a contract shared with the Go CLI. Guessing at a version
// this SDK does not write is how two tools disagree about what a field means.
test('a registry written by a future schema is refused, and a missing one is empty', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-notify-'));
  try {
    const empty = await loadNotifyRegistry(join(cwd, 'nothing.json'));
    assert.deepEqual(empty, { schemaVersion: 1, destinations: [] });

    const future = join(cwd, 'future.json');
    writeJSON(future, { schemaVersion: 99, destinations: [] });
    await assert.rejects(loadNotifyRegistry(future), /schema version 99/);

    const broken = join(cwd, 'broken.json');
    writeJSON(broken, undefined, '{ not json');
    await assert.rejects(loadNotifyRegistry(broken), /not valid RhinoQ notify JSON/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the CLI adds, lists and removes a destination without storing a secret', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-notify-cli-'));
  const registryPath = join(cwd, 'notifications.json');
  const env = { RHINOQ_NOTIFY_CONFIG: registryPath };
  try {
    const added = spawnSync(process.execPath, [
      developerCLI, 'notify', 'add', 'ops',
      '--webhook', 'https://example.com/hooks/rhinoq',
      '--secret-env', 'RHINOQ_NOTIFY_SECRET_OPS',
    ], { cwd, encoding: 'utf8', env });
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /PASS destination "ops" added to/);

    const stored = JSON.parse(readFileSync(registryPath, 'utf8'));
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.destinations[0].secretEnv, 'RHINOQ_NOTIFY_SECRET_OPS');
    // The registry records the variable name, never its value.
    assert.doesNotMatch(readFileSync(registryPath, 'utf8'), /s3cret/);
    assert.equal(stored.destinations[0].secret, undefined);

    const duplicate = spawnSync(process.execPath, [
      developerCLI, 'notify', 'add', 'ops', '--webhook', 'https://example.com/other',
    ], { cwd, encoding: 'utf8', env });
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already exists/);

    const listed = spawnSync(process.execPath, [developerCLI, 'notify', 'list', '--json'], { cwd, encoding: 'utf8', env });
    assert.equal(listed.status, 0, listed.stderr);
    const redacted = JSON.parse(listed.stdout);
    assert.equal(redacted.destinations[0].url, 'https://example.com/…');

    const removed = spawnSync(process.execPath, [developerCLI, 'notify', 'remove', 'ops'], { cwd, encoding: 'utf8', env });
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(JSON.parse(readFileSync(registryPath, 'utf8')).destinations.length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('adding an unsigned destination says so instead of passing quietly', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-notify-unsigned-'));
  try {
    const result = spawnSync(process.execPath, [
      developerCLI, 'notify', 'add', 'ops', '--webhook', 'https://example.com/hooks/rhinoq',
    ], { cwd, encoding: 'utf8', env: { RHINOQ_NOTIFY_CONFIG: join(cwd, 'n.json') } });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /WARN no --secret-env/);
    assert.match(result.stdout, /RHINOQ_NOTIFY_SECRET_OPS/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// A --url-env destination defaulting to webhook would post a Slack URL as a
// signed webhook and fail in a way nobody reads as "wrong kind".
test('a URL taken from the environment must state its kind', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rhinoq-notify-kind-'));
  try {
    const result = spawnSync(process.execPath, [
      developerCLI, 'notify', 'add', 'ops', '--url-env', 'RHINOQ_NOTIFY_URL_OPS',
    ], { cwd, encoding: 'utf8', env: { RHINOQ_NOTIFY_CONFIG: join(cwd, 'n.json') } });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--url-env needs --kind/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// The durable delivery ledger belongs to the Go engine. Reimplementing its
// dedup in TypeScript would put correctness in two languages, so the Node CLI
// refuses and points at the tool that owns it.
test('notify send is refused with the Go command that owns the delivery ledger', () => {
  const result = spawnSync(process.execPath, [developerCLI, 'notify', 'send', 'ops'], { encoding: 'utf8', env: {} });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not available in the Node SDK/);
  assert.match(result.stderr, /durable delivery ledger/);
  assert.match(result.stderr, /rhinoq notify send/);
});

function writeJSON(path, value, raw) {
  writeFileSync(path, raw ?? JSON.stringify(value), 'utf8');
}
