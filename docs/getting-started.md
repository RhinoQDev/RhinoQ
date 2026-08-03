# Getting started

## Five-minute Node path

With Node.js 22 and PostgreSQL available:

```bash
npm install https://github.com/madebyduy/RhinoQ/releases/download/v0.1.0-beta.8/rhinoq-node-0.1.0-beta.8.tgz pg
npx rhinoq init
npx rhinoq verify add completed-report-has-output
npx rhinoq doctor
npx rhinoq fixture failure
npx rhinoq dev
```

Set `DATABASE_URL` before `init`. The generated Rule is intentionally a
template: edit its indexed business table and output column before using it
outside the fixture. `init` does not overwrite existing config or Rules.

The Node `init` path creates only the isolated Task profile. Verified Rules use
the full Go schema and authenticated Gateway. From the RhinoQ checkout, start
both Go processes with the same database configuration before continuing:

The `beta.8` archive is the first release whose Node package contains the
`verify` commands. An older tarball answers `FAIL verify requires 'add
<rule-name>'`; if that is what you see, you are on `beta.7` or earlier.

```bash
go build -o rhinoq ./cmd/rhinoq
go build -o rhinoq-agent ./cmd/rhinoq-agent
export RHINOQ_DATABASE_URL='postgres://user:pass@127.0.0.1:5432/app?sslmode=disable'
./rhinoq migrate apply
export RHINOQ_AGENT_TOKEN="$(openssl rand -hex 32)"
RHINOQ_AGENT_TOKEN="$RHINOQ_AGENT_TOKEN" ./rhinoq-agent
```

In another shell, continue the Rule loop:

```bash
export RHINOQ_AGENT_URL='http://127.0.0.1:8080'
export RHINOQ_AGENT_TOKEN="$(openssl rand -hex 32)"
npx rhinoq verify apply completed-report-has-output --subject-type report
npx rhinoq verify run completed-report-has-output
```

`verify apply` leaves the Rule disabled; `verify run` enables it for one bounded
evaluation and disables it after printing violated subjects and evidence.

To see queue completion diverge from reality and recover safely, run the
[official Stripe failure demo](../examples/nextjs-bullmq-stripe/).

## Task support layer

> Status: evaluation only. This guide demonstrates the implemented Task
> contract; it does not claim queue-wide discovery, realtime or tenant-wide
> authorization.

RhinoQ's first product path is a user-facing Task: a durable record that a
backend and frontend can both understand. A Task is not a queue job. It has an
application-facing lifecycle, a monotonic snapshot version, progress, result
availability and one or more execution attempts.

## Prerequisites

- Go 1.25+ for the embedded API.
- PostgreSQL 16 is the database version covered by the Task store contract.
- Node.js 22+ only if evaluating the Node Gateway client or BullMQ bridge.

`NewInMemory()` is useful for a small contract experiment. Use PostgreSQL for
durable Task data, after applying the repository migrations.

For a Node application keeping its existing queue, prefer the isolated
Task-only path instead of the full Go migration chain:

```bash
npm install /absolute/path/to/rhinoq-node-0.1.0-beta.8.tgz pg
RHINOQ_DATABASE_URL='postgres://...' npx rhinoq-task
```

The beta.8 tarball is attached to its GitHub prerelease while npm trusted
publishing is pending. It creates exactly three tables in `rhinoq_task` and
reuses the application's `pg.Pool` through `PostgresTaskClient`.

```bash
go install github.com/madebyduy/RhinoQ/cmd/rhinoq@latest

export RHINOQ_DATABASE_URL='postgres://user:pass@localhost:5432/app?sslmode=disable'
rhinoq migrate plan
rhinoq migrate apply
rhinoq doctor --ci
```

GitHub prereleases are tagged, but `@latest` remains an old npm evaluation
build and is not a stable production version.

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

An Execution identifies one attempt and which runtime owns it. The contract can
bind a stable external ID. The Node SDK's BullMQ lifecycle bridge can reserve a
Task/Execution before `Queue.add()` through `dispatch()`/`dispatchMany()`, or
observe a job the application already enqueued through `track()`. It does
**not** take over Redis, rewrite workers or discover all queue work after
downtime.

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

The embedded Node client exposes the Task contract directly through the
application's PostgreSQL pool. The legacy/full HTTP Gateway exposes the same
polling-first contract. The typed Node client
has `createTask`, `getTask`, `transitionTask`, `reportTaskProgress`,
`attachTaskResult`, `createTaskExecution` and `bindTaskExecution`; see
[Node.js integration](./nodejs.md). Gateway deployment is not end-user auth:
keep it on loopback or put it behind your own TLS, network policy and access
control.

## What this proves—and what it does not

This path proves a versioned Task contract across Go, PostgreSQL, HTTP and Node.
Its current boundaries are:

- BullMQ integration requires explicit `dispatch()`/`dispatchMany()` or
  `track()`; it does not scan a queue or reconcile unknown jobs;
- no composed retry command creates a new Execution atomically;
- the React adapter uses TaskStore polling; no SSE/WebSocket or stream transport
  exists;
- `OwnerID` is returned for application authorization and optional owner-scoped
  polling/cancel credentials are available, but organization membership/RBAC
  is not implemented;
- result references are not proxied or downloaded by RhinoQ.

Read [Task Platform](./task-platform.md) for the exact implementation status.
For a second real application, follow the
[existing-queue evaluation protocol](./evaluation-existing-queue.md) so the
feedback measures adoption cost instead of only confirming happy-path API calls.

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
