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

`plan()` is the canonical read-only projection when an operator or release
check needs more than the legacy manifest:

```ts
const plan = rhinoq.plan();
// plan.fingerprint: stable non-secret identity of the compiled plan
// plan.needsDecision: capacity/provider facts that were not proven
// plan.limitations: boundaries that remain application/provider-owned
```

Compilation is an explicit pure pipeline: `normalize → validate → link →
project`. `compileRhinoQPlanResult()` reports which phases completed or failed
alongside its structured diagnostics. None of the phases opens a database,
resolves credentials, provisions modules or starts runtime code.

The plan is deterministic and contains no credentials, handler source or
payload. Persist it explicitly when a release process needs a diff, then use
the read-only CLI flow:

```bash
npx rhinoq plan --from manifest.json --output .rhinoq/plan.json
npx rhinoq plan --from .rhinoq/plan.json
npx rhinoq plan validate --from .rhinoq/plan.json
npx rhinoq plan diff --from .rhinoq/plan.json --against .rhinoq/plan.previous.json
npx rhinoq doctor --plan-from .rhinoq/plan.json --plan-only
npx rhinoq dev --plan-from .rhinoq/plan.json
```

The CLI reads JSON artifacts only; it does not import arbitrary application
source or change runtime configuration. `needs-decision` is a deliberate
blocker for the validate command, not an inferred provider success.
These entry points call the same pure `runRhinoQCompilerWorkflow()` projection;
diff additionally reports deployment and capability-graph identity changes.
`doctor --plan-only` does not require PostgreSQL, while regular `doctor` keeps
its existing database/runtime checks after compiler validation. `dev` validates
the plan before opening the local Workbench.

Capability linking is also compile-time and read-only. A requirement resolves
to exactly one component; a missing required provider or multiple providers
fails closed. Bindings contain public scalar metadata, permission names and
secret references—never secret values:

```ts
const rhinoq = defineRhinoQApplication({
  profile,
  capabilityLinks: {
    components: [{
      id: 'storage/s3', version: 1, contractVersion: 1,
      provides: ['storage:artifacts'],
      binding: {
        properties: { region: 'ap-southeast-1' },
        secrets: { credential: { ref: 'secret://aws/rhinoq' } },
        permissions: ['s3:GetObject', 's3:PutObject'],
      },
    }],
    requirements: [{ capability: 'storage:artifacts', requiredBy: 'task:report.export' }],
  },
  tasks,
});
```

The resulting graph and its fingerprint are embedded in `manifest()` and
`plan()`. Provisioning, credential resolution and readiness remain explicit
application/module lifecycle operations; linking cannot run a provider or
mutate Task state.

Stages use a separate deployment identity:

```ts
const deployment = defineRhinoQDeployment({
  app: 'reports',
  stage: process.env.RHINOQ_STAGE ?? 'dev',
  region: 'ap-southeast-1',
});

defineRhinoQApplication({ profile, deployment, tasks });
```

`reports-dev` and `reports-pr-123` therefore have distinct deterministic
resource/evidence namespaces and plan fingerprints. Stage does not grant owner
or tenant access, does not contain credentials and does not change public Task
names. The current deployment boundary remains one tenant per Go Agent process.

When `start({ http })` is used, the same bounded manifest is available to the
operator Workbench's read-only [Plan Inspector](./plan-inspector.md) at
`/admin/api/plan`. It shows the factory marker, compiled runtime capsule and
data-path readiness; provider gaps remain explicit `needs-decision` values.

The same registry removes the worker switch statement. Use
`application.workerHandlers()` when a runtime registers one processor per name,
or `application.workerHandler()` when one worker receives several Task names.
The router refuses an unknown name, and the selected declaration separately
checks its versioned envelope before running business code.

```ts
const worker = new Worker('reports', application.workerHandler(), connection);
```

For the golden path, the compiler also accepts short capability factories:

```ts
tasks: (rhinoq) => ({
  exportReport: rhinoq.task('report.export', async ({ reportId }) => generate(reportId)),
  resizeImages: rhinoq.batch('image.resize', async (image, context) => resize(image, context.signal)),
  webVideo: rhinoq.media('video.web', async (video, context) => context.media.transcode(video, 'web')),
  capturePayment: rhinoq.effect('payment.capture', capture, {
    effect: { idempotency: 'provider', confirmation: 'readback' },
  }),
  nightly: rhinoq.schedule('report.nightly', runNightly, {
    schedule: { expression: '0 2 * * *', timezone: 'Asia/Ho_Chi_Minh' },
    resources: { timeoutMs: 30_000, workspaceBytes: 128 * 1024 * 1024, minDiskFreeBytes: 512 * 1024 * 1024, region: 'ap-southeast-1', codec: 'pdf' },
  }),
});
```

The aliases are metadata-bearing composition helpers, not a workflow DSL. They
compile a capability marker and a bounded execution/data-path plan into the manifest;
they do not guess retry, provider idempotency or business correctness. The
callable object form remains available for migration and advanced overrides.

`resources` and `schedule` are metadata, not a second scheduler or worker
policy engine. Plan Inspector shows timeout/concurrency/workspace/disk/GPU/
region/codec requirements and schedule expression. The Data Path Planner marks
missing disk or codec evidence as `needs-decision`; runtime admission must fail
closed when it cannot prove capacity. Scheduled occurrence creation remains the
Go/runtime scheduler's responsibility.

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
