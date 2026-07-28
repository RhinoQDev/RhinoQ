# RhinoQ for Node.js

Node.js support has two deliberately separate paths:

- `PostgresProducer` enqueues through the application's existing PostgreSQL
  connection. It needs no Gateway and can join the application's transaction.
- `RhinoQWorker` runs Node handlers through the optional RhinoQ HTTP Gateway.
  The Go engine remains responsible for ordering, leases, fencing, retries and
  Effect Ledger transitions.

This package is a development preview and is not published to npm yet.
The preview targets ESM on Node.js 22+.

## Producer-only

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

Pass a checked-out `PoolClient` instead of the pool when the business write and
job must commit atomically.

## Node worker

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

The worker sends its registered job names with every claim. It cannot take work
for a handler it does not own. On shutdown it stops claiming, keeps heartbeats
alive during the grace period, then cooperatively aborts handlers that overrun.

See [`docs/nodejs.md`](../../docs/nodejs.md) for setup, transactions, error
classification, effects and operational commands.
