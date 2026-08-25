# RhinoQ

[View `rhinoq` on npm](https://www.npmjs.com/package/rhinoq) ·
[Canonical `@rhinoq/node` package](https://www.npmjs.com/package/@rhinoq/node) ·
[GitHub repository](https://github.com/RhinoQDev/RhinoQ)

> **Turn background jobs into Tasks your users can follow and your team can
> operate safely.** Keep BullMQ or choose PostgreSQL; get progress, results,
> cancellation, retry history and safe recovery in one product surface.

RhinoQ adds durable Task state, progress, retry history, cancellation, realtime
SSE, an embeddable React UI, a user Task Center and safe recovery around work
executed by PostgreSQL or BullMQ.

`rhinoq` is the short, unscoped distribution alias for `@rhinoq/node`. Both
commands install the same Node.js SDK and CLI. New applications can use either
name; library authors normally prefer the scoped package. Do not install both:
the alias already depends on and re-exports the matching canonical release.

Latest verified npm prerelease: `v0.1.0-beta.25`.

RhinoQ is useful when background work has become a product problem: users need
progress and results, support needs history, and operators need to know whether
an external action is safe to repeat. A provider result that cannot be proven
becomes `uncertain`; RhinoQ does not turn it into success or retry it blindly.

## See the product before installing infrastructure

```bash
npx rhinoq dev --demo
```

This disposable Workbench needs no PostgreSQL, Redis or provider credentials.
It shows recorded progress, a completed result and a failed attempt. The demo
is synthetic evidence; use `npx rhinoq up` for a real PostgreSQL-backed profile.

## Start in an existing application

```bash
npm install rhinoq@next pg
npx rhinoq setup
npx rhinoq setup --apply
```

For a guided, preview-first adoption path, use `npx rhinoq connect`. To create a
new Task slice, use `npx rhinoq add task report.export --apply`; it generates a
progress/result handler, a manifest/plan smoke test and a `/task-center`
handoff without overwriting existing files.

The first `setup` command is a read-only preview. It detects Node.js, NestJS,
Go, PostgreSQL and BullMQ, recommends an execution path, and shows the files
and schema actions it would apply. It does not overwrite existing files.

Use the scoped package when importing the SDK directly:

```bash
npm install @rhinoq/node@next pg
```

```ts
import { createRhinoQApp } from '@rhinoq/node';

const app = await createRhinoQApp({
  pool,
  adapters,
  ownerFromRequest: (request) => request.user.id,
});

server.use(app.http({ operatorToken: process.env.RHINOQ_OPERATOR_TOKEN }));
```

RhinoQ can keep an existing BullMQ runtime, or use its native PostgreSQL queue
with the authoritative Go worker. Your application still owns authentication,
tenant identity, business handlers, credentials and business retry safety.

Read the [five-minute quickstart](https://github.com/RhinoQDev/RhinoQ/blob/main/docs/quickstart.md),
[PostgreSQL queue guide](https://github.com/RhinoQDev/RhinoQ/blob/main/docs/postgres-queue.md),
or [BullMQ example](https://github.com/RhinoQDev/RhinoQ/tree/main/examples/fanout-bullmq).

> RhinoQ is a public beta for evaluation and controlled pilots. It does not
> claim a production SLA. Review the
> [production status](https://github.com/RhinoQDev/RhinoQ/blob/main/docs/production-readiness.md)
> before deploying real workloads.
