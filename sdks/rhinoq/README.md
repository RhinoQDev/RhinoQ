# RhinoQ

[View `rhinoq` on npm](https://www.npmjs.com/package/rhinoq) ·
[Canonical `@rhinoq/node` package](https://www.npmjs.com/package/@rhinoq/node) ·
[GitHub repository](https://github.com/madebyduy/RhinoQ)

Open-source background jobs and async Tasks for Node.js and NestJS. RhinoQ
adds durable Task state, progress, retry history, cancellation, realtime SSE,
an embeddable React UI and safe recovery around work executed by PostgreSQL or
BullMQ.

`rhinoq` is the short, unscoped distribution alias for `@rhinoq/node`. Both
commands install the same Node.js SDK and CLI. New applications can use either
name; library authors normally prefer the scoped package. Do not install both:
the alias already depends on and re-exports the matching canonical release.

Latest verified npm prerelease: `v0.1.0-beta.20`.

## Start in an existing application

```bash
npm install rhinoq@next pg
npx rhinoq setup
npx rhinoq setup --apply
```

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

Read the [five-minute quickstart](https://github.com/madebyduy/RhinoQ/blob/main/docs/quickstart.md),
[PostgreSQL queue guide](https://github.com/madebyduy/RhinoQ/blob/main/docs/postgres-queue.md),
or [BullMQ example](https://github.com/madebyduy/RhinoQ/tree/main/examples/fanout-bullmq).

> RhinoQ is a public beta for evaluation and controlled pilots. It does not
> claim a production SLA. Review the
> [production status](https://github.com/madebyduy/RhinoQ/blob/main/docs/production-readiness.md)
> before deploying real workloads.
