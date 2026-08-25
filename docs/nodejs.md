# Node.js integration

> Status: public prerelease. Pin the exact published `0.1.0-beta.24` version;
> build a tarball from this checkout only when evaluating unreleased changes. See
> [releasing.md](./releasing.md) before evaluating it.

RhinoQ supports JavaScript and TypeScript on Node.js 22+ through one package
and one runtime-neutral Task contract. Choose the smallest integration surface
that solves the actual problem: application-owned runtime events through an
adapter, or the BullMQ preset when the application already uses BullMQ.

| Need | Use | What it does | Extra process |
|---|---|---|---:|
| Add a job from Node.js | `PostgresProducer` | calls `rhinoq.enqueue()` through the application's existing `pg` connection | No |
| Commit a business row and job atomically | `PostgresProducer` with the current transaction client | puts both writes in the same PostgreSQL transaction | No |
| Create/update/poll user-facing Tasks | `PostgresTaskClient` with the application's `pg.Pool` | calls versioned `rhinoq_task.*` commands | No |
| Run handlers in Node.js | `RhinoQWorker` | claims, heartbeats and reports results through the HTTP Gateway | Yes |
| Inspect or control work from Node.js | `RhinoQClient` | calls the typed Gateway operator API | Yes |
| Legacy/full-store Task API | `RhinoQClient` | calls the versioned Gateway Task HTTP API | Yes |

The Task API is polling-first. `createTask`, `getTask`, `transitionTask` and
`reportTaskProgress` return `TaskSnapshot` with monotonic `entityVersion`.
`attachTaskResult` and `getTaskResult` exchange a storage reference separately
from the polling snapshot. A `reportTaskProgress` call carrying the value the
Task already holds is a no-op: it returns `200` with the current snapshot,
leaves `entityVersion` alone and is never answered with a version conflict. The
same holds for repeating a cancellation request. Re-delivered queue events are
therefore safe to forward without deduplicating them first.
`createTaskExecution` and `bindTaskExecution` let an adapter register one
attempt and its stable native/external runtime identity. Both return the newest
aggregate Snapshot; they do not dispatch work themselves.
Callers must pass that version on writes and ignore an older polling response.
When a low-level caller asks for `transitionTask(id, version, 'running')`, the
Gateway and PostgreSQL clients first verify the current snapshot; an exact
`pending` snapshot is advanced through fenced `queued` and `running` commands.
The database state machine still authorizes each transition.
The owner application surface also exposes snapshot-convergent SSE through
`ApplicationTaskClient.streamTask()` and `streamTasks()`. Each stream carries
authoritative snapshots, supports `Last-Event-ID` for one Task, sends
heartbeats and falls back to snapshot polling after disconnect; SSE is a
delivery optimization, not a second state store. Result-payload proxying is
still application-owned.

For the direct Task client, `openTask(id)` returns a `TaskHandle` that carries
the latest version through a linear worker. The two convenience methods below
cover common friction without hiding conflicts:

```ts
await client.reportTaskProgressAutoVersion(taskId, { completed: 50, total: 100 });
await client.completeTask(taskId, { resultRef: 's3://reports/report-42.csv' });
```

`reportTaskProgressAutoVersion()` reads once before writing, and
`completeTask()` composes start, optional result attachment and success. They
are not atomic SQL commands and do not auto-retry `RHINOQ_VERSION_CONFLICT`.
For runtime-backed workers, prefer `defineRhinoQApplication()` with
`workerHandler()` or `runWorker()`; that abstraction routes registered Task
names while the selected runtime retains lease and retry authority.

For a direct client worker that already receives one selected Task job, use
`createTaskWorker({ client, type, handler })`:

```ts
const worker = createTaskWorker({
  client,
  type: 'report.export',
  handler: async (payload, { progress }) => {
    await progress({ completed: 1, total: 2 });
    return generateReport(payload);
  },
});
await worker({ taskId: 'report-42', payload: { reportId: '42' } });
```

This helper does not scan a queue or implement lease, heartbeat or retry
policy. For those responsibilities, pass the registered handler to the
selected runtime through the application compiler.

`RHINOQ_POSTGRES_UNREACHABLE` is a retryable classification, not an automatic
SDK retry. A lost acknowledgement can mean that a write committed, so the
application or runtime must retry only an idempotent command or reconcile the
Task first.

