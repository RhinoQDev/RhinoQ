# RhinoQ

<p align="center">
  <img src="./docs/assets/rhinoq-hero.png" alt="RhinoQ — make long-running work easy to build and safe to operate" width="100%" />
</p>

<p align="center">
  <strong>Your queue stays. Your workers stay. RhinoQ adds the user-facing task layer.</strong>
</p>

<p align="center">
  Durable task lifecycle · existing-runtime adapters · optional business verification
</p>

<p align="center">
  <a href="https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml"><img src="https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml"><img src="https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml/badge.svg" alt="Security" /></a>
  <img src="https://img.shields.io/badge/Go-1.25%2B-00ADD8?logo=go&logoColor=white" alt="Go 1.25+" />
  <img src="https://img.shields.io/badge/PostgreSQL-16_tested-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL 16 tested" />
  <img src="https://img.shields.io/badge/status-active_development-f59e0b" alt="Active development" />
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0" /></a>
</p>

> [!WARNING]
> RhinoQ is in active development. Public APIs, migrations and protocols are not
> stable, and no release has been tagged. Use it for evaluation and controlled
> environments until the release gates in [`docs/roadmap.md`](./docs/roadmap.md)
> are complete.

The current security baseline and its unresolved release blockers are recorded
in [the 2026-07-29 security audit](./docs/security-audit-2026-07-29.md).
The optional HTTP Gateway binds to loopback by default and requires a bearer
token of at least 32 bytes; remote deployment still requires TLS termination,
network policy and a future role/tenant authorization model.

## RhinoQ is a Task Platform with an optional Verified Tasks layer

RhinoQ gives applications a durable, user-facing lifecycle for asynchronous
work: task ownership, execution, progress, cancellation, retry, history and
result delivery. It is designed to sit above an existing queue or worker, so a
team can adopt the task layer without rewriting its business logic or moving
its queue on day one.

The current repository is still in active development. A first Go Task facade,
versioned HTTP polling endpoint, result-reference delivery and typed Node
client now exist. ProviderOperation, runtime adapters, result payload transport
and a frontend component are not complete yet. The mature capability today
remains the Go/PostgreSQL job runtime and the optional Verified Tasks foundation
described below.

When a task has an irreversible external effect or a business invariant that
must be proved, Verified Tasks adds Effect Ledger, outcome observation, Rules,
Findings and reconciliation.

### First Task polling slice

The initial public contract is intentionally polling-first:

```go
client := rhinoq.NewInMemory() // use NewPostgres(db) for durable state
snapshot, err := client.CreateTask(ctx, rhinoq.TaskCreateRequest{
    ID: "report_01", Type: "report.export", DefinitionVersion: 1,
})
snapshot, err = client.QueueTask(ctx, snapshot.ID, snapshot.EntityVersion)
snapshot, err = client.GetTask(ctx, snapshot.ID)
result, err := client.AttachTaskResult(
    ctx, snapshot.ID, snapshot.EntityVersion, "s3://reports/report_01.pdf",
)
```

Every mutation requires the last `EntityVersion`; stale writers receive
`ErrTaskVersionConflict`. The optional Gateway exposes the same contract at
`POST /v1/tasks` and `GET /v1/tasks/{id}`. Result references use a separate
endpoint so ordinary polling does not repeatedly expose storage locations.
This slice does not yet dispatch a Task to BullMQ/native Job automatically or
proxy result payloads.

## Strengths that exist in the repository today

| Strength | Current evidence | Boundary |
|---|---|---|
| One Task contract for BE and FE | Go facade, HTTP Snapshot v1 and typed Node client share version/progress/result/execution semantics | no React hook or realtime transport yet |
| Stale writes fail closed | Task and child Execution mutations advance one aggregate `entityVersion`; memory, HTTP and PostgreSQL tests cover conflicts | multi-client reconnect still needs browser/property tests |
| Runtime correctness stays server-side | lease epoch fencing, DB-authored time, bounded retry/reaper and Effect Ledger live in Go/PostgreSQL | external-runtime adapter is not implemented yet |
| Existing systems are not forced into Verified Tasks | Task state is independent from Effect, Outcome, Rule and Finding state | no real design-partner adoption measurement yet |
| Unknown provider outcomes are modeled safely | Effect Ledger distinguishes pending, confirmed and uncertain instead of treating callback return as business success | generic ProviderOperation remains planned |

