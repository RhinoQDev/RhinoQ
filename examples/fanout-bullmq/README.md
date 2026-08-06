# Fan-out over BullMQ

A 50-item batch with live progress, an operator console, and one notification
when the batch finishes — fired exactly once, decided in SQL rather than by a
counter in the process.

Nothing here replaces BullMQ. The queue, the worker and the retry policy are
the application's; RhinoQ answers the question BullMQ does not: *did the work
actually finish, and which item did not?*

## Run it

```bash
docker compose up -d
npm install
RHINOQ_DATABASE_URL='postgres://postgres:rhinoq@127.0.0.1:55433/fanout' npm run migrate
npm start
```

Open <http://localhost:3000> and press the button. The operator console is at
`/admin/rhinoq` and expects the header `x-operator-token: let-me-in`.

Every batch fails one item in twelve on purpose, so the console has a real
failure to show rather than a wall of green.

## What each piece is doing

| File | Reason |
|---|---|
| `server.mjs` | the whole loop: API, worker, bridge, reconciler and both HTTP surfaces |
| `docker-compose.yml` | PostgreSQL on 55433 and Redis on 56379, so it collides with nothing |

Three tables are created in the `rhinoq_task` schema. No queue tables, no
worker tables, nothing touching your own.

## How much code this is

`server.mjs` is **the whole thing**: the API, the worker, the bridge, the
reconciler, both HTTP surfaces and an operator console. It uses RhinoQ's own
Task endpoint as the application's API rather than defining a second one, which
is the shorter of the [two doors](../../docs/two-doors.md) and the one a new
project can take. Building the same feature set on Postgres and BullMQ alone
takes about 500 lines and none of them are interesting.

## Four things this example exists to get right

**`itemKey` is the idempotency key.** Attempts are numbered per key and the
aggregate counts one item per key. Omit it on a fan-out and fifty items become
attempts 1..50 of a single item, the aggregate reads `total: 1`, and the batch
terminates on the first finish — silently, and irreversibly.

**`jobId` may not contain `:`.** BullMQ rejects a custom job ID containing one
unless it splits into exactly three parts, so the natural
`` `${taskId}:${itemKey}` `` is refused. `executionId` is RhinoQ's own identity
and is unaffected. The bridge now refuses such a job ID before reserving
anything, because dispatch writes the durable Execution *before* `Queue.add`.

**`isTerminalFailure` is required for a fan-out with retries.** Without it every
failure is treated as "the attempt may still retry", so the settled check never
runs after a failure — and a batch whose last item fails never settles at all.
Every item is terminal, every counter is correct, and the callback simply never
arrives. This example measured that before the warning existed: 46 succeeded, 4
failed, `items_settled_at` still null.

**Do not drive `queued` or `running` by hand.** `dispatchMany` ensures `queued`
and the bridge moves the Task to `running` when the first job goes active.
Setting them from the route races the projector and loses with
`RHINOQ_INVALID_TASK_TRANSITION`.

## Proving it finishes

```bash
RHINOQ_DATABASE_URL='postgres://postgres:rhinoq@127.0.0.1:55433/fanout' npm run smoke
```

`smoke` starts this server, pushes several batches through it, and exits
non-zero unless **every** item reached a terminal state, the Task reached one
too, and the settled signal fired **exactly once per batch**. It runs in two
shapes, because the two failure modes need opposite conditions:

| phase | jobs | what it is looking for |
|---|---|---|
| `instant` | zero-length, concurrency 16 | every job finishes while `dispatchMany` is still enqueueing. That window is where projections used to be lost, and the stuck items clustered at the front of the batch. |
| `realistic` | the normal timings | a BullMQ retry has room to happen, so the second attempt must actually be recorded as attempt 2. |

When a batch does not finish, it prints which items are stuck, what RhinoQ
believes about each, and the index range they fall in — the join that otherwise
has to be written by hand at the worst possible moment.

This runs on every CI build. It exists because this example used to hang on
roughly two runs in three and pass every manual review, the author's included:
a green run is not evidence about a race.

## Checking on it

```bash
RHINOQ_DATABASE_URL='postgres://postgres:rhinoq@127.0.0.1:55433/fanout' npm run doctor
```

`doctor` reads the running system, not the configuration: batches that stopped
moving, items all terminal while the Task is still open, attempts dispatched
but never observed, whether anyone holds a projector lease, and any recorded
projection failures.

## Deployment-shaped Redis restart evidence

The optional `chaos` script stops and restarts a disposable Redis container
while a BullMQ job is active, then verifies that the Task converges through the
same bridge and PostgreSQL Task profile. It never targets the example's normal
container unless you explicitly pass that container name; the required prefix
is `rhinoq-chaos-`.

```bash
docker run -d --name rhinoq-chaos-redis -p 6398:6379 redis:7-alpine
RHINOQ_DATABASE_URL='postgres://rhinoq:rhinoq@127.0.0.1:55432/rhinoq?sslmode=disable' \
REDIS_URL='redis://127.0.0.1:6398' \
RHINOQ_CHAOS_REDIS_CONTAINER='rhinoq-chaos-redis' npm run chaos
docker rm -f rhinoq-chaos-redis
```

This is process-restart evidence for one local Docker/PostgreSQL setup, not a
production reliability or throughput claim.

## Clearing up

```bash
docker compose down -v
```

Between runs, leftover BullMQ jobs from an interrupted run produce
`Missing lock for job …`. `docker exec <redis> redis-cli FLUSHALL` clears them.