The embedded profile also supports a real tenant boundary: put `tenantId` on
dispatch/create and provide `tenantFromRequest` beside `ownerFromRequest`.
Owner reads, SSE, waitpoints, verification and artifacts include both tenant
and owner in their SQL predicates. Migration 014 also applies forced PostgreSQL
RLS to every tenant-owned Task table. Configure rhinoq.tenant_id in the pool
connection options and use one tenant per pool; tenantFromRequest remains an
application authorization check.
Artifacts keep checksum, expiry, refresh version and lineage while withholding
the private storage reference from browsers. Configure `resolveArtifact` to
issue a short-lived authorized URL. Configure `riskPolicy` to expose At risk
and Stuck from explicit no-progress thresholds.

`beta.2` and later also export `watchTask()`, a framework-neutral async
iterator for one Task. It performs non-overlapping polls, ignores snapshots at
or below the highest rendered `entityVersion`, stops on terminal state by
default and accepts an `AbortSignal`. Network and authorization failures are
reported to the caller; the helper does not invent an outage retry policy.

The beta.24 prerelease exports `TaskStore`, a browser external
store suitable for React `useSyncExternalStore` and equivalent adapters. It
exposes loading, connected, reconnecting and stopped states, retries transport
failures with bounded backoff, and never accepts an older `entityVersion`.
`createUseRhinoTask()` adapts that store to React without making React a RhinoQ
dependency. `rhinoq-task-check` performs a read-only reachability, Snapshot v1
shape and non-regressing-version check against the application-owned endpoint.
`BullMQTaskBridge.dispatchMany()` bounds reserve/enqueue pressure (default `8`,
configurable `1..64`), rejects ambiguous batch identities before side effects
and drains sibling workers before surfacing a partial failure, making an
immediate deterministic retry safe from overlap with the previous call.
Each BullMQ `failed` event closes the current RhinoQ Execution attempt; the
`isTerminalFailure` callback controls only whether the parent Task is terminal.
For restart recovery, `reconcileTask()` reads the latest embedded runtime refs
and accepts a one-based runtime attempt so a missed failed/active pair becomes
durable history instead of a stuck attempt.

```ts
import { watchTask } from '@rhinoq/node';

for await (const snapshot of watchTask(client, 'report_01', {
  pollIntervalMs: 1_000,
  signal: controller.signal,
})) {
  renderTask(snapshot);
}
```

The Gateway is deterministic Go infrastructure, not an AI agent. It does not
run a model or require an LLM.

## What you will run

There are three different command surfaces. They are not interchangeable:

| Surface | Example | Purpose |
|---|---|---|
| repository commands | `npm test`, `npm pack` | build and inspect the SDK artifact |
| RhinoQ CLI | `rhinoq migrate apply`, `rhinoq doctor` | prepare and inspect PostgreSQL |
| application process | `node worker.mjs` | run your producer or long-lived Node worker |

The current CLI has no `rhinoq enqueue` or generic `rhinoq work` command.
Enqueueing belongs to the application transaction. Node handlers run from the
application's `RhinoQWorker` process, where real handler functions are
available.

The onboarding `rhinoq` command also exposes `verify add`, `verify apply` and
`verify run`. `add` writes a reviewable table-Rule template; `apply` sends the
file to the authoritative Go Gateway and leaves it disabled; `run` enables one
bounded evaluation, prints violations/evidence and disables it again. These
three commands require the full Rule schema and Gateway, not the isolated
isolated Task-only profile.

## Build the package from this repository

Build and inspect the preview locally when contributing or validating a change.
Start in the repository root:

```bash
cd sdks/node
npm ci
npm run typecheck
npm test
npm run pack:check
npm run pack
```

Each command has a different purpose:

| Command | What it does | Files produced |
|---|---|---|
| `npm ci` | installs the exact development dependencies from `package-lock.json`; use this in a clean checkout | `node_modules/` |
| `npm run typecheck` | checks public TypeScript types without emitting JavaScript | none |
| `npm test` | builds `src/` into `dist/`, then runs the Node test suite | `dist/` |
| `npm run pack:check` | builds and shows which files would enter the package without creating an archive | `dist/` |
| `npm run pack` | removes earlier archives, rebuilds and creates the archive | `rhinoq-node-0.1.0-beta.24.tgz` |
| `npm run verify:installed -- <app>` | proves an installed copy was built from this source | none |

Use `npm run pack` rather than bare `npm pack`: it deletes earlier archives
first. `npm pack` leaves them, and a filename carries only a version — an
archive packed before a change landed keeps installing cleanly under a version
that implies the change is present.

`npm run pack` is intentionally run from `sdks/node`. The older command
`npm --prefix sdks/node pack` does not reliably change the package directory
for npm's built-in `pack` command.

Install the generated tarball and the PostgreSQL driver in the target Node
application. Replace the example path with the absolute path on your machine:

