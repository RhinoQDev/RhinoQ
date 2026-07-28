# RhinoQ

<p align="center">
  <img src="./docs/assets/rhinoq-hero.png" alt="RhinoQ — PostgreSQL background jobs with business integrity" width="100%" />
</p>

<p align="center">
  <strong>Run background jobs, verify the business result, and surface drift before users do.</strong>
</p>

<p align="center">
  Embedded Go · PostgreSQL · durable workers · integrity Rules · operator inbox
</p>

<p align="center">
  <a href="https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml"><img src="https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml"><img src="https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml/badge.svg" alt="Security" /></a>
  <img src="https://img.shields.io/badge/Go-1.22%2B-00ADD8?logo=go&logoColor=white" alt="Go 1.22+" />
  <img src="https://img.shields.io/badge/PostgreSQL-16_tested-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL 16 tested" />
  <img src="https://img.shields.io/badge/status-active_development-f59e0b" alt="Active development" />
</p>

> [!WARNING]
> RhinoQ is in active development. Public APIs, migrations, and protocols are not stable, and no production-ready release has been published. Use it for evaluation and controlled environments until the release gates are complete.

## What RhinoQ changes

A queue normally tells you whether a handler returned successfully. It cannot
know whether a report file exists, every media rendition was produced, two
systems agree, or an account actually reached its provisioned state.

RhinoQ keeps three facts separate:

```text
request accepted  ≠  effect confirmed  ≠  outcome achieved
```

That separation gives operators a safer answer when a provider returns
`202 Accepted`, a worker dies after an external call, a retry could repeat an
effect, or execution succeeds while business data remains inconsistent.

RhinoQ combines four layers:

| Layer | Responsibility | Examples |
|---|---|---|
| **COMMIT** | Record work durably | transactional enqueue, idempotency, correlation |
| **RUN** | Execute and recover safely | claims, fenced leases, heartbeat, retries, cancellation |
| **VERIFY** | Check declared business invariants | versioned Rules, bounded evaluation, Effect Ledger |
| **RECOVER** | Make drift operable | Needs Attention, Findings, guarded replay, audit |

RhinoQ is not an AI product. It does not need an LLM, an autonomous agent, or
an external control plane. Rules are deterministic checks written and reviewed
by developers.

## Start with the smallest deployment

The default architecture is one Go application and the PostgreSQL database it
already uses:

```text
┌──────────────── Go application ────────────────┐
│ producer + handlers + RhinoQ worker/scheduler │
└──────────────────────┬─────────────────────────┘
                       │ database/sql
                       ▼
                  PostgreSQL
```

There is no required RhinoQ server. The optional binary currently named
`rhinoq-agent` is an authenticated HTTP gateway for non-Go workers; it is not
an AI agent and is not part of the default setup.

## Quick start

### 1. Install

```bash
go get github.com/rhinoq/rhinoq
go get github.com/jackc/pgx/v5
go install github.com/rhinoq/rhinoq/cmd/rhinoq@latest
```

During active development, pin the exact pseudo-version written to `go.mod`
instead of silently upgrading production builds.

### 2. Configure and prepare PostgreSQL

```bash
export RHINOQ_DATABASE_URL='postgres://postgres:postgres@localhost:5432/app?sslmode=disable'

rhinoq migrate plan
rhinoq migrate apply
rhinoq doctor --ci
```

`migrate plan` and `migrate status` are read-only. `migrate apply` is the
explicit write action; it verifies immutable checksums, takes a PostgreSQL
advisory lock, and commits one migration at a time. RhinoQ will not guess a
baseline when it finds old untracked tables.

### 3. Embed a worker

```go
package main

import (
    "context"
    "database/sql"
    "errors"
    "log"
    "os"

    _ "github.com/jackc/pgx/v5/stdlib"
    "github.com/rhinoq/rhinoq/pkg/rhinoq"
)

func main() {
    ctx := context.Background()

    db, err := sql.Open("pgx", os.Getenv("RHINOQ_DATABASE_URL"))
    if err != nil {
        log.Fatal(err)
    }
    defer db.Close()

    queue, err := rhinoq.NewPostgres(db)
    if err != nil {
        log.Fatal(err)
    }

    if err := queue.Handle("generate-report", func(ctx context.Context, job rhinoq.Job) error {
        // Decode job.Payload and call application code here.
        return reports.Generate(ctx, job.Payload)
    }); err != nil {
        log.Fatal(err)
    }

    jobID, err := queue.Enqueue(ctx, rhinoq.JobRequest{
        Name:           "generate-report",
        Payload:        []byte(`{"reportId":"report_01"}`),
        IdempotencyKey: "report:report_01",
        CorrelationID:  "report_01",
    })
    if err != nil {
        log.Fatal(err)
    }
    log.Printf("enqueued %s", jobID)

    if err := queue.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
        log.Fatal(err)
    }
}
```

`NewInMemory()` is available for unit tests and examples, but it loses every
job when the process exits. Use `NewPostgres()` for durable work.

## Verify business state

