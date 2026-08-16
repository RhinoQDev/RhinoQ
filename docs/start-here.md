# Start here: from an async job to a user-visible Task

This is the one-page guide for evaluating and integrating RhinoQ. It starts
with the async-task experience most applications need, then continues into the
harder case where a technically green job did not produce the expected outcome.

If you only want the shortest copy/paste first run, use the
[five-minute quickstart](./quickstart.md) first and return here after it passes.

RhinoQ has two layers that you can adopt separately:

1. **Async Task Platform:** durable state, per-item attempts, progress,
   cancellation, reconciliation, owner API, Task Center and Workbench around
   work your application already runs. A portable adapter contract keeps this
   layer independent of the execution runtime; BullMQ is the deepest Node
   integration today, while manual/custom and SQS proof adapters exercise the
   same boundary.
2. **Verified Tasks:** evidence, Rules, Findings and guarded repair when queue
   completion is not enough proof.

The Task Platform can observe an existing runtime **or execute work through
RhinoQ's native PostgreSQL-backed Go queue**. If you do not already have a
queue, read the [PostgreSQL queue quickstart](./postgres-queue.md); BullMQ is an
adapter choice, not a prerequisite.

> RhinoQ is a prerelease for evaluation and controlled pilots. Pin the exact
> version shown below. Do not treat this guide as a production-readiness claim.

## First value: one connected async-task loop

Install the Node SDK into an existing application and start the Task layer. The
shortest concrete Node tour below uses the BullMQ preset; use the portable
adapter path in the [Node SDK guide](../sdks/node/README.md) for another
runtime:

```bash
npm install @rhinoq/node@next pg
npx rhinoq init
npx rhinoq adopt --mode single --apply
npx rhinoq doctor
npx rhinoq dev
```

You can watch progress, cancel queued work, open the owner-facing Task Center
and investigate retry history or attention states in the operator Workbench.
The application code uses the same shape you would put around an existing worker:

```js
const app = await rhinoq({ pool, queue, events, ownerFromRequest });
server.use(app.http({ operatorToken }));
await app.dispatch(taskId, items);
```

You still write the worker, payload and business retry policy. RhinoQ supplies
the lifecycle and product surfaces around them. If an existing frontend
contract cannot change, keep it and map `app.tasks` underneath instead; see
[the two integration doors](./two-doors.md) before measuring code savings.

## The incident that a green queue dashboard cannot close

Imagine a refund worker:

1. A customer asks for a refund.
2. BullMQ starts the job and the worker sends an idempotent request to Stripe.
3. Stripe creates the refund, but the response is lost on the network.
4. The worker cannot tell whether the request failed or the response was lost.
5. The order row still says `paid` because the application never received the
   response it expected.
6. Depending on the handler, the queue can eventually show `completed` even
   though the customer-visible state is still wrong.

At this point, every common shortcut is risky:

- retrying the mutation may repeat a real-world effect;
- marking the order refunded without checking Stripe may invent success;
- editing PostgreSQL manually has no precondition, approval or verification;
- searching queue logs tells you what code ran, not what now exists at Stripe;
- waiting for a customer complaint makes the customer the monitoring system.

RhinoQ keeps three facts separate:

```text
Execution: BullMQ completed the handler
ProviderOperation: Stripe accepted, confirmed, failed, or remains uncertain
Business outcome: the order invariant passes, fails, or is still unknown
```

It then supports this operator loop:

```text
detect -> investigate -> decide -> repair -> verify
```

The important word is **verify**. RhinoQ does not turn a timeout into failure,
does not retry an unknown external mutation blindly, and does not let its
browser run arbitrary SQL.

## What problem RhinoQ solves

RhinoQ is useful when technical execution and the real-world outcome can
diverge:

| Failure | What the runtime can know | What RhinoQ adds |
|---|---|---|
| provider accepted a request but the response was lost | the call timed out | durable `uncertain` state, read-back and evidence |
| a job completed but its database projection is stale | the handler returned | a business Rule and persistent Finding |
| a provider returned `202 Accepted` | the request was accepted | separate accepted and confirmed states |
| a 1,000-item fan-out partially completed | individual job states | one light Task summary plus paginated Executions |
| an operator knows how to repair the state | a manual runbook exists | preview, precondition, four-eyes approval, callback and re-verification |
| a regression is visible only in a dashboard | the dashboard has a row | signed webhook or Slack delivery with deduplication |

RhinoQ is **not** a promise of exactly-once external side effects. Provider
idempotency, authenticated webhooks and provider read-back are still required.

## What established products already do well

RhinoQ does not enter an empty category. This comparison is about product
boundaries, not benchmark superiority.

| Product | Use it for | Where RhinoQ can complement it |
|---|---|---|
| [BullMQ](https://docs.bullmq.io/) | Redis queues, workers, retries, events, progress and job operations | verify that a completed job produced the intended provider and business outcome |
| [Temporal](https://docs.temporal.io/) | crash-proof durable workflows that resume after infrastructure failures | add outcome verification only if the workflow does not already model the required business evidence and recovery |
| [Restate](https://docs.restate.dev/tour/workflows) | durable services/workflows, idempotency, signals, sagas and execution traces | overlay an existing queue without first moving handlers into a new durable runtime |
| [Inngest](https://www.inngest.com/docs/guides/error-handling) | event-driven functions, step retries and run traces | distinguish a successful run from a wrong external/business outcome in an existing system |
| [Trigger.dev](https://trigger.dev/docs/how-it-works) | durable background tasks, retries, checkpoints and a hosted run dashboard | preserve the current worker/runtime while adding evidence and guarded repair |
| [Sentry](https://docs.sentry.io/product/issues/) | application errors, traces and issue triage | detect a green execution whose final business state is wrong, where no exception exists |

The RhinoQ position is:

> Keep the runtime that executes work. Add the durable Task experience around
> it now, then add outcome verification where technical completion is not enough.

This is also why the Workbench is not marketed as a better generic queue
dashboard. BullMQ, Temporal, Restate, Inngest and Trigger.dev already have
strong execution views. RhinoQ's view is organized around `Execution !=
ProviderOperation != Outcome`, the evidence behind that distinction, and safe
recovery.

### Do not add RhinoQ when

- all work is database-local and one application transaction already proves
  the result;
- a missed outcome has no user, financial, operational or compliance cost;
- your durable workflow already models provider confirmation, business
  invariants, evidence, compensation and operator approval well;
- you only need a prettier BullMQ job table;
- you need a hosted, multi-tenant control plane today. RhinoQ Workbench is
  loopback-only and tenant-wide RBAC is not complete.

## Choose the shortest path for your goal

| Your goal | Start here | What it proves |
|---|---|---|
| understand the full product story | [official Docker demo](#run-the-full-stripe-shaped-failure) | completed -> uncertain -> Finding -> approved repair -> verified |
| add user-facing Task status to Node/PostgreSQL | [five-minute Node tour](#take-the-five-minute-node-tour) | Task schema, health check and local Task Workbench |
| integrate a non-BullMQ runtime | [Node adapter contract](../sdks/node/README.md) | portable lifecycle, inspection and capability semantics |
| keep an existing BullMQ worker | [BullMQ bridge](#connect-an-existing-bullmq-queue) | durable Task/Execution identity and lifecycle projection |
| protect an external provider call | [ProviderOperation](#protect-an-external-provider-operation) | idempotency identity, uncertainty and confirmation |
| inspect evidence and Findings | [Workbench](#open-the-dashboard) | local evidence, integrity and recovery interface |
| verify business tables without adopting a queue | [Integrity-only example](../examples/integrity-only/) | bounded Rules, Outcomes and Findings |
| use RhinoQ's optional Go runtime | [runtime operations](./operations.md) | PostgreSQL job execution with fencing and recovery |
| use PostgreSQL as the job queue | [PostgreSQL queue quickstart](./postgres-queue.md) | transactional enqueue, registered Go handlers, fenced leases and retry |

## Take the five-minute Node tour

This path is intentionally small. It creates the embedded Task support schema;
it does not install the full Rule, Finding, ProviderOperation or repair schema.
Use the Docker demo or full CLI migrations for those capabilities.

### 1. Prerequisites

You need:

- Node.js 22 or newer;
- PostgreSQL (16 is the version covered by the repository test matrix);
- a new or existing Node project;
- Docker only if you want the commands below to start PostgreSQL for you.

For a disposable local database:

```bash
docker run --name rhinoq-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=app \
  -p 5432:5432 \
  -d postgres:16-alpine
```

PowerShell uses backticks instead of backslashes:

```powershell
docker run --name rhinoq-postgres `
  -e POSTGRES_PASSWORD=postgres `
  -e POSTGRES_DB=app `
  -p 5432:5432 `
  -d postgres:16-alpine
```

Why: RhinoQ persists Task identity and versions; an in-process JavaScript map
would disappear on restart and could not converge across processes.

If port `5432` is already used, reuse your PostgreSQL instance or change the
left side of `-p`, for example `-p 55432:5432`.

### 2. Set the database address

macOS/Linux:

```bash
export DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/app'
```

PowerShell:

```powershell
$env:DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/app'
```

Why: the onboarding CLI accepts `DATABASE_URL` or
`RHINOQ_DATABASE_URL`. Using an environment variable keeps credentials out of
source files. Prefer `RHINOQ_DATABASE_URL` when the application already uses
`DATABASE_URL` for a different database.

### 3. Install the pinned SDK

```bash
npm install @rhinoq/node@0.1.0-beta.20 pg
```

Why: `pg` is a peer dependency and lets RhinoQ reuse the application's pool.
Pin the exact beta.20 package after the release workflow succeeds; before that,
install the beta.20 tarball built from this checkout as described in
[`docs/nodejs.md`](./nodejs.md). Older prerelease tags do not contain this
contract.

### 4. Initialize the Task profile

```bash
npx rhinoq init
```

Why: this creates `.rhinoq/config.json`, `.rhinoq/rules/`, and the isolated Task
tables in the `rhinoq_task` schema, including durable waitpoints. It detects `pg` and optional BullMQ. Existing
files are kept rather than overwritten.

If no database variable is set, `init` creates `.env.rhinoq.example`, skips the
schema and prints the next command. Set the variable and run `init` again.

### 5. Generate one business Rule template

```bash
npx rhinoq verify add completed-report-has-output
```

Why: queue state alone cannot prove that a completed report has an output. The
command creates `.rhinoq/rules/completed-report-has-output.sql` with the
required `subject_id`, `violated` and bounded `evidence` shape.

The generated SQL uses placeholder names `completed_reports` and `output_url`.
Edit them before real use and add an index that matches its filter/order. This
command generates a reviewable file with the canonical `$1` baseline, `$2`
cursor and `$3` result-limit bindings; it does not silently enable or schedule
a production Rule. The next step is available when the full Go Rule schema and
Gateway are running:

```bash
export RHINOQ_AGENT_URL='http://127.0.0.1:8080'
export RHINOQ_AGENT_TOKEN="$(openssl rand -hex 32)"
npx rhinoq verify apply completed-report-has-output --subject-type report
npx rhinoq verify run completed-report-has-output
```

`verify apply` validates and registers the file while leaving it disabled.
`verify run` performs one bounded evaluation, prints violated subjects and
evidence, then disables the Rule again. If the placeholder table or column is
wrong, the Go Explain boundary fails closed and prints the next action.

### 6. Run the health checker

```bash
npx rhinoq doctor
```

Why: this verifies PostgreSQL connectivity and confirms the Task schema version
matches the installed SDK. It also tells you whether `REDIS_URL` is present,
without requiring Redis for Task-only use. It lints local Rule files, warns when
the connected PostgreSQL role is a superuser and reports whether the full Rule
schema contains each local Rule.

If it reports a schema mismatch, run `npx rhinoq init` with the same database
variable and retry `doctor`.

### 7. Create the failure fixture

```bash
npx rhinoq fixture failure
```

Why: a new project has no real job yet. The `failure` fixture creates a Task
whose BullMQ-shaped Execution is `succeeded` while the real-world Task is
`uncertain`. It is sample data for learning, not a load generator. To see the
generic async control loop instead, run:

```bash
npx rhinoq fixture async
```

That fixture creates one completed step, one failed attempt and an expired
approval waitpoint. It is intentionally domain-neutral and is designed for the
Flight Recorder path below.

### 8. Open the local Task Workbench

```bash
npx rhinoq dev
```

Open <http://127.0.0.1:8788/rhinoq>. The command mounts the SDK's
self-contained Workbench: live state buckets, Task detail, item attempts,
server-side runtime references and an Async Flight Recorder that explains
uncertain, partial-failure and expired-waitpoint states. It binds only to
loopback, stays read-only and requires no frontend project, account, API token
or telemetry service.

Use a different port when needed:

```bash
npx rhinoq dev --port=8798
```

Press `Ctrl+C` to stop it. This is the Task-profile Workbench for onboarding;
the Go `rhinoq workbench` remains the full Verified Tasks Evidence Workbench
for Rules, Findings, effects and repair actions. See the [Async Flight Recorder
guide](./async-flight-recorder.md) for the normalized timeline and its security
boundary.

## Run the full Stripe-shaped failure

The official demo is the fastest way to see the complete value loop. It uses
Next.js, BullMQ, PostgreSQL 16, Redis, a Stripe-shaped local sandbox and the real
RhinoQ Go Gateway. It needs no Stripe key and spends no money.

From a clone of this repository:

```bash
cd examples/nextjs-bullmq-stripe
docker compose up --build -d
docker compose run --rm app npm run test:e2e
```

Why each command exists:

- `docker compose up --build -d` builds the exact local code and starts
  PostgreSQL, Redis, migrations, Next.js, the BullMQ worker and RhinoQ Gateway;
- `docker compose run --rm app npm run test:e2e` drives the failure and recovery
  through HTTP, then asserts that the provider is confirmed, the Task succeeds,
  the Finding resolves, the order is refunded and the repair succeeds.

Expected final output:

```text
PASS <order-id>: BullMQ completed -> uncertain -> confirmed -> approved repair -> verified
```

Open <http://localhost:53000> to run the same six stages manually and inspect
the state after every click:

1. **Break it**: enqueue the refund and lose the provider response.
2. Observe BullMQ `completed`, ProviderOperation `uncertain`, unchanged order
   state and an open Finding.
3. **Recheck Stripe**: read the already-created refund; do not mutate again.
4. **Propose** and **Dry-run**: capture the planned change and stable order
   version.
5. **Approve**: a different actor records a reason.
6. **Repair + verify**: call the allowlisted signed application callback,
   re-read the result and resolve the Finding only when verification passes.

Inspect service logs if a step fails:

```bash
docker compose ps
docker compose logs --tail=200 app worker agent migrate
```

Clean up when finished:

```bash
docker compose down -v
```

Why `-v`: it also removes the demo's disposable database volume. Do not use
that flag on a Compose project whose data you intend to keep.

## Open the dashboard

RhinoQ has two local visual surfaces:

| Surface | Command | Use it for |
|---|---|---|
| Task Workbench | `npx rhinoq dev` | first install and user-facing Task state |
| Workbench | `rhinoq workbench` | jobs, Needs Attention, Findings, Rules, attempts, effects, outcomes, audit and safe repair |

### Try Workbench without a database

Download the archive for your OS/CPU from the
[beta.20 release](https://github.com/madebyduy/RhinoQ/releases/tag/v0.1.0-beta.20),
extract it, place `rhinoq` (`rhinoq.exe` on Windows) on `PATH`, then run:

```bash
rhinoq version
rhinoq workbench --demo
```

Why `--demo`: it loads a built-in bounded dataset, binds to
`127.0.0.1:8787`, and opens the browser without PostgreSQL or configuration.
Use it to learn the Flow Lens, Evidence Rail, search, filters and keyboard
navigation. The demo does not mutate real data.

If you have Go installed, the equivalent repository command is:

```bash
go run ./cmd/rhinoq workbench --demo
```

### Open Workbench on a real RhinoQ database

macOS/Linux:

```bash
export RHINOQ_DATABASE_URL='postgres://user:pass@127.0.0.1:5432/app?sslmode=disable'
rhinoq migrate status
rhinoq migrate plan
rhinoq migrate apply
rhinoq doctor
rhinoq workbench
```

PowerShell:

```powershell
$env:RHINOQ_DATABASE_URL = 'postgres://user:pass@127.0.0.1:5432/app?sslmode=disable'
rhinoq migrate status
rhinoq migrate plan
rhinoq migrate apply
rhinoq doctor
rhinoq workbench
```

Why the sequence matters:

- `migrate status` is read-only and reports the current history;
- `migrate plan` is read-only and shows exactly what would change;
- `migrate apply` is the explicit schema write, protected by checksums and an
  advisory lock;
- `doctor` exits non-zero if fencing, timing or schema checks do
  not pass;
- `workbench` starts only after the data contract is current.

Workbench opens the browser automatically. Use `--no-open` to print the URL,
`--port 0` to choose a free port, or `--queue refunds` to start with a queue
filter. It never binds to a public interface and omits job payloads.

### Enable safe actions deliberately

Workbench is read-only by default. Recheck and repair appear only with:

```bash
rhinoq workbench --actions
```

Repair also requires an allowlisted application callback:

```json
{
  "order.mark-refunded": {
    "url": "https://app.example.com/internal/rhinoq/repair",
    "secret": "replace-with-at-least-32-random-bytes",
    "timeout": "10s"
  }
}
```

Store that JSON in `RHINOQ_REPAIR_CALLBACKS_JSON` in deployment configuration,
not in the browser. The callback receives an HMAC signature and the repair ID
as its idempotency key. If the callback is absent, unregistered or its
precondition changed, RhinoQ fails closed.

Read [the Workbench guide](./workbench.md) for filters, evidence fields,
keyboard controls and the same-origin security boundary.

## Connect an existing BullMQ queue

RhinoQ does not replace the application's Redis connection or worker. Preview
the wiring before it writes anything:

```bash
npx rhinoq adopt --mode single
npx rhinoq adopt --mode single --apply
```

`single` means one BullMQ job is the whole user-facing Task. Choose `fanout`
when a Task owns several jobs; the CLI never guesses this because the wrong
choice can terminate an aggregate on its first completed item. The generated
module passes the existing `Queue` and `QueueEvents` objects to the preset:

```ts
import { Queue, QueueEvents } from 'bullmq';
import { createBullMQIntegration } from '@rhinoq/node';

const queue = new Queue('reports', { connection });
const events = new QueueEvents('reports', { connection });

const rhinoq = await createBullMQIntegration({
  pool, queue, events,
  mode: 'single',
});
await rhinoq.start();

await rhinoq.bridge.dispatch({
  task: {
    id: 'report_42',
    type: 'report.generate',
    ownerId: 'user_7',
    definitionVersion: 1,
  },
  executionId: 'report_42:attempt:1',
  jobId: 'report_42',
  job: {
    name: 'generate-report',
    data: { reportId: '42' },
  },
});
```

Why `dispatch()` instead of calling `queue.add()` first: RhinoQ reserves the
Task and Execution identity before Redis makes the job visible. Repeating the
same deterministic IDs after a partial outage converges instead of inventing a
second attempt.

Use `track()` only when the application already enqueued the job. Use
`dispatchMany()` for fan-out; it reserves the complete expected item set before
dispatching and bounds concurrent PostgreSQL/Redis operations. For fan-out,
choose `mode: 'fanout'` and select an explicit aggregate
policy—RhinoQ cannot guess whether one successful item makes the whole Task
successful.

The preset checks `attemptsMade` against the job's configured attempts before
treating a reconciled failure as terminal. Custom runtime observers must make
the same check. See [Node.js and BullMQ](./nodejs.md)
for cancellation, progress mapping, partial outage recovery and result refs.

## Protect an external provider operation

`ProviderOperation` requires the full RhinoQ Gateway because the Go core owns
the uncertainty and retry state machine. The application still owns provider
credentials, SDK version, request parameters and webhook authentication.

```ts
import { RhinoQClient, stripeProviderAdapter } from '@rhinoq/node';

const rhinoq = new RhinoQClient({
  url: process.env.RHINOQ_GATEWAY_URL!,
  token: process.env.RHINOQ_GATEWAY_TOKEN!,
});

const stripeOperation = stripeProviderAdapter({
  execute: (idempotencyKey) => stripe.refunds.create(
    { payment_intent: paymentIntentId },
    { idempotencyKey },
  ),
  retrieve: async (operation) => {
    // Find by the stored provider ID or application metadata/idempotency key.
    return lookupRefundWithoutCreatingAnotherOne(operation);
  },
  confirmedStatuses: ['succeeded'],
  failedStatuses: ['failed', 'canceled'],
});

const operation = await rhinoq.providerOperation({
  taskId: orderId,
  name: 'stripe.refund',
  idempotencyKey: `refund:${orderId}`,
  confirmation: 'readback',
  retryPolicy: 'when-not-happened',
  ...stripeOperation,
});
```

What happens:

1. Go reserves `(provider, operation, idempotencyKey)` before `execute` runs.
2. A successful mutation becomes `accepted`, then the adapter reads back.
3. A thrown timeout becomes `uncertain`, not `failed`.
4. Repeating the same call reads the stored operation; it does not blindly run
   the mutation again.
5. Retry is allowed only after confirmation proves `not_happened`.
6. Evidence is append-only and separate from the application's order mapping.

Use `confirmation: 'webhook'` when the provider completes asynchronously. The
authenticated webhook handler must translate verified provider evidence into a
confirmation; request acceptance alone is not proof of completion.

The package also exports `provisioningProviderAdapter` for storage buckets,
accounts and other resources with `ready`, intermediate and failed states.

### Transfers: "fetch from a CDN, put it in S3"

Stripe and provisioning both answer *did it happen?* from a status field the
provider maintains. A transfer has none. The only evidence is the destination
object, so `objectTransferProviderAdapter` confirms by reading it back:

```ts
import { objectTransferProviderAdapter } from '@rhinoq/node';

const transfer = objectTransferProviderAdapter({
  transfer: async (idempotencyKey) => {
    const source = await fetch(cdnURL);
    const body = Buffer.from(await source.arrayBuffer());
    const put = await s3.putObject({ Bucket, Key: destinationKey, Body: body });
    return { key: destinationKey, etag: put.ETag, size: body.byteLength, versionId: put.VersionId };
  },
  head: async () => {
    try {
      const found = await s3.headObject({ Bucket, Key: destinationKey });
      return { key: destinationKey, etag: found.ETag, size: found.ContentLength, versionId: found.VersionId };
    } catch (error) {
      if (error.name === 'NotFound') return undefined;
      throw error;
    }
  },
  // The source's own identity, read before the transfer runs.
  expected: async () => {
    const probe = await fetch(cdnURL, { method: 'HEAD' });
    return { etag: probe.headers.get('etag') ?? undefined, size: Number(probe.headers.get('content-length')) };
  },
});
```

What each readback concludes, and why:

| Destination | Decision | Reasoning |
|---|---|---|
| key is empty | `not_happened` | nothing to overwrite, so a retry is safe |
| identity matches `expected()` | `confirmed` | this operation's object is there |
| identity differs | **`failed`** | retrying would overwrite it, and an unversioned bucket cannot undo that |
| object present, nothing comparable | **`unknown`** | "something is at this key" is not proof this operation put it there |

That last row is the reason to supply `expected()`. Without it, a transfer that
failed halfway is recorded as a success because last week's file happens to sit
at the same path. Egress and request cost are real, so `unknown` stays unknown
rather than being optimistically retried.

Identity is compared strongest first: `versionId`, then `etag`, then `size`.
S3 quotes etags and appends a part count for multipart uploads; the adapter
normalises both, because a false mismatch means "do not retry" and would
strand real work.

Read [ProviderOperation](./provider-operations.md) before changing confirmation
or retry policy.

## Show Task state in an application UI

Poll a light summary for routine status and load Execution history only when a
user opens details:

```ts
const summary = await tasks.getTaskSummary('report_42');
const firstPage = await tasks.listTaskExecutions('report_42', '', 50);
const nextPage = firstPage.nextCursor
  ? await tasks.listTaskExecutions('report_42', firstPage.nextCursor, 50)
  : undefined;
```

Why: the compatibility `getTask()` Snapshot contains every Execution and grows
with fan-out. `getTaskSummary()` carries stored aggregate counts; cursor pages
keep browser responses bounded and stable while new attempts arrive.

For a mounted browser view, `TaskStore` serializes polls, rejects stale
versions, pauses when the tab is hidden and reconnects with bounded backoff:

```ts
import { TaskStore } from '@rhinoq/node';

const store = new TaskStore(applicationTaskClient, 'report_42');
const unsubscribe = store.subscribe(({ snapshot, status, error }) => {
  render({ snapshot, status, error });
});
store.start();

// On unmount:
unsubscribe();
store.stop();
```

Do not put the RhinoQ operator token in a browser. Expose the owner-scoped Task
handler behind the application's existing authentication, then use
`ApplicationTaskClient` from the browser. A zero-added-dependency React adapter
is available through `createUseRhinoTask(React)`.

## Feature map

| Capability | Use it when | Start with |
|---|---|---|
| Task + Execution | users need durable status across retries/runtimes | [Task guide](./getting-started.md) |
| BullMQ bridge | you want to keep Redis and current workers | [Node guide](./nodejs.md) |
| ProviderOperation | a provider timeout cannot safely mean failure | [provider guide](./provider-operations.md) |
| Rules + Outcomes | correctness can be expressed as a bounded database invariant | [Rules](./rules.md) |
| Findings | violations need deduplication, triage, suppression and regression history | [CLI](./cli.md) |
| Safe repair | an operator needs a controlled application-owned fix | [Safe repair](./safe-repair.md) |
| Webhook/Slack | a Finding must leave the dashboard | [Notifications](./notifications.md) |
| Workbench | developers/operators need one evidence timeline | [Workbench](./workbench.md) |
| TaskStore/React adapter | a customer-facing UI needs bounded polling | [Node guide](./nodejs.md) |
| Native Go runtime | the team wants a PostgreSQL execution backend too | [Operations](./operations.md) |

## Production checklist

For a go/no-go decision with pass criteria and conditional provider/runtime
requirements, use the [production checklist](./production-checklist.md). The
summary below is the minimum orientation for a controlled pilot.

Before a controlled pilot:

- pin an exact prerelease and verify its checksum/signature bundle;
- back up PostgreSQL and run a restore drill;
- use a restricted read-only database role for Rules;
- keep the Gateway private behind TLS, network policy and application auth;
- keep Workbench loopback-only; do not expose it as a hosted admin panel;
- define provider idempotency retention and confirmation deadlines;
- authenticate provider webhooks before recording evidence;
- register only bounded, allowlisted repair callbacks;
- choose evidence and execution retention based on dispute/audit windows;
- alert on unresolved `uncertain` operations and regressed Findings;
- test Redis/PostgreSQL/provider loss using the application's real deployment
  shape;
- do not claim tenant isolation until your integration supplies the missing
  tenant-wide authorization boundary.

Read [Production readiness](./production-readiness.md),
[Migration recovery](./migration-rollback.md) and [Retention](./retention.md).

## Troubleshooting

| Symptom | Meaning | Next action |
|---|---|---|
| `DATABASE_URL ... is not set` | the CLI does not know which PostgreSQL to use | export `DATABASE_URL` or `RHINOQ_DATABASE_URL`, then rerun the command |
| connection refused | PostgreSQL is stopped, wrong port is used, or Docker is not ready | run `docker ps`, check the port, then `npx rhinoq doctor` |
| Task schema version mismatch | SDK and database Task profile differ | run the pinned SDK's `npx rhinoq init` |
| generated Rule fails in PostgreSQL | placeholder table/column names remain | edit the SQL and test it with a restricted read-only role |
| `npx rhinoq dev` has no rows | no Task exists in this database | run `npx rhinoq fixture async` or point to the application database |
| Workbench cannot open its data source | full migrations are missing or URL is wrong | run `rhinoq migrate status`, `plan`, `apply`, then `doctor` |
| port already in use | another local service owns the port | use `npx rhinoq dev --port=8798` or `rhinoq workbench --port 0` |
| provider operation stays `uncertain` | RhinoQ has no proof of the real result | read back by provider ID/key or wait for an authenticated webhook; do not retry blindly |
| repair is unavailable | Workbench is read-only or handler is not registered | supply the callback allowlist and start with `--actions` |
| repair becomes `stale` | the business object changed after preview | investigate again and create a new plan; do not bypass the precondition |
| npm installs an unexpected version | during public beta both `latest` and `next` should resolve to the verified release | pin an exact version, for example `@rhinoq/node@0.1.0-beta.20`, and report the stale tag |

## Honest current limits

Implemented code and tests cover the contracts described above, but RhinoQ is
still a prerelease. Tenant-wide RBAC and deployment-shaped
design-partner/chaos evidence remain open. Durable multi-node notification
scheduling is implemented, but its deployment-shaped evidence is not yet
collected.
The Node Task Workbench has live SSE with polling fallback, but it is still a
local developer surface: it has no remote hosting/authentication. Tenant-wide
RBAC and deployment-shaped design-partner/chaos evidence remain open.
No throughput, latency or reliability comparison is claimed here.

## Research basis

The positioning in this guide was checked against primary product documentation
on 2026-08-01:

- BullMQ documents [idempotent job design](https://docs.bullmq.io/patterns/idempotent-jobs),
  [job getters and counts](https://docs.bullmq.io/guide/jobs/getters) and
  [metrics](https://docs.bullmq.io/guide/telemetry/metrics).
- Temporal documents [crash-proof durable execution](https://docs.temporal.io/).
- Restate documents [durable workflows](https://docs.restate.dev/tour/workflows),
  [Stripe-shaped external events and idempotency](https://docs.restate.dev/tour/microservice-orchestration)
  and [sagas](https://docs.restate.dev/guides/sagas).
- Inngest documents [step retries and error handling](https://www.inngest.com/docs/guides/error-handling)
  and [per-run traces](https://www.inngest.com/docs/platform/monitor/traces).
- Trigger.dev documents [durable task execution](https://trigger.dev/docs/how-it-works)
  and [idempotency keys](https://trigger.dev/docs/idempotency).

Those products are strong alternatives. RhinoQ should win only where keeping
the current execution system while adding explicit outcome evidence and guarded
recovery is materially simpler than migrating or rebuilding the controls in
application code.