```bash
npm install /path/to/rhinoq/sdks/node/rhinoq-node-0.1.0-beta.24.tgz pg
```

Windows PowerShell example:

```powershell
npm install C:\src\rhinoq\sdks\node\rhinoq-node-0.1.0-beta.24.tgz pg
```

Why `pg` is separate: `@rhinoq/node` accepts a minimal query executor and does
not own or configure the application's connection pool.

This source-install path is the authoritative way to evaluate changes not yet
published. The tagged beta.24 prerelease is verified on npm and GitHub and
includes prebuilt `rhinoq` CLI binaries.

### Verify the installed package

Run this from the target Node application:

```bash
node --input-type=module -e "import('@rhinoq/node').then(m => console.log(Boolean(m.PostgresProducer)))"
```

Expected output:

```text
true
```

## Preferred Task-only PostgreSQL path

For an application that keeps BullMQ or another runtime, install only the
isolated Task profile:

```bash
RHINOQ_DATABASE_URL='postgres://...' npx rhinoq-task
```

### Cấu hình kết nối cho `npx rhinoq` và `npx rhinoq-task`

Không phải project nào cũng có connection URL. Managed provider, Helm chart và
docker-compose thường phát ra biến rời. Cả hai CLI đọc theo thứ tự sau và dừng
ở cái đầu tiên có giá trị:

| Thứ tự | Biến | Ghi chú |
|---:|---|---|
| 1 | `RHINOQ_DATABASE_URL` | connection string |
| 2 | `DATABASE_URL` | connection string |
| 3 | `RHINOQ_DB_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_NAME` / `_SSLMODE` | biến rời của RhinoQ, thắng tên libpq theo từng field |
| 4 | `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` / `PGSSLMODE` | tên libpq |

Cấu hình rời cần **tối thiểu host và tên database**. Thiếu một trong hai thì
CLI coi như chưa cấu hình gì và báo lỗi, thay vì rơi về host mặc định — đó là
cách một lần migrate chạy nhầm vào database đang lắng nghe trên 5432.

`PGSSLMODE` nhận `disable`, `allow`, `prefer`, `require`, `verify-ca`,
`verify-full`. Giá trị lạ bị từ chối chứ không im lặng hạ xuống plaintext.

`npx rhinoq doctor` in ra target đã phân giải (`host:port/db as user`, không
kèm mật khẩu) và tên biến nó đã đọc, để bạn thấy ngay khi đang trỏ nhầm nơi.

```bash
PGHOST=db.internal PGPORT=6432 PGUSER=app PGDATABASE=reports PGSSLMODE=require \
  npx rhinoq doctor
```

```ts
import {
  createTaskRequestHandler,
  installPostgresTaskProfile,
} from '@rhinoq/node';

const tasks = await installPostgresTaskProfile(appPool);
const taskHandler = createTaskRequestHandler({
  tasks,
  ownerFromRequest: (request) => authenticateApplicationUser(request),
});
```

`PostgresTaskClient` calls versioned PostgreSQL command functions; it does not
copy transition or progress correctness into TypeScript. It reuses `appPool`,
creates no process and requires no RhinoQ token. The application still owns
its user authentication and result signing. `definitionVersion` is optional on
Task creation and defaults to `1`; if the Task profile is missing, the client
returns `RHINOQ_TASK_SCHEMA_MISSING` with the next action `npx rhinoq-task`.

## Prepare PostgreSQL once

The following full-schema path is only for native runtime/Verified Tasks or
legacy Gateway evaluation. Task-only Node adopters should use `rhinoq-task`
above.

### Bash, zsh or WSL

```bash
export RHINOQ_DATABASE_URL='postgres://postgres:postgres@localhost:5432/app'
rhinoq migrate plan
rhinoq migrate apply
rhinoq doctor
```

### Windows PowerShell

```powershell
$env:RHINOQ_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/app'
rhinoq migrate plan
rhinoq migrate apply
rhinoq doctor
```

What the commands mean:

| Command | Why you run it | Writes data |
|---|---|:---:|
| `rhinoq migrate plan` | verifies migration history and shows pending versions | No |
| `rhinoq migrate apply` | applies the reviewed schema under an advisory lock | Yes |
| `rhinoq doctor` | fails if configuration, connection or schema is unsafe | No |

If the CLI is not installed, run the source equivalent from the repository
root:

```bash
go run ./cmd/rhinoq migrate plan
go run ./cmd/rhinoq migrate apply
go run ./cmd/rhinoq doctor
```

Register every producer job name deliberately:

