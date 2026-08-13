# Task application compiler

`defineRhinoQApplication()` turns one typed registry into the application-facing
parts that are safe to derive: dispatchers, registered worker handlers, Task
metadata and the complete HTTP product surface. It is a composition compiler,
not another queue engine; the Go engine and selected runtime adapters still own
leases, retries, reconciliation and legal state transitions.

```ts
import { defineRhinoQApplication } from '@rhinoq/node';

// A configured BullMQ, SQS or custom dispatch-capable runtime adapter.
const runtime = reportsRuntimeAdapter;
export const rhinoq = defineRhinoQApplication({
  profile: { name: 'reports', adapters: [runtime] },
  tasks: (task) => ({
    exportReport: task({
      name: 'report.export',
      retry: { mode: 'runtime', maxAttempts: 3 },
      run: async ({ reportId }: { reportId: string }, { progress }) => {
        await progress(0, 1, 'Generating report');
        return { url: await generateReport(reportId) };
      },
      result: ({ url }) => ({ ref: url, mediaType: 'application/pdf' }),
    }),
  }),
});
```

Fan-out and external-effect recipes keep the safety-sensitive difference visible:

```ts
tasks: (task) => ({
  resizeImages: task.batch({
    name: 'image.resize', maxItems: 500,
    run: async ({ imageId, width }, context) => resize(imageId, width, context.progress),
  }),
  sendWebhook: task.external({
    name: 'webhook.send',
    effect: { idempotency: 'provider', confirmation: 'readback' },
    run: async (input) => provider.send(input),
  }),
})
```

`dispatchBatch()` assigns stable execution and idempotency identity from the
Task ID plus each unique `itemKey`, enforces `maxItems` before dispatch, and
dispatches in deterministic order. Cross-runtime fan-out is not claimed atomic:
if a provider fails partway, already reserved items remain visible for recovery.

Delayed and priority dispatch are portable only when the adapter advertises
that it applies them. Unsupported adapters fail before reserving an Execution:

```ts
task({
  name: 'report.export',
  execution: { delayMs: 30_000, priority: 2 },
  run: exportReport,
})
```

BullMQ applies both fields. An application-owned SQS sender must explicitly
declare which policy it implements. Concurrency and queue-wide rate limits stay
engine/worker configuration rather than silently becoming per-Task promises.

One-off scheduling does not need a cron subsystem:

```ts
await application.tasks.exportReport.dispatchAfter(request, 30_000);
await application.tasks.exportReport.dispatchAt(request, '2026-08-14T09:00:00Z');
```

Both methods compile to delayed dispatch and therefore keep the same adapter
capability check. `dispatchAt()` clamps a past timestamp to immediate dispatch.

Start it once and mount all standard routes at once:

```ts
const application = await rhinoq.start({
  pool,
  ownerFromNodeRequest: (request) => request.user.id,
  tenantFromNodeRequest: (request) => request.user.tenantId,
  http: { operatorToken: process.env.RHINOQ_OPERATOR_TOKEN! },
});
server.use(application.http!);

await application.tasks.exportReport.dispatch({
  id: crypto.randomUUID(), ownerId: user.id, payload: { reportId: 'monthly' },
});
```

TypeScript infers every input and output from the registry. `manifest()` is a
stable, serializable description suitable for tests, diagnostics and build
metadata. It contains no handler source or payload data.

The same registry removes the worker switch statement. Use
`application.workerHandlers()` when a runtime registers one processor per name,
or `application.workerHandler()` when one worker receives several Task names.
The router refuses an unknown name, and the selected declaration separately
checks its versioned envelope before running business code.

```ts
const worker = new Worker('reports', application.workerHandler(), connection);
```

## What the profile removes

The first adapter supplies the default `adapter`, `runtime` and `scope` for all
Tasks. A Task may override them only with an adapter registered by the same
profile. This removes repeated configuration without guessing which runtime an
application intended to use.

## Deliberate safety boundaries

- retry remains off unless the Task declares a bounded runtime policy;
- an external effect is rejected without idempotency and confirmation policy;
- authentication, owner/tenant identity and business result correctness remain
  application-owned;
- no source-directory scanning or runtime execution is used to discover Tasks;
  the explicit registry is deterministic and type-checked.

Use the existing React package for `RhinoQTaskList`, `RhinoQTaskDetail` and
`RhinoQProgress`; it consumes the mounted API with SSE and polling fallback.

NestJS can start and close the compiled application through one dynamic module.
It exports `RHINOQ_APPLICATION`, `RHINOQ_TASKS`, `RHINOQ_MANIFEST` and
`RHINOQ_HTTP` for injection:

```ts
RhinoQModule.forApplicationAsync({
  compiler: rhinoq,
  inject: [DatabasePool],
  useFactory: (pool) => ({
    pool,
    ownerFromNodeRequest: ownerFromRequest,
    http: { operatorToken: process.env.RHINOQ_OPERATOR_TOKEN! },
  }),
})
```

## Measure the reduction

```bash
npx rhinoq measure --before ./manual-implementation --after ./rhinoq-implementation
```

The report counts nonblank, noncomment consumer `.js`, `.ts`, `.tsx`, `.sql`
and `.go` source, split into frontend/backend/SQL/integration. Tests, generated
output, dependencies, builds and lockfiles are excluded. The command does not
run either application and does not claim reliability or production throughput.
