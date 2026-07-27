# RhinoQ

<p align="center">
  <img src="./docs/assets/rhinoq-hero.png" alt="RhinoQ — a durable business-integrity job queue" width="100%" />
</p>

<p align="center">
  <strong>Durable background jobs with explicit effect confirmation and business outcome verification.</strong>
</p>

<p align="center">
  PostgreSQL-backed · Go runtime · TypeScript SDK in progress
</p>

<p align="center">
  <a href="https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml"><img src="https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml"><img src="https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml/badge.svg" alt="Security" /></a>
  <img src="https://img.shields.io/badge/Go-1.22%2B-00ADD8?logo=go&logoColor=white" alt="Go 1.22+" />
  <img src="https://img.shields.io/badge/status-active_development-2563eb" alt="Active development" />
</p>

> [!WARNING]
> RhinoQ is under active development. The API, storage schema, and protocol are not stable yet. The project has not completed its PostgreSQL integration, fault-testing, or reproducible benchmark release gates.

## Why RhinoQ

Most job queues answer an execution question:

> Did a worker finish this job?

Business-critical background work often needs two more answers:

> Did the external effect actually happen?
>
> Did the business state reach the intended outcome?

RhinoQ keeps these states separate:

```text
request accepted  ≠  effect confirmed  ≠  outcome achieved
```

That distinction matters when a provider returns `202 Accepted`, a worker crashes after an external call, a retry may repeat an irreversible effect, or a handler completes while the application state remains inconsistent.

RhinoQ is designed for report generation, media processing, data synchronization, account provisioning, notifications, payments, credits, inventory, and other background work where execution state alone is not enough.

## Integrity lifecycle

RhinoQ organizes work into four explicit stages:

| Stage | Question | RhinoQ mechanisms | Current status |
|---|---|---|---|
| **COMMIT** | Was the work recorded durably? | idempotency, correlation, payload validation, outbox foundation | Foundation implemented |
| **RUN** | Can the work execute and recover safely? | claims, leases, heartbeat, retries, cancellation, rate limits | Core implemented |
| **VERIFY** | Did declared effects and outcomes really happen? | Effect Ledger, confirmation policy, Outcome contracts | Foundation implemented |
| **RECOVER** | Can an operator investigate and repair safely? | Needs Attention, replay policy, repair preview, audit | In progress |

RhinoQ is a job queue, not a message broker and not a workflow engine. Topic routing, fan-out, and general-purpose orchestration are intentionally outside the core product.

## Quickstart

The repository includes a runnable in-memory example:

```bash
go run ./examples/basic
```

Using the public Go API:

```go
queue := rhinoq.NewInMemory()

err := queue.Handle("generate-report", func(ctx context.Context, job rhinoq.Job) error {
    return reports.Generate(ctx, job.Payload)
})
if err != nil {
    log.Fatal(err)
}

jobID, err := queue.Enqueue(
    ctx,
    "generate-report",
    []byte(`{"reportId":"report_01"}`),
    "report:report_01",
)
if err != nil {
    log.Fatal(err)
}

log.Printf("enqueued %s", jobID)

if err := queue.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
    log.Fatal(err)
}
```

`NewInMemory` is intended for local development and tests. It does not survive a process restart.

For PostgreSQL-backed storage:

```go
queue, err := rhinoq.NewPostgres(db)
if err != nil {
    log.Fatal(err)
}
```

Apply the schema in [`internal/infrastructure/migrations/001_initial.sql`](./internal/infrastructure/migrations/001_initial.sql) before starting PostgreSQL-backed workers. A real-database integration harness is still a release blocker.

## Queue operations

Runtime controls are exposed through the same client boundary:

```go
// Global fixed-window limit shared by all workers for this queue.
err := queue.SetRateLimit(ctx, "provider-sync", 100, time.Minute)

// Cooperative cancellation.
err = queue.Cancel(ctx, jobID)

// Bounded operational queries for a future Console or internal tooling.
counts, err := queue.JobCounts(ctx, "provider-sync")
jobs, err := queue.ListJobs(ctx, rhinoq.JobQuery{
    Queue:  "provider-sync",
    States: []string{"pending", "blocked", "dead"},
    Offset: 0,
    Limit:  100,
})
```

List responses intentionally exclude payloads so an operational queue view does not become an accidental bulk data-export path.

## Implemented capabilities

### Durable execution

- Namespaced idempotent enqueue
- PostgreSQL and in-memory job stores
- Batch claim with PostgreSQL `FOR UPDATE SKIP LOCKED`
- Lease ownership, heartbeat renewal, and expired-lease recovery
- Bounded worker concurrency and graceful shutdown
- Delayed execution through `not_before`
- Classified retry with exponential backoff and bounded jitter

