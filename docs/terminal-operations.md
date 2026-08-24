# Terminal-first operations

Workbench is the deep investigation and guarded-action surface. It is not
required to notice Task changes.

## Watch

```bash
npx rhinoq watch
npx rhinoq watch --all
npx rhinoq watch --type report.export --severity warning
npx rhinoq watch --json
npx rhinoq watch --once
```

The default initial snapshot shows only attention-worthy Tasks. Later changes
include state and progress transitions; `--quiet` suppresses informational
events. Identical symptoms for the same Task type are grouped, with a bounded
set of example IDs, rather than printed as one stack trace per Task.

PostgreSQL `LISTEN/NOTIFY` carries only Task identity and version and is treated
as a wake-up hint. The watcher always re-reads tenant-scoped authoritative
summaries. A bounded poll remains active so a disconnected listener cannot hide
a change. The CLI never claims, retries, cancels or confirms an Effect.

## Inspect

```bash
npx rhinoq inspect <task-id>
npx rhinoq inspect <task-id> --json
```

`inspect` uses the same operator projection as Workbench: Task snapshot,
Execution results, Durable Steps, waitpoints, verification, artifacts and any
available provider/runtime evidence. Missing optional evidence is printed as a
warning, never converted into a safe-retry decision.

## Open

```bash
npx rhinoq open <task-id>
npx rhinoq open <task-id> --print
```

The command builds a direct `?task=` Workbench link. Remote URLs must use HTTPS;
loopback HTTP is accepted for local development. Set `RHINOQ_WORKBENCH_URL` or
pass `--base-url` when Workbench is mounted elsewhere.

## Production notification boundary

A terminal process is not a durable pager. Configure reviewed Slack/webhook
routes and invoke or host Go notification routing for unattended alerts. Node
can edit the secret-reference registry but real Finding delivery stays in the
Go-owned durable event/destination ledger.