```sql
INSERT INTO rhinoq.job_allowlist (
  job_name,
  producer_role,
  max_payload_bytes
) VALUES (
  'generate-report',
  current_user,
  262144
);
```

For this local walkthrough, `current_user` authorizes the same PostgreSQL login
that applied the row. In production, use the application's least-privileged
login or a deliberately granted producer role. Do not give one shared login
permission to every domain.

When migrations are applied by a separate owner/DBA, grant only the function
boundary to the producer role; do not grant queue-table access:

```sql
GRANT USAGE ON SCHEMA rhinoq TO app_report_producer;
GRANT EXECUTE ON FUNCTION rhinoq.enqueue(
  text, jsonb, text, text, integer, text, interval, text, text
) TO app_report_producer;

INSERT INTO rhinoq.job_allowlist (
  job_name,
  producer_role,
  max_payload_bytes
) VALUES (
  'generate-report',
  'app_report_producer',
  262144
);
```

The application login must be `app_report_producer` or a deliberate member of
that role. Migration 008 removes the default `PUBLIC` execute privilege.

The allowlist row controls:

| Column | Purpose |
|---|---|
| `job_name` | exact name the producer may enqueue |
| `producer_role` | PostgreSQL login/role allowed to create that job; membership is checked against the invoking login; `NULL` allows any login that can execute the function |
| `max_payload_bytes` | server-side payload ceiling |
| `payload_schema` | optional application schema/version identity |
| `default_class` | default resource class when the producer omits one |
| `default_priority` | default priority when the producer omits one |

The SQL function rejects an unregistered name before writing a job.

## Producer-only: the recommended Node starting point

```ts
import pg from 'pg';
import { PostgresProducer } from '@rhinoq/node';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
const producer = new PostgresProducer({
  query: (text, values) => pool.query(text, values),
});

const jobId = await producer.enqueue({
  name: 'generate-report',
  payload: { reportId: 'report_01' },
  idempotencyKey: 'report:report_01',
  correlationId: 'report_01',
});
```

After migrations 026–027, the connection must carry an explicit tenant session
setting, for example
`?options=-c%20rhinoq.tenant_id%3Dtnt_acme`. RhinoQ deliberately fails a write
that has no tenant context instead of silently assigning it to a default.

`PostgresProducer` does not create a pool and does not run migrations. The
application owns connection lifecycle. RhinoQ sends one parameterized
`SELECT rhinoq.enqueue(...)`; PostgreSQL enforces allowlists, payload limits,
schema identity, priority, class and idempotency.

### Transactional enqueue

Use the transaction's checked-out client, not the pool:

```ts
const connection = await pool.connect();
try {
  await connection.query('BEGIN');
  await connection.query(
    `INSERT INTO reports (id, status) VALUES ($1, 'queued')`,
    ['report_01'],
  );

  const transactionalProducer = new PostgresProducer({
    query: (text, values) => connection.query(text, values),
  });
  await transactionalProducer.enqueue({
    name: 'generate-report',
    payload: { reportId: 'report_01' },
    idempotencyKey: 'report:report_01',
    correlationId: 'report_01',
  });

  await connection.query('COMMIT');
} catch (error) {
  await connection.query('ROLLBACK');
  throw error;
} finally {
  connection.release();
}
```

The report and job now commit or roll back together.

### `PostgresProducer` reference

Constructor:

```ts
const producer = new PostgresProducer(executor, {
  maxPayloadBytes: 1_048_576,
});
```

| Argument | Meaning |
|---|---|
| `executor.query(text, values)` | minimal interface implemented by `pg.Pool` and `pg.PoolClient` |
| `maxPayloadBytes` | optional local fail-fast limit; PostgreSQL still enforces the allowlist limit |

`producer.enqueue(request)` accepts:

| Field | Required | Meaning |
|---|:---:|---|
| `name` | Yes | registered job/handler name |
| `payload` | Yes | JSON-serializable data; use references for large objects |
| `idempotencyKey` | No | deduplicates within the current job name |
| `correlationId` | No | connects the job to a business record or request |
| `priority` | No | integer from `-100` to `100` |
| `class` | No | `critical`, `interactive`, `standard`, `batch` or `maintenance` |
| `runAfterMs` | No | non-negative delay before the job becomes eligible |
| `payloadSchema` | No | application schema/version identity checked against the allowlist |

The promise resolves to the durable RhinoQ job ID. The method does not wait for
a worker or business outcome:

```text
enqueue resolved  = job intent committed
worker completed  = execution completed
outcome achieved  = declared business invariant passed
```

Common producer failures:

