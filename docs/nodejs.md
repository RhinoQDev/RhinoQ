# Node.js integration

> Status: development preview. The SDK is tested in this repository but is not
> published to npm yet. Do not put `npm install @rhinoq/node` in production
> automation until a tagged package release exists.

RhinoQ supports JavaScript and TypeScript on Node.js 22+ through one package
with two separate integration paths. Choose the smaller path that solves the
actual problem.

| Need | Use | Extra process |
|---|---|---:|
| Add a job from Node.js | `PostgresProducer` | No |
| Commit a business row and job atomically | `PostgresProducer` with the current transaction client | No |
| Run handlers in Node.js | `RhinoQWorker` through the HTTP Gateway | Yes |
| Inspect or control work from Node.js | `RhinoQClient` | Yes |

The Gateway is deterministic Go infrastructure, not an AI agent. It does not
run a model or require an LLM.

## Evaluate the package from this repository

Until the first npm release, build and pack the preview locally:

```bash
npm --prefix sdks/node ci
npm --prefix sdks/node test
npm --prefix sdks/node pack
```

Install the generated tarball and the PostgreSQL driver in the Node
application:

```bash
npm install /path/to/rhinoq/sdks/node/rhinoq-node-0.1.0-dev.tgz pg
```

This source-install path is for evaluation. A versioned npm package and
prebuilt `rhinoq` CLI binaries remain release blockers.

## Prepare PostgreSQL once

The same checksum-tracked schema is used by Go and Node:

```bash
export RHINOQ_DATABASE_URL='postgres://postgres:postgres@localhost:5432/app'
rhinoq migrate plan
rhinoq migrate apply
rhinoq doctor --ci
```

Register every producer job name deliberately:

```sql
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

Do not grant one shared producer role access to every domain.

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

## Run handlers in Node.js

Start the optional Gateway after migrations:

```bash
export RHINOQ_DATABASE_URL='postgres://...'
export RHINOQ_AGENT_TOKEN='replace-with-a-long-random-secret'
go run ./cmd/rhinoq-agent
```

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

- The npm package and prebuilt CLI binaries are not released yet.
- The preview package is ESM-only; CommonJS/NestJS packaging is not committed
  until the framework integration is validated.
- Node workers require the HTTP Gateway; there is no native Node lease engine.
- NestJS integration and framework lifecycle hooks are not implemented.
- Gateway multi-tenant isolation and per-job HTTP RBAC are not complete.
- Async effect confirmation has no built-in webhook authentication or
  confirmation-deadline scheduler yet; the application authenticates evidence
  and calls `confirmEffect`.
- Python, Java and .NET SDKs are not implemented.
