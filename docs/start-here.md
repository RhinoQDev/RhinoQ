# Add RhinoQ to an application

This guide is for an application that already has background work. It helps
you choose one integration path and reach the first visible Task without
reading the complete architecture.

For a standalone product tour, use the [five-minute quickstart](./quickstart.md).

RhinoQ is a public beta for evaluation and controlled pilots. This guide pins
the verified release:

```bash
npm install @rhinoq/node@0.1.0-beta.23 pg
```

## The result you are building

After the first integration, one background operation should have:

- a durable Task ID;
- progress and attempt history;
- owner-scoped reads;
- a Task Center page for the user;
- an authorized Workbench and terminal view for operators.

You do not need verification, artifacts, recovery or every runtime feature on
day one.

## Choose your execution path

| Existing application | Use |
|---|---|
| BullMQ already executes the work | [Path A: keep BullMQ](#path-a-keep-bullmq) |
| No queue; PostgreSQL should execute it | [Path B: native PostgreSQL](#path-b-use-the-native-postgresql-queue) |
| Another runtime executes it | [Path C: portable adapter](#path-c-connect-another-runtime) |

Do not change queue/runtime and HTTP/UI contracts at the same time unless you
have a reason. RhinoQ can be adopted incrementally.

## Before applying anything

Run the complete guided preview:

```bash
npx rhinoq setup
```

`setup` is the normal first command. It detects the runtime and prints the
files it would create. Use `connect` only when you specifically want the
runtime-preserving adoption preview described in Path A or Path C.

Then create a read-only safety inventory:

```bash
npx rhinoq adopt --plan --out .rhinoq/adoption-plan.json
```

Review these findings first:

- retry loops that could compete with RhinoQ retry;
- cancellation code whose terminal meaning is unclear;
- provider calls that may create an external effect;
- handlers or producers whose business identity cannot be inferred.

RhinoQ does not generate authentication, idempotency keys or provider
confirmation rules from static source matches.

## Path A: keep BullMQ

Use this when the worker and Redis deployment should remain unchanged.

### 1. Choose Task aggregation

```bash
npx rhinoq connect --mode single
```

- `single`: one BullMQ job is one Task;
- `fanout`: one Task owns multiple BullMQ jobs.

Preview first, then apply the same reviewed mode:

```bash
npx rhinoq connect --mode single --apply
```

The command creates missing integration files and refuses to overwrite an
existing file.

### 2. Mount RhinoQ

```js
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
```

This mounts:

- `/tasks` — owner Task API;
- `/task-center` — user-facing history and progress;
- `/admin` — operator Workbench.

### 3. Dispatch with stable identity

```js
await app.dispatch(taskId, items.map((item, index) => ({
  key: `item-${index}`,
  data: item,
})));
```

`taskId` and each `key` must come from stable application identity, not a
random retry attempt.

Continue with the [BullMQ example](../examples/fanout-bullmq/README.md).

## Path B: use the native PostgreSQL queue

Use this when the application does not need Redis/BullMQ.

Preview and apply the native worker shell:

```bash
npx rhinoq setup --runtime postgres
npx rhinoq setup --runtime postgres --apply
npx rhinoq doctor
```

The authoritative Go worker owns claim, lease, heartbeat, retry, fencing and
job state. Node applications can enqueue through `PostgresProducer`, including
inside an existing PostgreSQL transaction.

Continue with the [native PostgreSQL queue guide](./postgres-queue.md).

## Path C: connect another runtime

Use this when a custom queue or service already executes the work.

Start in observe-only Shadow Mode:

```bash
npx rhinoq adopt --shadow --adapter custom
npx rhinoq adopt --shadow --adapter custom --apply
```

Implement `resolveIdentity(ref)` using application data. Returning `undefined`
keeps the event unresolved; RhinoQ does not invent a Task.

Collect a real runtime report and evaluate promotion:

```bash
npx rhinoq adopt --promote \
  --from .rhinoq/adoption-plan.json \
  --evidence .rhinoq/shadow-report.json \
  --approve '<reviewed-approval-key>'
```

Capability gaps or unresolved identities block promotion. See
[Native adoption](./native-adoption.md) and the
[manual adapter example](../examples/manual-runtime/README.md).

## Add the first Task

Preview a complete Task slice:

```bash
npx rhinoq add task report.export
```

Apply only after reviewing the output paths:

```bash
npx rhinoq add task report.export --apply
```

The generator writes a handler shell and test without overwriting existing
files. Replace its sample body with your business work.

For a typed registry, use `defineRhinoQApplication()`:

```ts
const definition = defineRhinoQApplication({
  profile: { name: 'reports', adapters: [runtimeAdapter] },
  tasks: (task) => ({
    exportReport: task({
      name: 'report.export',
      retry: { mode: 'runtime', maxAttempts: 3 },
      run: ({ reportId }, context) =>
        generateReport(reportId, context.progress),
      result: ({ url }) => ({ ref: url, mediaType: 'application/pdf' }),
    }),
  }),
});
```

See [Task declarations](./task-declaration.md) when you need more than one Task.

## Prove the integration

Run:

```bash
npx rhinoq doctor
npx rhinoq watch --severity warning
```

Then exercise one real Task and verify:

1. the owner can read their Task;
2. another owner receives not-found;
3. progress reaches Task Center;
4. a failed attempt appears in `npx rhinoq inspect <task-id>`;
5. Workbench refuses an unauthorized request;
6. worker restart or event loss converges through reconciliation.

Open a specific Task only when the visual timeline helps:

```bash
npx rhinoq open <task-id>
```

Read [Terminal operations](./terminal-operations.md) for filters and JSON mode.

## Add safety only where the Task needs it

| The Task does… | Add… |
|---|---|
| calls Stripe or another mutating provider | [Provider operation policy](./provider-operations.md) |
| returns files or media | [Artifact storage](./artifact-storage.md) |
| has resumable deterministic units | [Durable Task capabilities](./async-task-capabilities.md) |
| must prove the business result | [Business verification](./business-verification.md) |
| needs operator repair | [Guarded recovery](./recovery.md) |
| needs unattended alerts | [Notifications](./notifications.md) |

Do not add a capability simply because RhinoQ has it.

## What the application still owns

RhinoQ cannot safely decide:

- who the authenticated owner or tenant is;
- what payload the handler accepts;
- whether an error is retryable;
- which key makes an external effect idempotent;
- how a provider result is confirmed;
- what “business success” means;
- who may use operator actions.

These are explicit boundaries, not missing configuration defaults.

## Before a controlled pilot

- pin `@rhinoq/node@0.1.0-beta.23`;
- use production PostgreSQL credentials and TLS policy;
- prove owner/tenant isolation;
- rehearse worker restart, cancellation and lost events;
- configure health, metrics, retention and alerts;
- review [production readiness](./production-readiness.md) and the
  [production checklist](./production-checklist.md).

## Troubleshooting

| Symptom | Next action |
|---|---|
| No Task appears | Check stable Task/Execution binding with `npx rhinoq inspect <id>`. |
| Workbench opens but Task Center fails | Verify the owner resolver and `/tasks` authorization. |
| Progress stops | Check worker lifecycle and reconciliation; do not infer success from silence. |
| Cancel is unavailable | The adapter may not prove safe cancellation. Keep it hidden or provide an application-owned workflow. |
| Provider call timed out | Treat the result as unknown until confirmation/readback proves the outcome. |
| Setup wants to overwrite a file | Stop and integrate the generated fragment manually. |

For command syntax, use the [CLI reference](./cli.md). For API imports, use the
[Node SDK guide](../sdks/node/README.md).