| Error | Meaning | Action |
|---|---|---|
| `RHINOQ_JOB_NOT_ALLOWED` | job name is absent from the allowlist | register the exact producer contract |
| `RHINOQ_JOB_FORBIDDEN` | current database role cannot produce the job | use the intended producer role |
| `RHINOQ_PAYLOAD_TOO_LARGE` | encoded JSON exceeds the server limit | store the body elsewhere and enqueue a reference |
| `RHINOQ_PAYLOAD_SCHEMA_MISMATCH` | caller and allowlist schema identities differ | deploy compatible producer/schema versions |
| local `TypeError`/`RangeError` | request is not serializable or violates local bounds | fix the request before retrying |

## Run handlers in Node.js

Start the optional Gateway after migrations:

```bash
export RHINOQ_DATABASE_URL='postgres://...'
export RHINOQ_AGENT_TOKEN="$(openssl rand -hex 32)"
go run ./cmd/rhinoq-agent
```

PowerShell:

```powershell
$env:RHINOQ_DATABASE_URL = 'postgres://...'
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$env:RHINOQ_AGENT_TOKEN = [Convert]::ToBase64String($bytes)
go run ./cmd/rhinoq-agent
```

This process:

- listens on `127.0.0.1:8080` by default;
- uses the built-in `pgx` driver;
- refuses to start without authentication unless local development explicitly
  sets `RHINOQ_AGENT_ALLOW_UNAUTHENTICATED=true`;
- exposes `/health/live`, `/health/ready` and `/metrics`;
- contains no user handler code and does not run an LLM.

Check it before starting a worker:

```bash
curl -H "Authorization: Bearer $RHINOQ_AGENT_TOKEN" \
  http://127.0.0.1:8080/health/ready
```

PowerShell:

```powershell
Invoke-RestMethod `
  -Headers @{ Authorization = "Bearer $env:RHINOQ_AGENT_TOKEN" } `
  -Uri 'http://127.0.0.1:8080/health/ready'
```

In the Node application, map the server variables to client variables:

```bash
export RHINOQ_GATEWAY_URL='http://127.0.0.1:8080'
export RHINOQ_GATEWAY_TOKEN="$RHINOQ_AGENT_TOKEN"
```

`RHINOQ_GATEWAY_URL` and `RHINOQ_GATEWAY_TOKEN` are names used by the example
application. The Gateway process itself reads `RHINOQ_AGENT_*`.

Then register handlers:

```ts
import {
  RhinoQClient,
  RhinoQWorker,
  dependencyDown,
} from '@rhinoq/node';

const client = new RhinoQClient({
  url: process.env.RHINOQ_GATEWAY_URL!,
  token: process.env.RHINOQ_GATEWAY_TOKEN,
});

const worker = new RhinoQWorker({
  client,
  name: `reports-${process.pid}`,
  concurrency: 4,
  onError: console.error,
});

worker.handle<{ reportId: string }>('generate-report', async (job) => {
  try {
    await reports.generate(job.data.reportId, { signal: job.signal });
  } catch (error) {
    throw dependencyDown(error);
  }
});

const stopping = new AbortController();
process.once('SIGTERM', () => stopping.abort());
process.once('SIGINT', () => stopping.abort());
await worker.run({ signal: stopping.signal });
```

The worker:

- negotiates the protocol before claiming;
- sends the exact registered handler names with every claim;
- never executes an unknown job name;
- renews fenced leases and surfaces cooperative cancellation;
- stops claiming before graceful shutdown;
- reports native errors using language-neutral retry classes.

The Go engine still decides ordering, retry delay, terminal state and Effect
Ledger transitions.

### `RhinoQWorker` reference

Constructor options:

| Option | Default | Meaning |
|---|---:|---|
| `client` | required | connected `RhinoQClient` or compatible Gateway |
| `name` | required | stable, unique process identity written into leases |
| `concurrency` | `4` | maximum handlers running concurrently |
| `maxClaimBatch` | `50` | hard cap for one claim; actual claim follows free slots |
| `leaseForMs` | `60000` | lease duration requested from the Gateway |
| `heartbeatIntervalMs` | negotiated | renewal interval; must be shorter than the lease |
| `pollIntervalMs` | `100` | shortest idle wait |
| `maxPollIntervalMs` | `2000` | maximum idle backoff |
| `shutdownGraceMs` | `30000` | time for handlers to finish before cancellation |
| `cancelGraceMs` | `10000` | time for handlers to react to cancellation |
| `onError` | none | observer for non-fatal worker/runtime errors |

Public worker methods:

