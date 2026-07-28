# Adoption and usability review

Reviewed: 2026-07-28

This review asks whether a new user can install RhinoQ, get a trustworthy first
result, and control work without understanding the engine internals. It uses
official product documentation as UX references, not as feature claims about
RhinoQ.

## Current verdict

| Journey | Current state | Verdict |
|---|---|---|
| Go producer + worker | documented embedded API, migrations and doctor | usable for repository evaluation |
| Go library install | Apache-2.0 licensed, module path matches the repository, `go get` resolves a branch pseudo-version | usable; no semver tag yet |
| Node producer | tested `PostgresProducer`, but package is source-only | technically usable, distribution not ready |
| Node worker | tested high-level worker, but requires Gateway and source-only package | preview |
| Operations | direct CLI plus an embedded read-only Workbench for jobs, evidence, attention, findings and Rules | useful for local development; browser writes remain intentionally absent |
| First integrity finding | Rule path exists, but no no-cutover starter workload | adoption blocker |
| Production evidence | real PostgreSQL contracts exist; benchmark/fault/restore evidence incomplete | not production-ready |

The product is easier to evaluate than before, but not yet easy to install for
a Node team outside this repository.

## What strong onboarding products do well

- [BullMQ Quick Start](https://docs.bullmq.io/readme-1) introduces two concepts,
  `Queue` and `Worker`, immediately after one package install. The first code
  sample creates observable work before advanced configuration appears.
- [pg-boss](https://timgit.github.io/pg-boss/) combines a Node API with
  transactional/ORM paths, while its
  [CLI](https://timgit.github.io/pg-boss/cli) exposes migration plans, version
  and doctor behavior for deployment automation.
- [Graphile Worker CLI quickstart](https://worker.graphile.org/docs/cli) uses a
  task directory and one local command; its
  [library runner](https://worker.graphile.org/docs/library/run) also supports
  embedded operation and a graceful `stop()` lifecycle.
- [DBOS TypeScript](https://docs.dbos.dev/typescript/programming-guide) provides
  a project template and a command to start local PostgreSQL, then gets to a
  first durable function quickly.
- [Trigger.dev quickstart](https://trigger.dev/docs/quick-start) optimizes for
  a visible first run by generating an example task and linking the local
  process to a run view.
- [node-postgres transaction guidance](https://node-postgres.com/features/transactions)
  requires every statement in a transaction to use the same checked-out
  client. `PostgresProducer` follows this instead of hiding pool ownership.
- [Node.js release guidance](https://nodejs.org/en/about/previous-releases)
  recommends supported LTS lines for production. Node 20 is EOL, so the SDK
  requires Node 22+ and CI covers Node 22 and 24.

## Decisions applied to RhinoQ

1. Node producer is the shortest path. It uses the application's current pool
   or transaction and does not require a Gateway.
2. Node worker is a high-level runtime. Users register handlers; the SDK handles
   protocol negotiation, queue-filtered claim, heartbeat and shutdown.
3. Correctness remains in Go. The SDK reports intent and observations; it does
   not calculate retry schedules or mutate job state locally.
4. Developer inspection works without a hosted Console. The Workbench exposes
   bounded payload-free evidence; CLI and Node client retain explicit controls.
5. Documentation says “preview” until installation is genuinely public.

## Remaining adoption blockers

### P0 — required before recruiting Node design partners

1. The license boundary is now decided: core is Apache-2.0 (ADR-0013), and the
   Go module path matches the hosting repository, so `go get` works without a
   `replace`. What remains is a tagged `@rhinoq/node` with checksums and
   provenance. Reserve or prove ownership of the `@rhinoq` npm scope first; the
   package currently returns `404`, which proves it is unpublished but not that
   this project can publish under that scope.
2. Publish prebuilt `rhinoq` CLI binaries for Linux, macOS and Windows so a
   Node user does not need a Go toolchain. The GoReleaser pipeline and the
   tag-triggered workflow are committed, and the CLI version is stamped from the
   tag; the first `v*` tag has not been pushed, so the pipeline is unproven.
3. Ship one end-to-end Node starter that starts PostgreSQL, applies reviewed
   migrations, enqueues a job, runs a handler and shows Needs Attention.
4. Complete external execution correlation and a no-cutover first Finding.
   Without this, RhinoQ still looks like a younger pg-boss/Graphile Worker.

### P1 — improve activation and daily control

1. `rhinoq init --node` should generate a plan, never overwrite silently, and
   create package scripts only after confirmation.
2. Extend the current local Workbench with a cross-job business-key timeline.
   Add browser mutations only with actor/reason confirmation and application-use-case audit.
3. Add NestJS lifecycle hooks only after the framework-neutral worker is
   validated by a real user.
4. Add `LISTEN/NOTIFY` as an optional wake-up hint while retaining polling as
   the correctness fallback; benchmark before claiming latency improvement.
5. Add an explicit confirmation deadline and operator view for
   `external-signal`/`verify` effects. A pending async effect is not automatically
   an error, so escalation must use a declared SLA instead of guessing.

### P2 — scale and confidence

1. Reproducible Node producer/worker benchmarks with hardware, payload, pool,
   concurrency and durability recorded.
2. Fault tests for Gateway loss, delayed heartbeat, process kill and shutdown
   overrun.
3. Retention, partition, backup/restore and schema-upgrade evidence.

## Activation targets

These are targets to measure with design partners, not current claims:

- time from package install to first enqueue;
- time from clone to first completed Node handler;
- time from existing business table to first Finding;
- number of required processes for each integration path;
- percentage of setup failures explained by `doctor`;
- number of operator incidents resolved without ad-hoc SQL.

The first differentiating activation event is **a real business mismatch
appearing as one deduplicated Finding**, not merely a job reaching
`succeeded`.
