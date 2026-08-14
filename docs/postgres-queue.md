# PostgreSQL queue quickstart

RhinoQ has two valid runtime choices:

1. keep an existing queue and attach a runtime adapter; or
2. use RhinoQ's native Go queue, where PostgreSQL stores and coordinates jobs.

This page covers the second choice. It is not merely “PostgreSQL used to store
Task views”: PostgreSQL is the queue backend itself. Enqueue, claiming, leases,
heartbeats, retries, cancellation, admission control and recovery are backed by
the RhinoQ PostgreSQL schema.

## When to choose it

Choose the native PostgreSQL queue when:

- the application is written in Go, or can enqueue through the Node producer,
  Gateway or `rhinoq.enqueue()` SQL function;
- PostgreSQL is already an operated dependency;
- you prefer not to add Redis or another broker;
- the workload fits the capacity measured on your own PostgreSQL deployment;
- durable leases, fencing and operator inspection matter more than adopting a
  broker-specific ecosystem.

Keep BullMQ or another existing runtime when it already works well, its tooling
is important to the team, or moving execution would create unnecessary risk.
RhinoQ can attach to that runtime without a queue migration.

## What is included

- transactional and idempotent enqueue;
- registered `(queueName, jobName)` handlers;
- concurrent workers with leased claims and epoch fencing;
- heartbeat, bounded retry/backoff and expired-lease recovery;
- graceful shutdown and cancellation;
- delayed work, priority/aging, rate limits and admission budgets;
- queue counts, pause/resume, attention states and attempt history;
- PostgreSQL row-level tenant isolation when deployed with the required roles.

This is an at-least-once execution runtime. External effects still require a
stable idempotency identity and confirmation policy; a queue cannot manufacture
exactly-once behavior at an external provider.

## Minimal Go application

Prerequisites: Go 1.26.6, PostgreSQL 16 and an empty Go project.

```bash
go mod init example.com/rhinoq-worker
go get github.com/madebyduy/RhinoQ@v0.1.0-beta.16
go get github.com/jackc/pgx/v5@v5.9.2
```

Prepare the full RhinoQ schema from a pinned CLI:

```bash
export RHINOQ_DATABASE_URL='postgresql://user:password@127.0.0.1:5432/app'
go run github.com/madebyduy/RhinoQ/cmd/rhinoq@v0.1.0-beta.16 migrate plan
go run github.com/madebyduy/RhinoQ/cmd/rhinoq@v0.1.0-beta.16 migrate apply
go run github.com/madebyduy/RhinoQ/cmd/rhinoq@v0.1.0-beta.16 doctor
```

On PowerShell, set the connection with:

```powershell
$env:RHINOQ_DATABASE_URL = 'postgresql://user:password@127.0.0.1:5432/app'
```

Create `main.go`:

```go
package main

import (
    "context"
    "database/sql"
    "log"
    "os"

    _ "github.com/jackc/pgx/v5/stdlib"
    "github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func main() {
    db, err := sql.Open("pgx", os.Getenv("RHINOQ_DATABASE_URL"))
    if err != nil { log.Fatal(err) }
    defer db.Close()

    queue, err := rhinoq.NewPostgres(db)
    if err != nil { log.Fatal(err) }

    err = queue.Handle("reports", "generate-report", func(ctx context.Context, job rhinoq.Job) error {
        log.Printf("processing job=%s attempt=%d payload=%s", job.ID, job.Attempts, job.Payload)
        return nil
    })
    if err != nil { log.Fatal(err) }

    _, err = queue.Enqueue(context.Background(), rhinoq.JobRequest{
        QueueName:      "reports",
        JobName:        "generate-report",
        Payload:        []byte(`{"reportId":"report-42"}`),
        IdempotencyKey: "generate-report:report-42",
        CorrelationID:  "report-42",
    })
    if err != nil { log.Fatal(err) }

    // Run claims jobs for registered handlers until the context is cancelled.
    // Production code should use a signal-aware context.
    if err := queue.Run(context.Background()); err != nil { log.Fatal(err) }
}
```

Run it with `go run .`. Production deployments normally separate producer and
worker processes. Every worker must register the exact job names it may
execute; an unregistered job name is not executed.

## Node producer, Go worker

A Node application can enqueue into the same native PostgreSQL queue through
`PostgresProducer`. The Go worker remains authoritative for leases, retries and
job-state transitions. Follow the runnable
[Node producer/worker example](../examples/nodejs/README.md).

## Operate the queue

```bash
rhinoq queue counts reports
rhinoq jobs list --queue reports --states pending,blocked,dead
rhinoq queue pause reports
rhinoq queue resume reports
rhinoq attention
```

Pausing stops future claims; it does not kill handlers that already hold a
lease. The standalone `rhinoq-worker` binary is a recovery/health sidecar only;
it cannot run business jobs because only the application knows and registers
their handlers.

## Production gates for this runtime

Before production:

- use a non-superuser, non-`BYPASSRLS` application role;
- grant producers only the allowlisted `rhinoq.enqueue()` function, not direct
  table writes;
- set a unique worker name per process and run `rhinoq doctor`;
- configure connection/admission budgets, concurrency, lease/heartbeat timing
  and graceful shutdown;
- test worker termination, stale-worker fencing, PostgreSQL failover and
  restore on the actual deployment topology;
- alert on old pending work, backlog growth, absent workers, reaper health and
  `uncertain` external effects;
- benchmark the application's payload, enqueue rate, handler duration and
  fan-out. RhinoQ publishes no general throughput claim.

Use the [production checklist](./production-checklist.md),
[PostgreSQL role guide](./postgres.md), [runtime operations](./operations.md)
and [failure semantics](./failure-semantics.md) before deployment.