| Method | Purpose |
|---|---|
| `handle(name, handler)` | register one handler before `run()`; duplicates and more than 256 names are rejected |
| `run({ signal })` | negotiate protocol and process jobs until aborted |
| `stop()` | stop claiming and begin graceful shutdown |

The handler receives `NodeJob<T>`:

| Property/method | Meaning |
|---|---|
| `id`, `name`, `attempts`, `correlationId` | execution metadata |
| `data` | lazily decoded JSON payload |
| `rawPayload` | original UTF-8 bytes |
| `signal` | cooperative cancellation signal; pass it to supported I/O calls |
| `effect(request, run)` | execute one declared external effect through the ledger |

Do not call `worker.run()` twice or register handlers after it starts.

## Classify failures explicitly

```ts
import {
  dependencyDown,
  permanent,
  rateLimited,
  transient,
} from '@rhinoq/node';

throw transient(error);
throw dependencyDown(error);
throw rateLimited(error, retryAfterMs);
throw permanent(error);
```

| Helper | Meaning |
|---|---|
| `transient(error)` | temporary application/transport failure; normal retry policy may apply |
| `dependencyDown(error)` | a required downstream dependency is unavailable |
| `rateLimited(error, retryAfterMs)` | downstream rejected the rate; delay must be a positive number |
| `permanent(error)` | retrying the same payload cannot succeed |
| `cancelled(error)` | cooperative cancellation, not an application failure |
| `classify(error, retryClass, retryAfterMs?)` | low-level form for adapters that already have a language-neutral class |

An ordinary thrown error is `unknown`. RhinoQ retries it cautiously and then
parks it instead of inferring semantics from a JavaScript stack trace.

## External effects

```ts
await job.effect({
  name: 'create-video',
  key: `video:${job.data.videoId}`,
  confirm: 'external-signal',
}, async () => {
  const accepted = await provider.createVideo(job.data.videoId);
  return {
    reference: accepted.requestId,
    value: accepted,
  };
});
```

`external-signal` leaves the ledger pending until application/provider evidence
confirms it. A returned `202 Accepted` is not treated as an achieved business
outcome. When the provider webhook has been authenticated and its event has
been verified, record that evidence explicitly:

```ts
await client.confirmEffect(jobId, {
  name: 'create-video',
  key: `video:${videoId}`,
  reference: providerEvent.id,
});
```

Do not call `confirmEffect` merely because a request was accepted. The
application owns provider authentication and decides what event constitutes
proof.

Confirmation policies:

| Policy | When the ledger confirms | Use when |
|---|---|---|
| `on-return` | the callback returns successfully | the returned value itself proves completion |
| `external-signal` | authenticated application/provider evidence calls `confirmEffect` | provider first returns an accepted/processing response |
| `verify` | a verifier proves the effect later | completion must be read back from a source of truth |
| `predicate` | the callback's returned `reference` exactly equals `completedStatus` | a synchronous provider exposes one stable completed status value |

Effect request fields:

| Field | Required | Meaning |
|---|:---:|---|
| `name` | Yes | stable effect name inside the job |
| `key` | Yes | idempotency identity reused across attempts |
| `irreversible` | No | marks this effect—not the whole job—as impossible to undo |
| `confirm` | No | confirmation policy; defaults to `on-return` |
| `completedStatus` | For `predicate` | exact value compared with the callback's returned `reference` |

`irreversible` belongs to this individual effect. It is not inherited from a
whole job profile.

The callback must return:

| Return field | Meaning |
|---|---|
| `reference` | stable provider/evidence reference; also the value tested by `predicate` |
| `value` | application value returned from `job.effect()` to the handler |

If the same effect is already confirmed, RhinoQ does not execute the callback
again and `job.effect()` resolves to `undefined`. The handler must therefore
not rely on the callback's return value as its only durable business state.

## Operate from Node.js

```ts
const counts = await client.counts('generate-report');
const jobs = await client.listJobs({
  queue: 'generate-report',
  states: ['pending', 'blocked', 'dead'],
  limit: 50,
});
const attention = await client.attention({ limit: 50 });

await client.pause('generate-report');
await client.resume('generate-report');
await client.cancel(jobs[0].id);

await client.replay(jobs[0].id, {
  actor: 'operator@example.com',
  reason: 'provider incident resolved and effects reviewed',
});
```

Replay remains guarded by effect state and writes a hash-chained audit record.
Payloads are intentionally absent from list/inbox responses.

### `RhinoQClient` reference

Create one client and reuse it:

```ts
const client = new RhinoQClient({
  url: 'http://127.0.0.1:8080',
  token: process.env.RHINOQ_GATEWAY_TOKEN,
  timeoutMs: 10_000,
});
```