### Runtime control

- Pause and resume by queue name
- Cooperative cancellation for leased jobs
- Immediate cancellation for waiting jobs
- Durable global fixed-window rate limiting per queue
- Job counts, state filters, and bounded pagination

### Integrity foundations

- Effect Ledger with per-effect confirmation policy
- Explicit effect states including uncertain and confirmed
- Outcome records separated from execution completion
- Outbox storage and publisher runtime
- Fail-closed handling for unknown error classes

See the [feature matrix](./docs/feature-matrix.md) for implemented, partial, and planned behavior.

## Architecture

The Go engine owns correctness. SDKs and future framework integrations remain thin clients.

```text
Application / SDK / CLI
          │
          ▼
  Public Go API and protocol
          │
          ▼
   Application use cases
          │
          ▼
 Domain state machines ───── Runtime workers
          │                       │
          └──────── Ports ────────┘
                      │
                      ▼
          Memory / PostgreSQL adapters
                      │
                      ▼
          PostgreSQL / external providers
```

Dependency rules:

- Domain code does not import databases, frameworks, transports, or provider clients.
- Application services coordinate use cases through ports.
- Adapters implement ports and do not own business invariants.
- Runtime code owns claiming, leases, retries, concurrency, and process lifecycle.
- Effect confirmation and outcome verification are not inferred from logs or handler return values.

Read the full [architecture blueprint](./ARCHITECTURE.md).

## Repository map

```text
cmd/                              agent, worker, and CLI entrypoints
internal/
  domain/                         job, retry, effect, and outcome invariants
  application/                    enqueue, execution, verification, operations
  ports/                          core storage and runtime interfaces
  adapters/                       memory and PostgreSQL implementations
  runtime/                        worker, lease, scheduler, shutdown, supervisor
  infrastructure/                configuration, health, and migrations
pkg/rhinoq/                       public Go API
proto/rhinoq/v1/                  versioned transport contracts
sdks/typescript/                  developer-facing TypeScript SDK
tests/                            unit, integration, fault, and benchmark gates
docs/                             user and operator documentation
.ai/                              project memory and AI workflow controls
```

## Project status

RhinoQ currently has a runnable Go core and testable memory adapter. PostgreSQL adapters and migrations are implemented, but production readiness still requires evidence from a real PostgreSQL integration environment.

The next engineering priorities are:

1. PostgreSQL integration and fault-test harnesses
2. Lease epoch fencing
3. DLQ and Needs Attention APIs
4. Controlled replay with immutable audit
5. Admission control, metrics, and tracing
6. Stable Agent protocol and TypeScript SDK
7. Reproducible benchmark suite

RhinoQ does not publish throughput or latency claims without a repeatable benchmark that records hardware, payload, durability, worker count, and workload.

## Documentation

| Document | Purpose |
|---|---|
| [Getting started](./docs/getting-started.md) | local setup and runnable commands |
| [Configuration](./docs/configuration.md) | runtime configuration contract |
| [PostgreSQL](./docs/postgres.md) | persistence model and migration notes |
| [Operations](./docs/operations.md) | shutdown, cancellation, rate limits, and inspection |
| [Failure semantics](./docs/failure-semantics.md) | retry classes and effect uncertainty |
| [Feature matrix](./docs/feature-matrix.md) | implementation status by capability |
| [Roadmap](./docs/roadmap.md) | milestones and release gates |
| [Product specification](./RHINOQ.md) | complete product and architecture specification |

## Development

Requirements:

- Go 1.22 or newer
- Node.js 22 or newer for the TypeScript SDK
- PostgreSQL for persistence integration work

Run the Go quality gates:

```bash
gofmt -w cmd internal pkg tests
go test ./...
go vet ./...
```

Run the CLI:

```bash
go run ./cmd/rhinoq-cli doctor
go run ./cmd/rhinoq-cli init
go run ./cmd/rhinoq-cli init --apply
```

Validate the TypeScript SDK:

```bash
npm --prefix sdks/typescript install
npm --prefix sdks/typescript run typecheck
```

Before changing code, read [AGENTS.md](./AGENTS.md), [ARCHITECTURE.md](./ARCHITECTURE.md), and [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security and licensing

Report security issues according to [SECURITY.md](./SECURITY.md). Do not open a public issue for an undisclosed vulnerability.

This repository does not currently grant an open-source license. The project remains under private development while the open-core boundary and license are evaluated. See [LICENSE-STRATEGY.md](./LICENSE-STRATEGY.md).

---

<p align="center">
  <strong>Run the job. Confirm the effect. Verify the outcome.</strong>
</p>