These are implementation strengths, not proof that RhinoQ reduces plumbing or
wins adoption. Those product hypotheses and their failure criteria are tracked
in [Product strengths](./docs/product-strengths.md) and
[Product evidence](./docs/product-evidence.md).

## Verified Tasks: technical success is not business success

A job queue knows one thing: whether your handler returned without throwing. If
it did, the job is marked succeeded and disappears from the dashboard.

That is not the same question as whether the work happened:

- The payment provider returned `202 Accepted`, but the order is still `pending`
  an hour later.
- The card was charged, then the inventory deduction timed out. The queue shows
  two green jobs.
- The worker was killed after calling the provider but before recording it. On
  retry, does the customer get charged twice?
- The report row says `completed`, but the output object was never written.

**Technical success is not business success.** When the two diverge, most teams
find out when a customer complains, and then write another reconciliation cron
job — a script nobody owns, that nobody tests, and that silently rots.

RhinoQ makes that reconciliation a first-class, versioned, reviewed part of the
system.

## RhinoQ keeps three facts apart

```text
request accepted   ≠   effect confirmed   ≠   outcome achieved
```

A queue only records the first. RhinoQ records all three, and tells you when
they stop agreeing.

| Layer | Question it answers |
|---|---|
| **COMMIT** | Was the work durably recorded, exactly once? |
| **RUN** | Did it execute safely, and recover if the worker died? |
| **VERIFY** | Does the business state actually satisfy the invariant? |
| **RECOVER** | Is the drift visible, triaged, and auditable? |

RhinoQ is not an AI product. It needs no LLM, no agent and no control plane.
Rules are deterministic SQL checks written and reviewed by developers.

## You do not have to adopt a queue to use this

This is the part most tools get backwards. If your work already runs somewhere —
cron, BullMQ, Sidekiq, Celery, Temporal, a hand-written worker — you can point
RhinoQ at your database and get a first finding without moving any of it.

```go
integrity, err := rhinoq.NewIntegrity(db)
```

That handle starts **no worker, no claim loop, no heartbeat, no retry scheduler,
no lease reaper and no recovery executor**. A regression test asserts its method
set stays free of them. Its only long-running operation claims Rule schedules,
not jobs.

Adopting the durable runtime later is not a rewrite: `*Client` embeds the same
facade, so the Rules and Findings you registered are the same rows in the same
tables.

## Quick start: your first finding, no cutover

**1. Install and prepare your database.**

```bash
go install github.com/madebyduy/RhinoQ/cmd/rhinoq@latest

export RHINOQ_DATABASE_URL='postgres://user:pass@localhost:5432/app?sslmode=disable'
rhinoq migrate plan     # read-only: shows exactly what will change
rhinoq migrate apply
rhinoq doctor --ci
```

**2. Declare an invariant.** A Rule is a bounded SQL query returning three
canonical columns — `subject_id`, `violated`, `evidence`:

```go
integrity, _ := rhinoq.NewIntegrity(db)

integrity.RegisterRule(ctx, rhinoq.RuleDefinition{
    ID:          "completed-report-has-output",
    Name:        "Completed reports have an output object",
    Scope:       rhinoq.RuleScopeTable,
    SubjectType: "report",
    Query: `SELECT
        id::text AS subject_id,
        CASE WHEN status = 'completed' THEN output_key IS NULL ELSE false END AS violated,
        jsonb_build_object('status', status, 'outputKey', output_key) AS evidence
      FROM reports
      WHERE updated_at >= $1
        AND (($4::text = '' AND id::text > $2) OR id::text = $4)
      ORDER BY id::text
      LIMIT $3`,
    BaselineAt: time.Now().Add(-24 * time.Hour),
    Every:      10 * time.Minute,
})
```

`$1` is the baseline, `$2` the cursor, `$3` the page limit, `$4` an optional
single-subject filter. RhinoQ supplies them and wraps the query in a hard limit;
you never write the paging loop.

**3. Prove it is safe, then run it.**

```bash
rhinoq explain completed-report-has-output   # plan cost, timeout, result shape
rhinoq rules enable completed-report-has-output
rhinoq scan completed-report-has-output
```

```text
Rule:              completed-report-has-output
Pages:             12
Observed:          5842
Passed:            5830
Violated:          12
Unknown:           0
Findings touched:  12
Status:            complete
```