A table Rule is an append-only, versioned invariant. This example finds reports
that claim to be ready but have no output object:

```go
record, err := queue.RegisterRule(ctx, rhinoq.RuleDefinition{
    ID:          "ready-report-has-output",
    Name:        "Ready reports have an output object",
    Scope:       rhinoq.RuleScopeTable,
    SubjectType: "report",
    Query: `
        SELECT
            id::text AS subject_id,
            output_key IS NULL AS violated,
            jsonb_build_object('status', status) AS evidence
        FROM reports
        WHERE created_at >= $1
          AND id::text > $2
        ORDER BY id::text
        LIMIT $3`,
    BaselineAt: time.Now().Add(-24 * time.Hour),
    Every:      10 * time.Minute,
    MaxRows:    250,
})
if err != nil {
    log.Fatal(err)
}

_, explanation, err := queue.EnableRule(ctx, record.ID)
if err != nil {
    log.Fatalf("Rule rejected by Explain gate: %v (%v)", err, explanation.Reasons)
}
```

Enabling a Rule first checks its result contract, statement timeout, row limit,
plan cost, and large sequential scans. Evaluation runs in a read-only
transaction. The SQL guard is not a security sandbox, so production Rules
should use a restricted read-only database role.

Run the durable scheduler inside the application:

```go
go func() {
    if err := queue.RunRuleScheduler(ctx, rhinoq.RuleSchedulerConfig{
        Owner:        "integrity-1",
        PollInterval: time.Second,
        Lease:        time.Minute,
        ClaimBatch:   4,
    }); err != nil {
        log.Printf("Rule scheduler stopped: %v", err)
    }
}()
```

Or run the same scheduler as a manual process:

```bash
rhinoq rules run --owner integrity-1
```

Its cursor and lease are persisted. Another process can resume a bounded page
after a crash, while owner/epoch fencing prevents a stale scheduler from
advancing the Rule. Disabling a Rule prevents future claims but allows a page
already claimed under that immutable version to finish.

## Operate without a dashboard

The CLI connects directly to PostgreSQL. List commands omit job payloads by
default so an operator view does not become an accidental data-export path.
Bounded list and inbox commands support `--limit` and `--offset` for predictable
pagination.

```bash
rhinoq doctor --ci
rhinoq jobs list --queue generate-report --states pending,blocked,dead
rhinoq queue counts generate-report
rhinoq queue pause generate-report
rhinoq queue resume generate-report

rhinoq attention
rhinoq findings list --statuses open,regressed,acknowledged
rhinoq rules list --limit 100
rhinoq explain ready-report-has-output
```

Needs Attention combines execution failures, uncertain effects, outcome
mismatches, and live persistent Findings in one bounded inbox. Suppressed or
resolved Findings are excluded. A queue filter never guesses a business
Finding's queue when no safe mapping exists.

Operator decisions are explicit and auditable:

```bash
rhinoq findings acknowledge \
  --rule ready-report-has-output \
  --subject-type report \
  --subject report_01 \
  --version 1 \
  --actor operator@example.com

rhinoq findings resolve \
  --rule ready-report-has-output \
  --subject-type report \
  --subject report_01 \
  --version 1 \
  --actor operator@example.com \
  --reason 'output restored'
```

## Effects are declared one by one

Business criticality belongs to a job; reversibility and confirmation belong
to each effect. A single job may upload an idempotent object, reserve something
reversibly, charge a card irreversibly, and send a duplicate-tolerant
notification.

`job.Effect(...)` therefore requires an idempotency key and an explicit
confirmation policy. A returned `202 Accepted` must use external confirmation
or verification; it must not be recorded as confirmed merely because the HTTP
request returned.

See [failure semantics](./docs/failure-semantics.md) for the exact uncertain,
confirmed, retry, and fail-closed behavior.

## Integration choices

| Mode | Extra process | Best fit |
|---|---:|---|
| **Embedded Go** | No | Go application owns producers and workers |
| **Transactional SQL enqueue** | No | Any ORM needs to create a job in the same business transaction |
| **Optional HTTP gateway** | Yes | A non-Go service must run the full worker protocol |

Migration `003_sql_enqueue.sql` installs `rhinoq.enqueue()`, with producer-role
allowlists, payload limits, schema checks, and idempotency. See the
[optional HTTP gateway guide](./docs/agent.md) before introducing another
process.

## Safety and performance model

- PostgreSQL `FOR UPDATE SKIP LOCKED` batch claims.
- Priority ordering with FIFO inside a priority and bounded aging.
- Slot-driven prefetch and adaptive idle polling.
- Owner/epoch fencing on every lease-sensitive write.
- One-round-trip heartbeat, lease renewal, and cancellation observation.
- Global queue rate limits and producer admission budgets.
- Poison-job parking after repeated worker crashes.
- Partial indexes for hot pending/admission paths.
- Durable Rule cursors; only due enabled Rules are claimed.
- Database time is authoritative for leases, delays, and rate windows.
- Payload-free bounded operational list APIs.

