# Getting started with the Task Platform

> Status: evaluation only. This guide demonstrates the implemented Task
> contract; it does not claim an automatic BullMQ, React, realtime or
> tenant-authorized integration.

RhinoQ's first product path is a user-facing Task: a durable record that a
backend and frontend can both understand. A Task is not a queue job. It has an
application-facing lifecycle, a monotonic snapshot version, progress, result
availability and one or more execution attempts.

## Prerequisites

- Go 1.25+ for the embedded API.
- PostgreSQL 16 is the database version covered by the Task store contract.
- Node.js 22+ only if evaluating the source-only Node Gateway client.

`NewInMemory()` is useful for a small contract experiment. Use PostgreSQL for
durable Task data, after applying the repository migrations.

```bash
go install github.com/madebyduy/RhinoQ/cmd/rhinoq@latest

export RHINOQ_DATABASE_URL='postgres://user:pass@localhost:5432/app?sslmode=disable'
rhinoq migrate plan
rhinoq migrate apply
rhinoq doctor --ci
```

No release is tagged yet, so pin an evaluation revision rather than treating
`@latest` as a stable production version.

## 1. Create a Task

Use the public Go facade with your application's existing `*sql.DB`.

```go
package reports

import (
    "context"
    "database/sql"

    "github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func startExport(ctx context.Context, db *sql.DB, reportID string) (rhinoq.TaskSnapshot, error) {
    client, err := rhinoq.NewPostgres(db)
    if err != nil {
        return rhinoq.TaskSnapshot{}, err
    }

    task, err := client.CreateTask(ctx, rhinoq.TaskCreateRequest{
        ID:                "report-export-" + reportID,
        Type:              "report.export",
        OwnerID:           "user-123", // metadata today; not an authorization boundary
        DefinitionVersion: 1,
    })
    if err != nil {
        return rhinoq.TaskSnapshot{}, err
    }
    return client.QueueTask(ctx, task.ID, task.EntityVersion)
}
```

`EntityVersion` is a precondition on every write. If a command returns
`rhinoq.ErrTaskVersionConflict`, read the current snapshot and decide again;
never retry an old mutation blindly.

## 2. Bind one execution attempt

An Execution identifies one attempt and which runtime owns it. The current
contract can bind a stable external ID, but it does **not** enqueue to BullMQ or
subscribe to its events. This code is the explicit integration boundary that a
future adapter will automate.

```go
task, err = client.CreateTaskExecution(ctx, task.ID,
    rhinoq.TaskExecutionCreateRequest{ID: "exec-report-01", Runtime: "bullmq"})
if err != nil { /* handle */ }

task, err = client.BindTaskExecution(ctx, "exec-report-01",
    rhinoq.TaskExecutionBinding{Runtime: "bullmq", ExternalID: "bullmq-job-981"})
if err != nil { /* handle */ }
```

The runtime reference is write-only. User-facing snapshots intentionally expose
only execution summaries, not a queue or provider identifier.

## 3. Report lifecycle and progress

The worker or integration boundary uses the latest Task version as it updates
the user-visible state.

```go
task, err = client.StartTask(ctx, task.ID, task.EntityVersion)
if err != nil { /* handle */ }

total := int64(20)
task, err = client.ReportTaskProgress(ctx, task.ID, task.EntityVersion,
    rhinoq.TaskProgress{Completed: 8, Total: &total, Message: "Generating pages"})
if err != nil { /* handle */ }

task, err = client.CompleteTask(ctx, task.ID, task.EntityVersion)
if err != nil { /* handle */ }

_, err = client.AttachTaskResult(ctx, task.ID, task.EntityVersion,
    "s3://app-reports/report-01.pdf")
if err != nil { /* handle */ }
```

Progress can also be indeterminate: omit `Total` and provide a message. The UI
must not invent a percentage when the worker does not know a total.

## 4. Read the snapshot and result

```go
snapshot, err := client.GetTask(ctx, "report-export-42")
if err != nil { /* handle */ }

if snapshot.HasResult {
    result, err := client.GetTaskResult(ctx, snapshot.ID)
    if err != nil { /* handle */ }
    _ = result.Reference
}
```

The HTTP Gateway exposes the same polling-first contract. The typed Node client
has `createTask`, `getTask`, `transitionTask`, `reportTaskProgress`,
`attachTaskResult`, `createTaskExecution` and `bindTaskExecution`; see
[Node.js integration](./nodejs.md). Gateway deployment is not end-user auth:
keep it on loopback or put it behind your own TLS, network policy and access
control.

## What this proves—and what it does not

This path proves a versioned Task contract across Go, PostgreSQL, HTTP and Node.
It does not yet prove the product's intended adoption promise:

- no BullMQ adapter exists;
- no automatic Task-to-native-job dispatch exists;
- no composed retry command creates a new Execution atomically;
- no React hook, Task Center, SSE/WebSocket or stream transport exists;
- `OwnerID` is not tenant/user authorization;
- result references are not proxied or downloaded by RhinoQ.

Read [Task Platform](./task-platform.md) for the exact implementation status.

## Native runtime is a separate optional path

RhinoQ also includes a native Go/PostgreSQL job runtime with transactional
enqueue, fenced leases, retries, cancellation and a worker. That runtime is an
execution backend, not a requirement for an application that already has a
queue.

```go
queue, err := rhinoq.NewPostgres(db)
if err != nil { /* handle */ }

err = queue.Handle("reports", "generate-report", func(ctx context.Context, job rhinoq.Job) error {
    // application work
    return nil
})
if err != nil { /* handle */ }

_, err = queue.Enqueue(ctx, rhinoq.JobRequest{
    QueueName: "reports", JobName: "generate-report", Payload: []byte(`{"reportId":"42"}`),
})
if err != nil { /* handle */ }

// queue.Run(ctx) runs registered handlers until ctx is cancelled.
```

See [runtime operations](./operations.md) and [failure semantics](./failure-semantics.md)
before using the native runtime beyond evaluation.

## Optional: verify a business outcome

When a Task has an irreversible external effect or a business result that must
be independently checked, add the Verified Tasks capability. It records effect
evidence and evaluates bounded SQL Rules into persistent Findings. It is not
needed for an ordinary task status/progress UI.

The runnable no-cutover example is [integrity-only](../examples/integrity-only/).
Read [Rules](./rules.md) and [recovery](./recovery.md) for its safety boundary.
