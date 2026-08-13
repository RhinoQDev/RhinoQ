# One-command setup

`npx rhinoq setup` is the recommended entry point for an existing application.
It composes RhinoQ's existing init, adopt, doctor and eval capabilities; it does
not create a second runtime.

For framework-neutral/manual execution, the generated integration uses
`defineRhinoQApplication()`: add Tasks to one typed registry, inherit the
selected execution profile, and mount the owner API, Task Center and Workbench
from the returned application. Existing files are still never overwritten.

## Preview, then apply

```bash
npm install @rhinoq/node@next pg
npx rhinoq setup
npx rhinoq setup --apply
```

Preview performs no writes. Apply creates only missing files and refuses to
overwrite application-owned files. Commit or review the diff before starting
the application.

Setup detects `package.json`, NestJS, BullMQ, `go.mod` and PostgreSQL
configuration. Selection is deterministic: detected BullMQ is preferred;
otherwise a Go application can use the native PostgreSQL queue; otherwise the
manual adapter is proposed. Override it explicitly when needed:

```bash
npx rhinoq setup --runtime bullmq --mode single --owner-property user.id --apply
npx rhinoq setup --runtime postgres --apply
npx rhinoq setup --runtime manual --apply
```

`--local-postgres` may generate disposable loopback evaluation infrastructure.
It is not a production database decision.

## What apply produces

- the existing RhinoQ schema/config initialization;
- `.rhinoq/setup.json` recording the selected path;
- `.env.rhinoq.example`, without secrets;
- a BullMQ/Nest integration through the existing adopter, a native Go worker
  shell for the PostgreSQL queue, or a portable manual application shell;
- doctor/eval results when a database is configured;
- the Task Center and Workbench paths to open after startup.

Setup cannot invent authentication, tenant identity, provider credentials,
business payloads or safe retry/idempotency policy. Those remain explicit
application decisions. Rerunning setup is safe: existing files are preserved.

## Production handoff

Run both the generated application health checks and the authoritative Go
runtime doctor where the full runtime is deployed. Then use the
[production checklist](./production-checklist.md); a successful local setup is
not production reliability evidence.