A runnable version, including the fixture table, is in
[`examples/integrity-only`](./examples/integrity-only).

## What makes the VERIFY layer trustworthy

Anyone can run a SQL query on a cron. These are the parts that make it something
you can rely on at 3am.

**Rules are versioned and gated.** Registering the same Rule ID appends an
immutable version. Enabling one runs PostgreSQL `EXPLAIN` in a read-only
transaction and checks plan cost, statement timeout, result shape and sequential
scan size. An unsafe Rule stays a draft. The plan evidence is persisted.

> The syntax guard is not a SQL sandbox. Give Rules a dedicated read-only
> PostgreSQL role in production. RhinoQ says this plainly rather than implying a
> safety it does not have.

**Evaluation is bounded, resumable and crash-safe.** Every pass is limited by
page count, wall-clock budget and the Rule's own row limit. The scheduler holds
an owner/epoch-fenced lease with a durable cursor, so a crashed process resumes
where it stopped instead of restarting or skipping.

**Observations have three states, not two.**

| `violated` | Meaning |
|---|---|
| `true` | the invariant is broken |
| `false` | the invariant holds |
| `NULL` | **the check could not decide** |

A provider timeout, a missing permission or evidence that has not arrived yet is
not a pass. Forced into a boolean, `false` reads as "this subject is fine" and
**silently resolves real drift** the moment a dependency becomes unreachable.
`NULL` follows the Rule's policy: retry quietly, or open a finding after a grace
period.

**Findings have a lifecycle, not just an alert.** Repeat violations deduplicate
into one finding. A passing recheck resolves it. Something that comes back is
marked `regressed` — the most important signal in the whole system, because it
means the repair did not fix the cause. Acknowledge, ignore and false-positive
all require a reason, and the suppressing ones expire, because a permanent
dismissal is how a real problem gets buried.

## When something is wrong: the investigation view

`rhinoq workbench` opens a local, read-only, loopback-only interface. Selecting a
finding opens the **business subject**, not the job:

- a verdict — clean, drift, or unknown;
- every execution that touched it, **whether RhinoQ ran it or BullMQ, Temporal,
  cron or your application did**;
- Effect Ledger entries and their confirmation state;
- what RhinoQ observed and what people decided, in one time-ordered narrative.

The Effect Ledger works without RhinoQ jobs. A BullMQ worker that just called a
payment provider can record it:

```go
integrity.RecordExternalEffect(ctx, rhinoq.ExternalEffectRequest{
    Execution:      rhinoq.ExecutionRef{SourceSystem: "bullmq", SourceID: job.ID},
    Subject:        rhinoq.SubjectRef{Type: "order", ID: orderID},
    Name:           "charge-card",
    IdempotencyKey: orderID + ":charge",
})
```

> This path is weaker than the runtime path, on purpose. An execution RhinoQ
> never leased has no lease to present, so nothing can fence it. Deduplication
> rests on the execution reference plus the idempotency key — the guarantee an
> external caller can actually provide. RhinoQ refuses to pretend otherwise.

## The optional runtime

If you also want the queue, it is one Go application and the PostgreSQL database
you already have:

```go
queue, err := rhinoq.NewPostgres(db)
queue.Handle("notifications", "send-welcome", func(ctx context.Context, job rhinoq.Job) error { … })
```

- **Transactional enqueue** — the job is created in your transaction. Roll back
  and it never existed. No phantom jobs.
- **Fenced leases** — `(lease_owner, lease_epoch)`, so a worker that lost its job
  cannot overwrite the one that took over.
- **Database clock** — PostgreSQL computes every deadline, so worker clock skew
  cannot expire a lease early or misfire a retry.
- **Effect Ledger** — declare what a handler is about to do to the outside world
  before it does it, so a crash mid-call leaves evidence instead of a mystery.
- **Guarded replay** — refuses to replay a job with a confirmed or uncertain
  irreversible effect, and writes a hash-chained audit entry for every decision.

No Redis. No Kafka. No extra cluster.

## When to use RhinoQ — and when not to

**Use it when** correctness matters more than raw throughput: payments, billing,
provisioning, order fulfilment, healthcare records, anything where a silent
mismatch becomes a support ticket or a compliance problem. Especially if you
already maintain hand-written reconciliation scripts.

**Use something else when:**

