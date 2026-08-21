# RhinoQ DX comparison source of truth

This page is the source of truth for product/website comparisons. It exists to
prevent a misleading comparison between a raw queue call and a full Task
platform. Every comparison must use the same workload, the same feature scope,
and a real package/API that exists in this repository.

## The positioning in one sentence

RhinoQ is not a faster replacement for BullMQ's queue primitives. It is the
shortest verified path for an existing worker team that needs a durable,
owner-facing Task contract, progress, history, realtime updates, evidence and
safe recovery without rewriting the handler.

When a team only needs a Redis queue, BullMQ is the better fit. The website must
say this plainly; trust in the comparison is part of the developer experience.

## The two valid golden paths

### Existing BullMQ worker: keep the runtime, add the Task surface

This is the comparison the website should show. The scope includes Task
identity, fan-out progress, attempt history, cancellation semantics, owner API,
Task Center, operator Workbench and reconciliation.

```ts
import { rhinoq } from '@rhinoq/node';

const app = await rhinoq({
  pool,
  queue: reportsQueue,
  events: reportsQueueEvents,
  ownerFromRequest: (request) => request.user.id,
});

server.use(app.http({ operatorToken: process.env.RHINOQ_OPERATOR_TOKEN! }));

await app.dispatch(taskId, items.map((data, index) => ({
  key: data.reportId ?? `item-${index}`,
  data,
})));
```

The application keeps its BullMQ worker, payload and retry policy. RhinoQ owns
the durable Task/Execution projection, per-item identity, settlement, owner
routes, SSE with polling fallback, Task Center and Workbench mount. It does not
scan or mutate unknown Redis jobs.

The equivalent raw-queue comparison is not just `new Queue()` and `new Worker()`.
For the same user-facing scope it also needs application-owned status/detail
routes, a progress model, a cancellation route, attempt/result history,
reconnect handling, a per-item settlement rule, and an operator screen. The
website must not hide those lines when it claims a code reduction.

### New application: typed registry and one mounted product surface

For a new application, use the compiler path. It removes repeated adapter,
runtime and scope configuration while retaining explicit safety policies:

```ts
import { defineRhinoQProject } from '@rhinoq/node';

export const project = defineRhinoQProject({
  pool,
  profile: { name: 'reports', adapters: [reportsAdapter] },
  identity: {
    ownerFromNodeRequest: (request) => request.user.id,
    tenantFromNodeRequest: (request) => request.user.tenantId,
  },
  http: { operatorToken: process.env.RHINOQ_OPERATOR_TOKEN! },
  tasks: (task) => ({
    exportReport: task.task('report.export', async ({ reportId }, { progress }) => {
      await progress(0, 1, 'Generating report');
      return generateReport(reportId);
    }, { retry: { mode: 'runtime', maxAttempts: 3 } }),
    resizeImages: task.batch('image.resize', (input, context) =>
      resizeImage(input, context.signal), { maxItems: 500 }),
    capturePayment: task.effect('payment.capture', capturePayment, {
      effect: { idempotency: 'provider', confirmation: 'readback' },
    }),
  }),
});

const application = await project.start();
server.use(application.http!);
```

The registry is typed, rejects duplicate/unknown Task names, refuses an
external effect without idempotency and confirmation, and produces a stable
plan for the operator surface. A worker can use the generated
`application.workerHandler()` instead of another Task-name switch statement.

## Feature comparison by user outcome