| Option | Required | Meaning |
|---|:---:|---|
| `url` | Yes | Gateway base URL without an endpoint path |
| `token` | In authenticated mode | value sent as `Authorization: Bearer ...` |
| `timeoutMs` | No | per-request timeout, default `10000` |
| `fetch` | No | custom Fetch implementation for tests/instrumentation |

Producer and inspection methods:

| Method | Purpose | Mutates |
|---|---|:---:|
| `connect()` | negotiate and cache protocol compatibility | No |
| `handshake()` | force one handshake request | No |
| `enqueue(request)` | enqueue through HTTP; prefer `PostgresProducer` when direct SQL is available | Yes |
| `listJobs(query)` | list bounded payload-free job summaries | No |
| `counts(queue)` | count jobs by state | No |
| `attention(query)` | list Needs Attention items | No |
| `attempts(jobId, offset, limit)` | read append-only attempt evidence | No |
| `audit(jobId, offset, limit)` | read replay/operator audit entries | No |
| `findings(query)` | list persistent business-integrity Findings | No |

Operator methods:

| Method | Purpose | Important behavior |
|---|---|---|
| `pause(queue)` | stop future claims | running handlers continue |
| `resume(queue)` | allow claims again | does not force delayed jobs |
| `cancel(jobId)` | cancel eligible work or request cancellation from a leased handler | handler must honor its signal |
| `replay(jobId, { actor, reason })` | replay a guarded terminal job | refused while effects are unresolved/uncertain |
| `transitionFinding(key, transition)` | record a Finding lifecycle decision | exact invariant version is required |
| `confirmEffect(jobId, effect)` | record verified external completion evidence | never use for request acceptance alone |

Common request shapes:

| Method | Important fields |
|---|---|
| `enqueue(request)` | `name`, `payload`, optional `idempotencyKey`, `correlationId`, `priority`, `class`, `runAfterMs` |
| `listJobs(query)` | optional `queue`, `states`, `offset`, `limit` |
| `attention(query)` | optional `queue`, `offset`, `limit` |
| `findings(query)` | optional `ruleId`, `subjectType`, `subjectId`, `statuses`, `includeSuppressed`, `offset`, `limit` |
| `transitionFinding(key, transition)` | key: `ruleId`, `subjectType`, `subjectId`, `invariantVersion`; transition: `status`, `actor`, optional `reason`, `until` |
| `confirmEffect(jobId, effect)` | effect: `name`, `key`, verified `reference` |

Low-level runtime methods are public for SDK/runtime integration:

| Method | Purpose |
|---|---|
| `claim(worker, limit, leaseForMs?, queues?)` | claim a bounded batch and receive fenced lease tokens |
| `heartbeat(lease, extendMs?)` | renew ownership and observe cancellation |
| `complete(lease)` | mark a successfully handled lease complete |
| `release(lease)` | return unexecuted work without reporting handler success |
| `fail(lease, queue, error, options?)` | submit a language-neutral failure class and optional retry hint |
| `effect(lease, request, run)` | execute the Effect Ledger begin/run/resolve protocol |

Application code should normally use `RhinoQWorker`, which keeps claim,
heartbeat, fencing and shutdown semantics together.

`RhinoQError` exposes:

| Property | Meaning |
|---|---|
| `code` | stable RhinoQ error code |
| `retryable` | whether transport/runtime retry is allowed |
| `retryAfterMs` | optional server backoff |
| `status` | HTTP status when a response was received |

Do not retry every `RhinoQError`. In particular, lease loss and an uncertain
effect require the worker/operator to stop and inspect evidence.

## Run the complete Node flow

Use separate terminals so each long-lived process remains visible.

### Terminal 1 — prepare PostgreSQL

```bash
export RHINOQ_DATABASE_URL='postgres://postgres:postgres@localhost:5432/app'
rhinoq migrate apply
rhinoq doctor
```

Register `generate-report` in `rhinoq.job_allowlist` through your migration,
`psql` or database administration tool.

### Terminal 2 — start the Gateway

```bash
export RHINOQ_DATABASE_URL='postgres://postgres:postgres@localhost:5432/app'
export RHINOQ_AGENT_TOKEN='development-only-rhinoq-token-00000000000000000000'
go run ./cmd/rhinoq-agent
```

Keep this process running.

### Terminal 3 — start the Node worker

```bash
export RHINOQ_GATEWAY_URL='http://127.0.0.1:8080'
export RHINOQ_GATEWAY_TOKEN='development-only-rhinoq-token-00000000000000000000'
node worker.mjs
```

