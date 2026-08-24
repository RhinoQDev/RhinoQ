# RhinoQ

Documentation: **English** · [Tiếng Việt](./docs/vi/README.md)

RhinoQ turns a background job into a durable, user-visible Task.

Use RhinoQ's native PostgreSQL queue, or keep an existing BullMQ runtime. Your
Node.js, NestJS or Go application gets durable Task state, progress, retry
history, cancellation, results, an owner-scoped Task API, realtime SSE with a
polling fallback, a user Task Center and an operator Workbench.

[![CI](https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml/badge.svg)](https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml)
[![Security](https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml/badge.svg)](https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml)
[![npm @rhinoq/node](https://img.shields.io/npm/v/%40rhinoq%2Fnode/next?label=%40rhinoq%2Fnode)](https://www.npmjs.com/package/@rhinoq/node)
![Go 1.26](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)
![PostgreSQL 16](https://img.shields.io/badge/PostgreSQL-16_tested-4169E1?logo=postgresql&logoColor=white)
![Status](https://img.shields.io/badge/status-public_beta-f59e0b)

> [!WARNING]
> RhinoQ is a public beta for evaluation and controlled pilots. It does not
> claim a production SLA. Read [production readiness](./docs/production-readiness.md)
> before using it for real workloads.

Latest verified public prerelease: `v0.1.0-beta.22`.

## See it before installing anything

```bash
npx rhinoq dev --demo
```

This opens a disposable Workbench with synthetic running, completed and failed
Tasks. It needs no database, Redis or provider credential.

![RhinoQ Workbench showing Tasks, execution stages, and evidence detail](./marketing/rhinoq-workbench-quiet-operations.png)

Use `npx rhinoq up` when you want the real local PostgreSQL-backed profile.

## Choose one path

Do not combine these paths on the first run.

| Your situation | Start here |
|---|---|
| I only want to see RhinoQ | `npx rhinoq dev --demo` |
| I want a real local PostgreSQL evaluation | `npx rhinoq up --dry-run`, then `npx rhinoq up` |
| I have an existing Node.js or NestJS app | `npx rhinoq setup` |
| I already use BullMQ | [Keep BullMQ](#keep-an-existing-bullmq-worker) |
| I want PostgreSQL to execute jobs | [Native PostgreSQL queue](./docs/postgres-queue.md) |
| I use another queue | [Portable runtime adapter](./examples/manual-runtime/README.md) |
| I only need business verification | [Integrity-only example](./examples/integrity-only/README.md) |

If you are unsure, use `setup`. It previews the integration and writes
nothing until you add `--apply`.

## Add RhinoQ to an existing application

### 1. Install

```bash
npm install @rhinoq/node@next pg
```

Node.js 22 and 24 are tested. PostgreSQL 16 is the tested database version.

### 2. Preview the integration

```bash
npx rhinoq setup
```

The preview detects the application shape and prints what RhinoQ can connect.
It does not overwrite application files.

For a safety inventory before changing runtime ownership:

```bash
npx rhinoq adopt --plan --out .rhinoq/adoption-plan.json
```

The plan finds handlers, producers, retry timers, cancellation boundaries and
possible external effects. It does not invent owner identity, idempotency keys,
provider confirmation or business rules.

### 3. Apply the reviewed setup

Rerun the exact `NEXT` command printed by the preview. For example:

```bash
npx rhinoq setup --runtime bullmq --mode single --apply
# or: npx rhinoq setup --runtime manual --apply
npx rhinoq doctor
```

RhinoQ does not choose `single` or `fanout` for BullMQ because that is Task
business structure, not package detection.

Generated files are non-overwriting. Review and commit the resulting diff.

### 4. Add one Task

```bash
npx rhinoq add task report.export
npx rhinoq add task report.export --apply
```

The first command previews. The second creates a handler shell and a smoke
test. Replace the generated handler body with your business work.

### 5. Verify the user and operator surfaces

The standard mount exposes:

| Surface | Default path | Who uses it |
|---|---|---|
| Task API | `/tasks` | authenticated application users |
| Task Center | `/task-center` | authenticated application users |
| Workbench | `/admin` | authorized operators |

Authentication is application-owned. Never expose Workbench without an
operator authorization boundary.

## Minimal Node composition

```ts
import { defineRhinoQApplication } from '@rhinoq/node';

const definition = defineRhinoQApplication({
  profile: { name: 'reports', adapters: [runtimeAdapter] },
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
      result: ({ url }) => ({ ref: url, mediaType: 'application/pdf' }),
    }),
  }),
});

const app = await definition.start({
  pool,
  ownerFromNodeRequest,
  http: { operatorToken: process.env.RHINOQ_OPERATOR_TOKEN },
});

await app.tasks.exportReport.dispatch({
  id: 'report-42',
  ownerId: user.id,
  payload: { reportId: '42' },
});
```

RhinoQ owns Task lifecycle projection. Your application still owns
authentication, tenant mapping, the handler, provider credentials and the
definition of a correct business result.

See the [Node SDK guide](./sdks/node/README.md) for imports and runtime-specific
composition.

## Keep an existing BullMQ worker

RhinoQ does not replace Redis or your worker. Choose the Task aggregation
semantics explicitly:

```bash
npx rhinoq connect --mode single
npx rhinoq connect --mode single --apply
```

`connect` is the friendly runtime-preserving preview and delegates to the same
`adopt` implementation. The lower-level `adopt --mode ...` form is equivalent;
use one spelling consistently.

Use `single` when one BullMQ job is one Task. Use `fanout` when one Task owns
multiple BullMQ jobs. RhinoQ refuses to guess because the wrong mode can close
a Task too early.

The compatibility preset mounts the complete surface:

```ts
import { rhinoq } from '@rhinoq/node';

const app = await rhinoq({
  pool,
  queue,
  events,
  ownerFromRequest: (request) => authenticatedUser(request).id,
});

server.use(app.http({ operatorToken: process.env.RHINOQ_OPERATOR_TOKEN }));
```

Continue with the [BullMQ example](./examples/fanout-bullmq/README.md).

## Operate without keeping a dashboard open

```bash
npx rhinoq watch --severity warning
npx rhinoq inspect <task-id>
npx rhinoq open <task-id>
```

- `watch` prints authoritative Task changes and groups repeated incidents.
- `inspect` joins attempts, Steps, verification and available provider evidence.
- `open` deep-links to the same Task in Workbench.

Database notifications are wake-up hints only; polling remains the disconnect
fallback. For unattended production alerts, configure durable
[notification routes](./docs/notifications.md).

## What RhinoQ handles

| RhinoQ handles | Your application still handles |
|---|---|
| Task and Execution lifecycle | authentication and tenant identity |
| progress, history and result metadata | business handler and payload |
| owner Task API and Task Center | authorization for private results |
| Workbench and terminal inspection | provider credentials |
| reconciliation and attention states | idempotency and confirmation policy |
| optional verification and guarded recovery | definition of business correctness |

RhinoQ separates technical completion from business correctness. An external
operation with an unknown result becomes `uncertain`; it is not retried blindly.

## Add capabilities only when needed

The first integration does not require every RhinoQ feature.

| Need | Guide |
|---|---|
| resumable units inside a Task | [Durable Steps](./docs/async-task-capabilities.md) |
| large files, video or ZIP output | [Artifacts](./docs/artifact-storage.md) |
| browser updates | [Realtime](./docs/realtime.md) |
| React components | [React UI](./docs/react-ui.md) |
| verify the real business outcome | [Business verification](./docs/business-verification.md) |
| safe external effects | [Provider operations](./docs/provider-operations.md) |
| guarded operator repair | [Recovery](./docs/recovery.md) |
| adopt without runtime cutover | [Native adoption](./docs/native-adoption.md) |
| terminal operations | [Terminal operations](./docs/terminal-operations.md) |

## Production checklist

Before a controlled pilot:

1. Pin the exact release instead of `@next`.
2. Run `npx rhinoq doctor` against the deployment database.
3. Prove owner and tenant isolation.
4. Define retry and external-effect policy explicitly.
5. Exercise cancellation, event loss and worker restart.
6. Configure retention, health checks, metrics and notification delivery.
7. Review [known limits](./docs/production-readiness.md).

The authoritative queue, lease, retry, fencing and Effect Ledger logic remains
in Go/Application/PostgreSQL. Node.js is the developer-facing producer,
composition and worker-lifecycle SDK.

## Documentation

Start with only the page that matches your next action:

- [Five-minute real local quickstart](./docs/quickstart.md)
- [Existing application guide](./docs/start-here.md)
- [One-command setup](./docs/setup.md)
- [Node SDK guide](./sdks/node/README.md)
- [Native PostgreSQL queue](./docs/postgres-queue.md)
- [CLI reference](./docs/cli.md)
- [Configuration reference](./docs/configuration.md)
- [Production checklist](./docs/production-checklist.md)
- [Architecture](./ARCHITECTURE.md)
- [All documentation](./docs/README.md)

## Contributing and support

- Use [GitHub Discussions](https://github.com/madebyduy/RhinoQ/discussions)
  for integration questions.
- Use [GitHub Issues](https://github.com/madebyduy/RhinoQ/issues) for
  reproducible bugs.
- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before sending a change.

Apache-2.0 licensed.