| User need | Raw BullMQ | RhinoQ value | Honest boundary |
|---|---|---|---|
| Enqueue and process a job | Mature Redis queue/worker API | Keep BullMQ and add a Task identity when needed | BullMQ remains the queue authority |
| Fan-out progress | `job.updateProgress()` plus application aggregation | Durable per-item keys, monotonic aggregate progress and Task Center rendering | Runtime adapter must provide progress facts |
| Retry history | Runtime attempts/events | Attempts are projected into one Task timeline and remain visible after reload | Retry count/backoff policy stays with the runtime |
| Cancel | Queue/job controls | Owner action plus explicit `too_late`/`cannot_cancel_safely` outcome | Running external effects still require handler/provider cooperation |
| Realtime UI | Application SSE/WebSocket/polling contract | One owner-scoped SSE surface with polling fallback and convergence | Existing custom HTTP contract remains application-owned |
| User result access | Application result route and authorization | Task Center result/artifact reference with owner/tenant checks | Business auth and provider credentials remain application-owned |
| Queue says green, business state is wrong | Usually an application-specific check | Effect Ledger, read-back confirmation, Rules, Findings and Flight Recorder | Not exactly-once external execution |
| Operator recovery | Runbook or custom admin endpoint | Preview, precondition, approval, allowlisted callback, post-check and audit | Workbench actions are opt-in and fail closed |
| Rule investigation | Custom SQL job/alert wiring | Read-only Rule explain/test, bounded evidence and Finding lifecycle | Rules can only inspect PostgreSQL; providers need an application verifier |
| Existing-worker adoption | No migration needed, but all Task/UI plumbing remains custom | `adopt` preview/apply, bridge, Task Center and Workbench | A real adopter measurement is required before a universal LOC claim |
| Queue-only workload | Best-fit primitive | Adds unnecessary Task/evidence surface | Recommend BullMQ instead |
| Durable workflow replay | Not the goal | Overlay for existing runtimes | Temporal/Restate are better when workflow replay is the requirement |

## What the website must stop showing

The following are not current RhinoQ public APIs and must not be used as
RhinoQ-vs-BullMQ proof:

```ts
import { Queue, Worker, QueueEvents, FlowProducer } from 'rhinoq';
```

The canonical Node package is `@rhinoq/node`. The Node entry point exports the
Task/Gateway/PostgreSQL/BullMQ/Workbench contracts; it is not a Redis clone that
re-exports BullMQ's `Queue`, `Worker`, `QueueEvents` and `FlowProducer` classes.

The website must also remove unsupported fixed claims such as `100k+ jobs/sec`,
`<1ms latency` and `99.99% reliability`. Repository benchmarks are local,
workload-specific evidence and explicitly not production capacity or SLA
claims. Link to the benchmark environment and commit when a measured number is
shown.

## How to measure “shorter” without misleading users

Use one checked-in workload and run both implementations through the same
acceptance commands:

1. normal result with progress;
2. two-owner isolation;
3. missing output becomes `uncertain`;
4. guarded repair needs separate approval;
5. unknown provider read-back never redispatches the mutation.

Count only consumer-owned frontend/backend/SQL/integration source after both
suites pass. Exclude comments, blank lines, tests, generated files, lockfiles,
dependencies and RhinoQ implementation files. Report the categories
separately. The harness is `scripts/benchmark-loc.mjs`; it intentionally refuses
to produce a number while either acceptance command is missing.

The existing Door 1 local measurement (322 RhinoQ lines versus 508 for a
hand-built equivalent scope) is useful as a hypothesis, not a universal claim.
Repeat it with an independent adopter before placing a percentage on the
marketing site.

## Website copy to use

**Headline:** “Add a durable Task experience around the workers you already
run.”

**Subheadline:** “Keep BullMQ or choose RhinoQ’s PostgreSQL runtime. Get typed
Task identity, progress, attempts, owner-scoped realtime, evidence and guarded
recovery in one product surface.”

**Comparison label:** “RhinoQ complements your queue; it does not pretend to be
a faster queue replacement.”

**Proof CTA:** “See the same workload: handler, progress, cancel, reload,
uncertain provider response and verified recovery.”

**Fit warning:** “Only need enqueue/worker/retry? Use BullMQ. Need a durable
user-facing Task and business-outcome evidence without a runtime migration? Use
RhinoQ.”

## Acceptance criteria for the comparison page

- Every code block imports from a package/path that exists in the current release.
- The before/after snippets cover the same feature scope.
- The page distinguishes queue primitives, Task product surface and verified
  outcome features.
- Any LOC, throughput or reliability number links to reproducible evidence.
- The page states when BullMQ, Temporal, Restate, Inngest or Trigger.dev is a
  better fit.
- The Playground rejects invalid JSON and labels all browser-only simulation
  values as illustrative.
- The comparison is versioned with the package and reviewed whenever the public
  API changes.
