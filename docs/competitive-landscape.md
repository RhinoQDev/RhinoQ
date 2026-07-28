# Competitive landscape

> Last reviewed: 2026-07-28. This document compares product boundaries, not
> benchmark performance. Claims should be rechecked against primary sources
> before publication.

RhinoQ does not enter an empty category. PostgreSQL queues, durable execution
runtimes, and workflow platforms already solve large parts of reliable
background execution. The product hypothesis is narrower:

> Can a shared integrity layer make business-outcome verification and reverse
> reconciliation easier to adopt, operate, and audit without first replacing
> the application's current queue?

This is a hypothesis to validate, not a claim that no other system can express
an invariant in application code.

## Category map

### Queue libraries and PostgreSQL queue primitives

| Product                                             | Model                                     | Established strengths                                                                   | Consequence for RhinoQ                                                                              |
| --------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [BullMQ](https://github.com/taskforcesh/bullmq)     | Redis-backed Node.js queue                | mature queue ergonomics, retries, delayed jobs, rate limiting, events, flows, ecosystem | benchmark for RUN ergonomics; RhinoQ must not claim higher throughput without reproducible evidence |
| [pg-boss](https://github.com/timgit/pg-boss)        | PostgreSQL-backed Node.js queue           | transactional enqueue, `SKIP LOCKED`, scheduling, retries, no Redis dependency          | PostgreSQL and ACID enqueue are table stakes, not differentiation                                   |
| [Graphile Worker](https://worker.graphile.org/docs) | PostgreSQL worker, embedded or standalone | SQL enqueue, `SKIP LOCKED`, `LISTEN/NOTIFY`, cron, backfill and batch jobs              | a strong low-friction option for Node/PostgreSQL teams                                              |
| [PGMQ](https://github.com/pgmq/pgmq)                | PostgreSQL extension and SQL API          | visibility timeout, archive, FIFO/group/topic primitives                                | queue storage primitives alone do not justify RhinoQ                                                |

### Durable execution and orchestration

| Product                                                      | Model                                                           | Established strengths                                                                                                                                    | Relevant boundary                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [DBOS](https://docs.dbos.dev/)                               | in-process durable workflows with execution state in PostgreSQL | checkpoints, queues, recovery, transactions and language SDKs; [Lakebase integration](https://www.dbos.dev/blog/building-durable-agents-dbos-databricks) | eliminates many replay windows, especially for transactional database work |
| [Hatchet](https://github.com/hatchet-dev/hatchet)            | PostgreSQL-backed task and workflow platform                    | queues, DAGs, durable tasks, OTel, rate limits, priorities, fair scheduling, multi-tenancy and UI                                                        | substantially broader orchestration and operations surface                 |
| [Restate](https://docs.restate.dev/foundations/key-concepts) | durable runtime and SDKs                                        | journaled execution, reliable service calls, durable state, workflows and signals                                                                        | stronger durable-call abstraction than a conventional queue                |
| [Temporal](https://docs.temporal.io/)                        | durable workflow service or cloud                               | workflow history, activities, timers, signals, retries, versioning and production ecosystem                                                              | preferred when durable workflow semantics are the central problem          |
| [Inngest](https://www.inngest.com/docs)                      | event-driven durable functions                                  | managed execution, steps, retries, waits and observability                                                                                               | competes on adoption and developer experience                              |
| [Trigger.dev](https://trigger.dev/docs/introduction)         | managed or self-hosted background task platform                 | long-running tasks, checkpoint/resume, deployment and operational tooling                                                                                | competes on developer workflow and hosted operations                       |

## The DBOS boundary

DBOS materially weakens a broad claim that only an Effect Ledger can survive a
process crash around a side effect. Checkpointed workflows can skip work whose
completion was durably recorded, and a DBOS datasource transaction can provide
exactly-once database writes.

It is still incorrect to generalize this to exactly-once execution for every
external API. The official [DBOS Go Steps
tutorial](https://docs.dbos.dev/golang/tutorials/step-tutorial) states that
steps execute at least once: a crash after the side effect but before its
checkpoint can cause re-execution. An external Stripe, email, object-storage or
media-provider call therefore still needs one or more of:

- provider-enforced idempotency;
- a durable-call protocol with suitable guarantees;
- explicit effect evidence and confirmation;
- post-event reconciliation.

RhinoQ must present its Effect Ledger as one explicit evidence model for this
boundary, not as the only solution to durable external effects.

## Differentiation hypothesis

The candidate product boundary is:

- **VERIFY** — define an indexed business invariant, schedule verification,
  preserve evidence, and distinguish request acceptance, effect confirmation,
  and outcome achievement.
- **RECOVER** — scan from a business record back to intent, execution and
  effect evidence; deduplicate a persistent finding; apply acknowledgement,
  suppression, resolution and regression semantics; require preconditions and
  audit for repair.
- **Observe-only adoption** — correlate an existing BullMQ, pg-boss, DBOS or
  custom execution without moving producer and worker traffic first.

Not finding this as a packaged primitive in the reviewed documentation does
not prove demand. Three explanations remain viable:

1. this is a genuine reusable product gap;
2. teams consider it application-domain responsibility;
3. durable execution plus application-specific reconciliation is sufficient.

## How to falsify the hypothesis

Before expanding queue parity or adding a second adapter, run design-partner
tests against three workloads:

| Workload                                             | Strong alternative                             | RhinoQ must demonstrate                                                          |
| ---------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| database-only workflow                               | DBOS transaction or application transaction    | no advantage is expected; document when not to use RhinoQ                        |
| external provider with idempotency                   | durable step plus provider key                 | clearer evidence or operations without weakening safety                          |
| completed execution with inconsistent business state | application cron, SQL alert or monitoring rule | lower adoption cost, persistent finding lifecycle and safer investigation/repair |

The v0.1 thesis fails if teams do not value the third row as a reusable product
capability or will only keep its invariant and repair logic inside the
application.

## Positioning rules

- Do not describe all other queues as “blind retry” systems. They manage
  execution or delivery state; an application may add idempotency,
  verification and reconciliation.
- Do not use PostgreSQL, transactional enqueue, checkpointing or worker resume
  as unique claims.
- Do not publish relative throughput or latency without a reproducible
  benchmark recording hardware, payload, durability, concurrency and workload.
- Do not require a queue migration before a team can observe its first finding.
- Recommend the better-fitting product when the user only needs a queue, DAG,
  durable workflow, hosted task runner or Redis throughput.

## Review cadence

Recheck this file before each release candidate and record:

- source URL and review date;
- capability changes that alter a comparison;
- tested behavior versus documentation-only claims;
- any RhinoQ claim that should be narrowed or removed.