The worker is expected to stay running. Stop it with `Ctrl+C`; its abort signal
starts graceful shutdown.

### Terminal 4 — enqueue and inspect

The direct producer needs the application's database URL:

```bash
export DATABASE_URL='postgres://postgres:postgres@localhost:5432/app'
node producer.mjs
rhinoq jobs list --queue generate-report
rhinoq attention
```

The repository example generates a new report ID when no argument is supplied.
Run `node producer.mjs report_01` twice to verify that the same idempotency key
returns the original job ID instead of creating duplicate work.

Expected lifecycle:

```text
producer prints "enqueued job_..."
worker prints the report id
jobs list eventually shows succeeded
attention stays empty unless execution/evidence needs a decision
```

`DATABASE_URL` is read by the example producer. `RHINOQ_DATABASE_URL` is read
by the Go CLI/Gateway. They may contain the same value, but keeping the names
explicit prevents a library from silently taking ownership of application
configuration.

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `Cannot find package '@rhinoq/node'` | tarball is not installed in the target app | run `npm pack` in `sdks/node`, then install the absolute `.tgz` path |
| `rhinoq.enqueue does not exist` | migrations are missing | run `rhinoq migrate plan/apply` against the same database |
| `RHINOQ_JOB_NOT_ALLOWED` | job name is not registered | add an allowlist row using a reviewed migration |
| `RHINOQ_JOB_FORBIDDEN` | database role does not match `producer_role` | use/grant the intended producer role |
| `permission denied for schema rhinoq` | producer lacks the SQL function boundary grants | grant schema `USAGE` and function `EXECUTE`, never direct queue-table writes |
| Gateway refuses to start | no authentication mode was selected | set `RHINOQ_AGENT_TOKEN`; unauthenticated mode is local-only |
| `RHINOQ_GATEWAY_UNREACHABLE` | URL, port or process is wrong | check Gateway logs and `/health/ready` |
| `RHINOQ_UNAUTHORIZED` | worker/client token differs from server token | map `RHINOQ_GATEWAY_TOKEN` to `RHINOQ_AGENT_TOKEN` |
| worker runs but claims nothing | handler name, pause, delay or schema differs | inspect `jobs list`, queue state and exact `worker.handle()` name |
| `RHINOQ_LEASE_LOST` | this execution no longer owns the job | stop effects and let the current owner/reaper decide |
| effect remains pending | confirmation policy requires later evidence | authenticate the provider signal, then call `confirmEffect` |
| process never exits | a handler ignored cancellation | pass `job.signal` into supported I/O and bound application cleanup |

## Performance guidance

- Reuse the application's existing pool; never open a connection per enqueue.
- Prefer transactional SQL enqueue over an HTTP round trip for Node producers.
- Keep payloads small and enqueue references to large objects.
- Start worker concurrency from the downstream dependency budget, not CPU
  count alone.
- A worker claims only registered job names, reducing unnecessary row locks.
- Increase concurrency and claim batch only after measuring PostgreSQL,
  provider limits and job duration together.

RhinoQ publishes no Node throughput number until the benchmark harness is
reproducible.

## Current limitations

- Every published version is a prerelease. The beta.24 release workflow uses
  `next`; `latest` may remain on an older release. Use `next` only after the
  workflow succeeds, and pin an exact version in anything that must not move
  under you.
- The package ships an ESM and a CommonJS entry point, verified from a clean
  install of the packed tarball in both module systems.
- Express and Fastify have request adapters (`createNodeTaskMiddleware`,
  `registerFastifyTaskRoutes`). NestJS lifecycle wiring ships from
  `@rhinoq/node/nest`; `RhinoQModule.forBullMQAsync()` uses the same preset,
  injectable providers and lifecycle hooks as the framework-neutral path.
- Node workers for the native RhinoQ runtime require the HTTP Gateway; embedded
  Task management does not.
- A BullMQ `runtimeScope` has one projector owner. Duplicate bridges fail fast
  in one process; use `PostgresProjectorLease` for cross-process ownership.
- `TaskReconciler` is a timer in one process, not a distributed scheduler. The
  standard preset gives it a PostgreSQL advisory lease; custom construction
  must supply equivalent ownership when several replicas share a scope.
- The full Go profile and embedded Node Task profile both enforce PostgreSQL RLS
  and authorization boundaries. Node binds one tenant to each PostgreSQL pool;
  owner/tenant predicates remain defense in depth and it does not duplicate the
  Go operator-role model.
  confirmation-deadline scheduler yet; the application authenticates evidence
  and calls `confirmEffect`.
- Python, Java and .NET SDKs are not implemented.
