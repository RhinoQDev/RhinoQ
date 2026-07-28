# RhinoQ

<p align="center">
  <img src="./docs/assets/rhinoq-hero.png" alt="RhinoQ — a PostgreSQL job queue with business integrity" width="100%" />
</p>

<p align="center">
  <strong>Verify business outcomes and recover inconsistencies around durable background execution.</strong>
</p>

<p align="center">
  PostgreSQL job queue · Go runtime · business rules and findings in progress
</p>

<p align="center">
  <a href="https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml"><img src="https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml"><img src="https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml/badge.svg" alt="Security" /></a>
  <img src="https://img.shields.io/badge/Go-1.22%2B-00ADD8?logo=go&logoColor=white" alt="Go 1.22+" />
  <img src="https://img.shields.io/badge/status-active_development-2563eb" alt="Active development" />
</p>

> [!WARNING]
> RhinoQ is under active development. The API, storage schema, and protocol are not stable yet. PostgreSQL contract tests are running in CI, but fault injection, retention, security review, and reproducible benchmark release gates are not complete.

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

Durable execution systems already solve a large part of crash recovery through
checkpoints, journals, reliable calls, or transactional steps. RhinoQ does not
claim to replace them. Its narrower hypothesis is that business-outcome
verification and reverse reconciliation should be an operable integrity layer:
correlate the current execution system, evaluate an indexed invariant, persist
a finding, and make investigation or repair explicit and auditable.

## Who it is for

Evaluate RhinoQ when a team already has background execution but still relies
on reconciliation cron jobs, incident SQL, or manual checks to answer questions
such as:

- a report is marked complete, but its output object is missing;
- media processing finished, but one required rendition was never produced;
- a synchronization job completed, but source and destination disagree;
- an account workflow ran, but provisioning never reached the required state.

RhinoQ remains a PostgreSQL job queue. Its `scan`/observe-only adoption path is
planned so a team can evaluate outside-in rules against an existing BullMQ,
pg-boss, DBOS, or custom worker before deciding whether to adopt the queue.

If the requirement is only a mature Redis queue, a simple Node/PostgreSQL
queue, or a durable DAG/workflow runtime, evaluate BullMQ, pg-boss, Graphile
Worker, DBOS, Hatchet, Restate, or Temporal first.

## Integrity lifecycle

RhinoQ organizes work into four explicit stages:

| Stage | Question | RhinoQ mechanisms | Current status |
|---|---|---|---|
| **COMMIT** | Was the work recorded durably? | idempotency, correlation, payload validation, outbox foundation | Foundation implemented |
| **RUN** | Can the work execute and recover safely? | claims, leases, heartbeat, retries, cancellation, rate limits | Core implemented |
| **VERIFY** | Did declared effects and outcomes really happen? | Effect Ledger, versioned job/table Rules, PostgreSQL Explain gate | Manual bounded evaluation implemented; scheduling pending |
| **RECOVER** | Can an operator investigate and repair safely? | persistent findings, rule pass/regression, replay policy, audit | Rule-to-Finding lifecycle implemented; timeline pending |

RhinoQ's PostgreSQL-backed queue is part of the core product, but queue parity
is not its differentiator. It is not a message broker or a general-purpose
workflow engine. Topic routing, fan-out, and DAG orchestration are intentionally
outside the core product.

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

jobID, err := queue.Enqueue(ctx, rhinoq.JobRequest{
    Name:           "generate-report",
    Payload:        []byte(`{"reportId":"report_01"}`),
    IdempotencyKey: "report:report_01",
    Priority:       10,
})
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

Apply the migrations in [`internal/infrastructure/migrations/`](./internal/infrastructure/migrations/) in order before starting PostgreSQL-backed workers. The PostgreSQL contract and integrity suites run against a real database in CI; passing them is necessary but not sufficient evidence for production readiness.

## Queue operations

Runtime controls are exposed through the same client boundary:

```go
// Global fixed-window limit shared by all workers for this queue.
err := queue.SetRateLimit(ctx, "provider-sync", 100, time.Minute)

// Producer backpressure: past this budget the queue stops accepting work
// instead of growing until the database is the outage.
err = queue.SetAdmission(ctx, "provider-sync", rhinoq.AdmissionPolicy{
    MaxPending:       100_000,
    ReservedCritical: 5_000,
    OnOverflow:       rhinoq.OverflowReject,
})

// Stop claiming a queue whose downstream is down, without touching running work.
err = queue.Pause(ctx, "provider-sync")
err = queue.Resume(ctx, "provider-sync")

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
- Lease ownership fenced by owner and epoch, checked on every write
- Heartbeat renewal that extends the lease and reports cancellation in one round trip
- Bounded worker concurrency with slot-driven batch claim and prefetch
- Six-step graceful shutdown that never releases a lease a handler may still hold
- Delayed execution through `not_before`
- Classified retry with exponential backoff and bounded jitter

### Runtime control

- Priority with FIFO ordering inside a priority and aging against starvation
- Producer admission control with a reserved budget for critical work
- Poison-job protection that parks a payload which keeps taking workers down
- Pause and resume by queue name
- Cooperative cancellation for leased jobs
- Immediate cancellation for waiting jobs
- Durable global fixed-window rate limiting per queue
- Job counts, state filters, and bounded pagination
- Derived Needs Attention view across execution, effects, and outcomes
- Guarded dead/blocked replay with transactional hash-chained audit

### Polyglot integration

- Agent HTTP surface: one process owns correctness, clients stay thin
- Protocol handshake reporting compatible, degraded or rejected with reasons
- Language-neutral error envelope with retry classes and a grouping fingerprint
- `rhinoq.enqueue()` SQL function so any ORM can enqueue inside its own transaction
- Single-file TypeScript client as the reference port
- Separate `/health/live` and `/health/ready`, plus a dependency-free `/metrics` exporter

### Integrity foundations

- `job.Effect()` opens and resolves a provider call under an explicit confirmation policy
- Work an earlier attempt confirmed is skipped; work it left uncertain stops the job
- Effect Ledger with per-effect confirmation policy
- Explicit effect states including uncertain and confirmed
- Outcome records separated from execution completion
- Finding lifecycle domain rules for deduplication, acknowledgement, suppression, resolution and regression
- Persistent memory/PostgreSQL finding stores with append-only lifecycle events
- Public Go and Agent HTTP APIs for finding observation, filtering, transition and history
- Append-only job/table Rule definitions; new versions start in `draft`
- Read-only PostgreSQL Rule evaluation with timeout, hard result limit and cursor ordering
- Explain gate for result shape, plan cost and large sequential scans
- Rule violations open/deduplicate Findings; passing rechecks auto-resolve them
- Outbox storage and publisher runtime
- Fail-closed handling for unknown error classes

Persistent Rule scheduling, correlation timeline and the scan workflow are not
complete yet. The current code should not be presented as a finished integrity
product.

Using RhinoQ from another language needs one thin file, not a reimplementation. See the [Agent guide](./docs/agent.md).

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

RhinoQ has a runnable Go core, memory adapter, PostgreSQL adapters, migrations,
and a real-database contract suite. The RUN foundation is ahead of the product
differentiator: production readiness still requires fault evidence, while the
v0.1 Integrity Slice now has versioned Rules, an Explain safety gate and
Rule-to-Finding evaluation. It still needs crash-safe periodic scheduling,
scan/from-scan onboarding and the correlation timeline.

The next engineering priorities are:

1. Persistent scheduler cursor and crash-safe periodic Rule execution
2. Needs Attention backed by persistent Findings
3. Correlation timeline across job, attempt, effect, Rule, Finding and business state
4. A bounded `rhinoq scan` workflow and `init --from-scan` plan
5. Fault-injection, retention, security, and reproducible benchmark gates

RhinoQ does not publish throughput or latency claims without a repeatable benchmark that records hardware, payload, durability, worker count, and workload.

## Documentation

| Document | Purpose |
|---|---|
| [Getting started](./docs/getting-started.md) | local setup and runnable commands |
| [Configuration](./docs/configuration.md) | runtime configuration contract |
| [PostgreSQL](./docs/postgres.md) | persistence model and migration notes |
| [Operations](./docs/operations.md) | shutdown, cancellation, rate limits, and inspection |
| [Failure semantics](./docs/failure-semantics.md) | retry classes and effect uncertainty |
| [Recovery](./docs/recovery.md) | Needs Attention, guarded replay, and audit semantics |
| [Integrity Rules](./docs/rules.md) | canonical SQL contract, Explain gate and Finding evaluation |
| [Feature matrix](./docs/feature-matrix.md) | implementation status by capability |
| [Competitive landscape](./docs/competitive-landscape.md) | category boundaries, primary sources, and falsifiable differentiation |
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