| You need | Use |
|---|---|
| Millions of messages per second | Kafka, or a Redis-backed queue |
| Fire-and-forget work where a silent failure is acceptable | BullMQ, Sidekiq, Celery |
| Long-lived multi-step workflow orchestration | Temporal, Restate, DBOS |
| A managed hosted queue with a UI today | Trigger.dev, Inngest |

RhinoQ is a young project. It does not have their maturity, their ecosystems or
their operational track record, and [`docs/competitive-landscape.md`](./docs/competitive-landscape.md)
compares them using their own documentation rather than strawmen.

## Why PostgreSQL

Redis is faster. But the VERIFY layer needs joins across business tables, MVCC
snapshots, transactional enqueue alongside your own writes, and durable cursors
that survive a crash. That is a relational database's job, and it is the database
your business data already lives in — so a Rule can read the orders table
directly instead of asking a queue to mirror it.

**On performance, RhinoQ publishes nothing yet.** There is no reproducible
benchmark in this repository, so there are no throughput numbers here and no
claim that RhinoQ is fast or slow relative to anything. A benchmark harness is a
release gate, not a marketing exercise. Until it exists and you can run it
yourself, treat any performance claim about RhinoQ — including ours — as
unproven.

What the code does guarantee structurally: claiming a batch costs exactly one
database round trip regardless of how many queues a worker subscribes to, and
the lease reaper drains expired work in bounded batches so a mass expiry cannot
lock the database it is recovering.

## Current state, honestly

| Area | State |
|---|---|
| TASK | **First polling slice.** Domains, PostgreSQL store, public Go facade, versioned HTTP polling, external/native Execution binding, separate result-reference API and typed Node client exist; runtime dispatch adapters, result payload transport and frontend components do not. |
| COMMIT · RUN | Mature. Fencing, retries, cancellation, admission, poison protection, all covered by a real-PostgreSQL suite. |
| VERIFY | Working and differentiated. Versioned Rules, Explain gate, three-state observations, bounded scans, durable scheduler. |
| RECOVER | **Split.** Runtime recovery — guarded replay of a dead job with audit — exists. **Business repair — investigate, propose, dry-run, approve, fix, re-verify — does not.** A finding today tells you something is wrong; acting on it is manual. |
| Distribution | No tagged release, no prebuilt binaries, `@rhinoq/node` unpublished. Install from source. |
| Benchmarks | Not started. |

[`.ai/STATUS.md`](./.ai/STATUS.md) tracks this per capability, and
[`docs/adoption-review.md`](./docs/adoption-review.md) lists what still blocks
adoption. Both are deliberately unflattering.

## Documentation

| Document | Contents |
|---|---|
| [Task Platform](./docs/task-platform.md) | product model, implemented foundation and planned slices |
| [Product evidence](./docs/product-evidence.md) | market evidence, unproven hypotheses and validation gates |
| [Product strengths](./docs/product-strengths.md) | implemented strengths, limits and proof still required |
| [Getting started](./docs/getting-started.md) | install, migrate, first job |
| [Integrity Rules](./docs/rules.md) | Rule contract, Explain, unknown handling, cursors |
| [CLI reference](./docs/cli.md) | every command, flag, exit code and write boundary |
| [Recovery](./docs/recovery.md) | Needs Attention, findings, guarded replay, audit |
| [Workbench](./docs/workbench.md) | local investigation interface |
| [Failure semantics](./docs/failure-semantics.md) | retry and Effect Ledger decisions |
| [Competitive landscape](./docs/competitive-landscape.md) | sourced comparison with adjacent tools |
| [Architecture](./ARCHITECTURE.md) | module boundaries and runtime layout |
| [Architecture review](./docs/architecture-review.md) | repository audit, large-repo comparison and accepted/refused patterns |

## Contributing

RhinoQ is looking for design partners who run payments, billing, provisioning or
fulfilment on PostgreSQL and already know the pain of silent mismatches. The
most useful contribution right now is not a pull request — it is telling us
which invariant you would want checked first, and whether a Rule can express it.

Open an [issue](https://github.com/madebyduy/RhinoQ/issues), or read
[CONTRIBUTING.md](./CONTRIBUTING.md) before sending code. Report vulnerabilities
through [SECURITY.md](./SECURITY.md), never a public issue.

Licensed under [Apache-2.0](./LICENSE).

---

<p align="center">
  <strong>Run the job. Confirm the effect. Verify the outcome.</strong>
</p>
