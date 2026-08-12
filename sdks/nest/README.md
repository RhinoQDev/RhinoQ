# `@rhinoq/nest` compatibility package

New applications should import `RhinoQModule` from `@rhinoq/node/nest`. This
package remains only for existing adopters during the prerelease migration.

NestJS wiring for the embedded Node/BullMQ Task integration. It keeps the
correctness engine in `@rhinoq/node` and only owns provider/lifecycle setup:

For a new adoption, prefer the preview-first golden path:

```bash
npx rhinoq setup --runtime bullmq --mode single --owner-property user.id
npx rhinoq setup --runtime bullmq --mode single --owner-property user.id --apply
```

It detects registered queues and delegates generation to the existing Nest
adopter. Existing files are never overwritten; ambiguous multi-queue projects
still require explicit queue/task selection.
schema readiness, PostgreSQL projector lease, reconciliation schedule,
framework-neutral Task middleware and health/metrics access.

```bash
npm install @rhinoq/nest @rhinoq/node pg
```

```ts
import { Module } from '@nestjs/common';
import { RhinoQModule } from '@rhinoq/nest';

@Module({
  imports: [RhinoQModule.forRootAsync({
    inject: [Pool, BullMQEvents],
    useFactory: (pool, events) => ({
      pool,
      events,
      runtimeScope: 'reports',
      terminalProjection: 'execution-only',
      reconciliation: {
        observe: async (reference) => readBullMQState(reference),
      },
    }),
  })],
})
export class AppModule {}
```

`forRootAsync()` waits for schema installation before the integration is
injected. The module creates a PostgreSQL advisory lease by default, so only
one process projects a `runtimeScope`; reconciliation gets a separate lease.
The application still supplies the BullMQ runtime read because RhinoQ must not
scan or mutate an application-owned Redis queue.

The package has no runtime dependency on Nest decorators. Nest remains a peer
dependency of the host application, and the returned object is a standard
dynamic-module shape. Inject `RHINOQ_TASKS`, `RHINOQ_BRIDGE` or
`RHINOQ_HEALTH` from the package when needed.

This is a prerelease. It does not add tenant RBAC, a distributed notification
scheduler or exactly-once external provider execution.