RhinoQ does not publish throughput or latency numbers without a reproducible
benchmark that records hardware, payload, worker count, durability settings,
and workload. It is not optimized for the same latency and throughput target as
a Redis queue; capacity must be established against the workload that will
actually run.

## When to evaluate something else

RhinoQ is intentionally not a message broker or a general-purpose workflow
orchestrator. Choose a mature alternative first when you primarily need:

- a high-throughput Redis queue with a large Node ecosystem;
- topic routing, fan-out, or broker semantics;
- DAG/workflow authoring and durable application checkpoints;
- only a minimal PostgreSQL task queue and no integrity workflow.

RhinoQ is most relevant when the unresolved problem is operational:
background execution exists, but teams still use reconciliation cron jobs,
incident SQL, and manual investigation to learn whether business state is
actually correct.

## Current scope

Implemented and covered by automated tests:

- PostgreSQL and in-memory queues;
- idempotent enqueue, delayed work, priority, admission, rate limits;
- fenced claims, heartbeat, cancellation, retries, reaping, graceful shutdown;
- per-effect confirmation policies and uncertain-effect fail-closed behavior;
- versioned job/table Rules with Explain and bounded evaluation;
- persistent Findings with acknowledgement, suppression, resolution, and regression;
- crash-safe periodic Rule scheduling;
- unified Needs Attention inbox;
- guarded replay and tamper-evident replay audit;
- direct PostgreSQL migration, diagnostics, inspection, and control CLI;
- transactional SQL enqueue and an optional authenticated HTTP gateway.

Still required before a stable release:

- observe-only correlation with an existing execution system;
- business-key timeline across execution, effects, Rules, and Findings;
- bounded `scan` onboarding;
- retention/partition guidance, restore tests, fault-injection evidence;
- reproducible performance benchmarks and external production evidence;
- stable public API, upgrade policy, and security review.

See the [feature matrix](./docs/feature-matrix.md) and
[roadmap](./docs/roadmap.md) for the maintained status.

## Architecture and repository

The Go engine owns correctness. Domain packages do not depend on PostgreSQL,
HTTP, frameworks, or provider clients; application services coordinate ports;
adapters implement persistence; runtime packages own concurrent process
lifecycle.

```text
cmd/                    CLI, worker, and optional HTTP gateway entrypoints
internal/
  domain/               state machines and invariants
  application/          use cases and orchestration
  ports/                storage/runtime contracts
  adapters/             memory and PostgreSQL implementations
  runtime/              worker, lease, scheduler, shutdown, supervisor
  infrastructure/       configuration, health, migrations
pkg/rhinoq/             public embedded Go API
proto/rhinoq/v1/        versioned transport contracts
sdks/typescript/        optional HTTP gateway client
tests/                  unit, integration, PostgreSQL, fault, benchmark gates
docs/                   developer and operator documentation
.ai/                    project memory and AI workflow controls
```

Read [ARCHITECTURE.md](./ARCHITECTURE.md) and the
[runtime flow diagrams](./docs/runtime-flows.md) before changing a layer
boundary.

## Documentation

| Guide | Use it for |
|---|---|
| [Getting started](./docs/getting-started.md) | installation, migration, first durable worker |
| [Configuration](./docs/configuration.md) | environment and runtime tuning |
| [PostgreSQL](./docs/postgres.md) | schema lifecycle, pools, query costs |
| [Operations](./docs/operations.md) | queue controls, shutdown, rate limits |
| [Recovery](./docs/recovery.md) | Needs Attention, Findings, replay, audit |
| [Integrity Rules](./docs/rules.md) | Rule contract, Explain, evaluation, scheduler |
| [Failure semantics](./docs/failure-semantics.md) | retry and Effect Ledger decisions |
| [Optional HTTP gateway](./docs/agent.md) | non-Go worker integration; no AI/LLM |
| [Competitive landscape](./docs/competitive-landscape.md) | product boundaries and primary sources |
| [Product specification](./RHINOQ.md) | detailed product and architecture contract |

## Development

Requirements: Go 1.22+, PostgreSQL for real-database tests, and Node.js 22+ only
when changing the TypeScript client.

```bash
go test ./... -count=1
go vet ./...
npm --prefix sdks/typescript run typecheck
```

Run the CLI from source:

```bash
go run ./cmd/rhinoq migrate plan
go run ./cmd/rhinoq doctor
```

Every user-visible capability or behavior change must update this README in the
same change, or record why no README change is needed. See
[AGENTS.md](./AGENTS.md), [CONTRIBUTING.md](./CONTRIBUTING.md), and the
[Definition of Done](./.ai/DEFINITION_OF_DONE.md).

## Security and licensing

Report undisclosed vulnerabilities through [SECURITY.md](./SECURITY.md), not a
public issue.

This repository does not currently grant an open-source license. The project
remains under private development while its open-core boundary and license are
evaluated. See [LICENSE-STRATEGY.md](./LICENSE-STRATEGY.md).

---

<p align="center">
  <strong>Run the job. Confirm the effect. Verify the outcome.</strong>
</p>
