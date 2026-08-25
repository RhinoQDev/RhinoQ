# RhinoQ for Node.js

[npm](https://www.npmjs.com/package/@rhinoq/node) ·
[Repository](https://github.com/madebyduy/RhinoQ) ·
[Five-minute quickstart](https://github.com/madebyduy/RhinoQ/blob/main/docs/quickstart.md)

`@rhinoq/node` adds a durable Task product surface around background work.
Keep BullMQ, connect another runtime, or produce work for RhinoQ's native
PostgreSQL queue.

You get progress, attempts, cancellation, results, realtime updates, a Task
Center for users and a Workbench for operators. Your application keeps its
business handler, authentication and provider policy.

Latest verified npm prerelease: `v0.1.0-beta.22`.

> RhinoQ is a public beta for evaluation and controlled pilots. Pin the exact
> version for production-shaped testing.

## Try the product

```bash
npx rhinoq dev --demo
```

The demo is disposable and needs no infrastructure. For a real local
PostgreSQL profile:

```bash
npm install @rhinoq/node@next pg
npx rhinoq up --dry-run
npx rhinoq up
```

## Install

```bash
npm install @rhinoq/node@next pg
```

Requirements:

- Node.js 22 or 24;
- PostgreSQL 16 for the tested Task profile;
- `pg` supplied by the application;
- BullMQ only when the application chooses the BullMQ adapter.

S3, ZIP and other provider packages are optional peers. Do not install them
until you enable that capability.

## Choose one integration path

| Situation | Recommended API |
|---|---|
| New Node application or custom runtime | `defineRhinoQApplication()` / `createRhinoQApp()` |
| Existing BullMQ application | `rhinoq()` compatibility preset |
| Portable runtime adapter | `createRhinoQ()` |
| Node producer for native PostgreSQL workers | `PostgresProducer` |
| Owner-facing browser only | `TaskClient` or `TaskRunHandle` |

The higher-level path removes more application plumbing. Lower-level clients
exist for applications that must keep an existing HTTP contract.

For an existing repository, let the CLI select that path first:

```bash
npx rhinoq setup
npx rhinoq setup --runtime bullmq --mode single --apply
# or: npx rhinoq setup --runtime manual --apply
```

Preview writes nothing and prints the exact apply command. BullMQ requires an
explicit `single`/`fanout` choice; apply creates only missing files.

## Recommended application composition

Declare Tasks once, then start the application with its database, identity and
HTTP boundary:

```ts
import { defineRhinoQApplication } from '@rhinoq/node';

const definition = defineRhinoQApplication({
  profile: {
    name: 'reports',
    adapters: [runtimeAdapter],
  },
  tasks: (task) => ({
    exportReport: task({
      name: 'report.export',
      retry: { mode: 'runtime', maxAttempts: 3 },
      run: async ({ reportId }, context) => {
        await context.progress(0, 1, 'Generating report');
        const result = await generateReport(reportId);
        await context.progress(1, 1, 'Report ready');
        return result;
      },
      result: ({ url }) => ({
        ref: url,
        mediaType: 'application/pdf',
      }),
    }),
  }),
});

const app = await definition.start({
  pool,
  ownerFromNodeRequest,
  http: {
    operatorToken: process.env.RHINOQ_OPERATOR_TOKEN,
  },
});

await app.tasks.exportReport.dispatch({
  id: 'report-42',
  ownerId: user.id,
  payload: { reportId: '42' },
});
```

The declaration produces typed dispatchers, worker handlers and a static plan.
Retry defaults remain fail-closed; external effects need explicit application
policy.

See [Task application compiler](https://github.com/madebyduy/RhinoQ/blob/main/docs/application-compiler.md).

For split deployments, pass a process role to `createRhinoQApp`: `producer`,
`worker`, `api`, `operator`, or `all` (the compatible default). Only `worker`
and `all` subscribe to unsolicited runtime events, so an HTTP or producer
replica does not keep an unnecessary event connection open. This changes
process-local lifecycle only; PostgreSQL and the runtime remain authoritative.

Declared batches call an adapter's optional `dispatchMany()` fast path when it
exists. Existing adapters keep working through ordered `dispatch()` calls. A
batch item still needs a stable `itemKey` and idempotency key.

## Keep an existing BullMQ worker

Preview the integration first:

```bash
npx rhinoq connect --mode single
npx rhinoq connect --mode single --apply
```

Choose `single` when one BullMQ job is one Task. Choose `fanout` when several
jobs belong to one Task. `connect` delegates to the same lower-level adoption
planner exposed by `adopt`.

Then mount the compatibility preset:

```ts
import { rhinoq } from '@rhinoq/node';

const app = await rhinoq({
  pool,
  queue,
  events,
  ownerFromRequest: (request) => authenticatedUser(request).id,
});

server.use(app.http({
  operatorToken: process.env.RHINOQ_OPERATOR_TOKEN,
}));

await app.dispatch(taskId, items.map((item, index) => ({
  key: `item-${index}`,
  data: item,
})));
```

This mounts `/tasks`, `/task-center` and `/admin`. It also starts projection,
reconciliation and cancellation integration for the explicitly tracked jobs.
It does not scan Redis for unrelated work.

See the [complete BullMQ example](https://github.com/madebyduy/RhinoQ/tree/main/examples/fanout-bullmq).

## Connect another runtime

Use `createRhinoQ()` when the host supplies a runtime adapter:

```ts
import {
  PostgresTaskClient,
  createManualRuntimeAdapter,
  createRhinoQ,
} from '@rhinoq/node';

const adapter = createManualRuntimeAdapter('manual', 'reports');
const runtime = createRhinoQ({
  client: new PostgresTaskClient(pool),
  terminalProjection: 'single-execution',
  adapters: [adapter],
});

await runtime.track({ task, executionId, ref });
await runtime.start();
await adapter.emit({
  type: 'started',
  ref,
  occurredAt: new Date().toISOString(),
});
```

Adapters report capabilities. Unsupported cancellation fails before Task
mutation. Unknown runtime results remain unknown or `uncertain`; RhinoQ does
not turn them into success.

See the [manual runtime example](https://github.com/madebyduy/RhinoQ/tree/main/examples/manual-runtime).

## Adopt without taking runtime control

Use the native adoption pipeline for an existing application:

```bash
npx rhinoq adopt --plan --out .rhinoq/adoption-plan.json
npx rhinoq adopt --shadow --adapter custom --apply
```

The plan inventories handlers, producers, retry timers, cancellation code and
possible external effects. Shadow Mode observes the existing runtime without
owning dispatch or cancellation.

After collecting a real report:

```bash
npx rhinoq adopt --promote \
  --from .rhinoq/adoption-plan.json \
  --evidence .rhinoq/shadow-report.json \
  --approve '<reviewed-approval-key>'
```

Promotion is an evidence decision, not an automatic source rewrite. Read
[Native adoption](https://github.com/madebyduy/RhinoQ/blob/main/docs/native-adoption.md).

## Owner API and product surfaces

The standard composition exposes:

| Path | Purpose | Required boundary |
|---|---|---|
| `/tasks` | Task reads, results and safe user actions | authenticated owner and tenant |
| `/task-center` | end-user Task history and progress | same owner session |
| `/admin` | operator Workbench | explicit operator authorization |

Do not send storage references, runtime job IDs or operator credentials to the
owner API. Use `resolveResult`, `resolveArtifact`, `authorize` and tenant hooks
at the server boundary.

For a custom HTTP contract, use `app.tasks` or `PostgresTaskClient` and map the
snapshot yourself. That keeps your wire format but also keeps more application
code.

See [Two integration doors](https://github.com/madebyduy/RhinoQ/blob/main/docs/two-doors.md).

## Watch one Task in application code

`TaskRunHandle` combines the existing SSE/polling store with common actions:

```ts
import { TaskRunHandle } from '@rhinoq/node';

const run = new TaskRunHandle(ownerClient, taskId);
run.start();

const terminal = await run.wait({ timeoutMs: 60_000 });
console.log(terminal.state);

await run.cancel();
const result = await run.result();
```

It rejects unsafe URLs and does not invent an ETA. See
[TaskRunHandle](https://github.com/madebyduy/RhinoQ/blob/main/docs/task-run-handle.md).

## React

```tsx
import { RhinoQTaskView } from '@rhinoq/node/react';

export function ReportStatus({ taskId }) {
  return <RhinoQTaskView taskId={taskId} client={ownerClient} />;
}
```

The browser contract rejects stale entity versions and falls back to polling
when SSE disconnects. See [React UI](https://github.com/madebyduy/RhinoQ/blob/main/docs/react-ui.md).

## Files and artifacts

Enable artifact support only when a Task returns files:

```ts
const app = await createRhinoQApp({
  pool,
  adapters,
  ownerFromNodeRequest,
  artifacts: 's3',
});

const exportTask = app.task({
  name: 'report.export',
  run: async (input, context) =>
    context.output.pdf(await makePDFOnDisk(input)),
});
```

Install the AWS peer packages only for S3:

```bash
npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner
```

Storage credentials remain server-side. Read the
[artifact guide](https://github.com/madebyduy/RhinoQ/blob/main/docs/artifact-storage.md).

## External effects and retry safety

Queue retry is not enough protection for payments, refunds, messages or other
real-world mutations.

Use a stable application effect identity, an idempotency policy and a provider
confirmation/readback policy. When a provider may have accepted the request
but the response is lost, preserve `uncertain` and reconcile; do not retry
blindly.

Read [Provider operations](https://github.com/madebyduy/RhinoQ/blob/main/docs/provider-operations.md)
and [Failure semantics](https://github.com/madebyduy/RhinoQ/blob/main/docs/failure-semantics.md).

## Terminal operations

Workbench is optional for routine observation:

```bash
npx rhinoq watch --severity warning
npx rhinoq inspect <task-id>
npx rhinoq open <task-id>
```

`watch` groups repeated symptoms and uses authoritative database reads with a
polling fallback. `inspect` uses the same operator projection as Workbench.

For unattended incidents, configure reviewed notification routes:

```bash
npx rhinoq notify add ops \
  --kind slack \
  --url-env RHINOQ_NOTIFY_URL_OPS \
  --minimum-severity high
```

Real Finding delivery remains on the Go-owned durable delivery boundary.

## Package entry points

| Import | Use |
|---|---|
| `@rhinoq/node` | server composition, Tasks, runtime and CLI contracts |
| `@rhinoq/node/browser` | browser-safe clients |
| `@rhinoq/node/react` | React hooks and components |
| `@rhinoq/node/bullmq` | explicit BullMQ adapter APIs |
| `@rhinoq/node/sqs` | SQS proof adapter |
| `@rhinoq/node/artifacts` | artifact providers |
| `@rhinoq/node/nest` | NestJS integration |
| `@rhinoq/node/openapi.json` | owner API OpenAPI 3.1 contract |

SST is an optional deployment adapter available through `@rhinoq/node/sst`.
It is not the RhinoQ runtime or integration golden path.

## Common commands

| Command | Purpose |
|---|---|
| `npx rhinoq dev --demo` | disposable UI demo |
| `npx rhinoq up` | real local PostgreSQL profile |
| `npx rhinoq connect` | preview existing-app integration |
| `npx rhinoq add task <name>` | preview a Task declaration |
| `npx rhinoq doctor` | validate database and runtime configuration |
| `npx rhinoq watch` | terminal Task stream |
| `npx rhinoq inspect <id>` | inspect one Task |

The complete command inventory is in the
[CLI reference](https://github.com/madebyduy/RhinoQ/blob/main/docs/cli.md).

## Read next

Choose only what you need:

- [Five-minute quickstart](https://github.com/madebyduy/RhinoQ/blob/main/docs/quickstart.md)
- [Node.js integration](https://github.com/madebyduy/RhinoQ/blob/main/docs/nodejs.md)
- [Task API](https://github.com/madebyduy/RhinoQ/blob/main/docs/task-api.md)
- [Realtime](https://github.com/madebyduy/RhinoQ/blob/main/docs/realtime.md)
- [Native PostgreSQL queue](https://github.com/madebyduy/RhinoQ/blob/main/docs/postgres-queue.md)
- [Production checklist](https://github.com/madebyduy/RhinoQ/blob/main/docs/production-checklist.md)
- [Known limits](https://github.com/madebyduy/RhinoQ/blob/main/docs/production-readiness.md)
