# Reproducible benchmarks

RhinoQ keeps benchmarks separate from correctness tests. Results vary with the
CPU, Node/Go version, operating system, PostgreSQL configuration and background
load, so one local run is evidence about that environment—not a production
throughput claim.

## Node SDK overhead

Build and run the JSON-reporting benchmark:

```bash
npm --prefix sdks/node run benchmark
```

For a quicker or longer run:

```bash
RHINOQ_BENCH_ITERATIONS=20000 RHINOQ_BENCH_SAMPLES=5 \
  npm --prefix sdks/node run benchmark
```

The runner warms each path, records multiple samples and reports median and
p95 sample duration, operations per second and nanoseconds per operation. It
currently measures only in-process SDK overhead:

- accepting a newer Task snapshot;
- rejecting an older aggregate revision;
- BullMQ count and percentage progress mapping.

The first checked-in local baseline is
[`evidence/benchmark-node-2026-08-01.json`](./evidence/benchmark-node-2026-08-01.json).
It is comparison evidence for that recorded machine/runtime only.

Real local baselines are also checked in for
[PostgreSQL 16](./evidence/benchmark-postgres-2026-08-01.json) and
[Go 1.26.5](./evidence/benchmark-go-2026-08-01.json). In the recorded
PostgreSQL concurrency matrix, 16 clients produced the highest create/read
throughput; 32 clients reduced throughput and sharply increased p99 create
latency. This is a tuning signal for that machine, not a universal pool-size
default.

The latest remediation baseline is
[`evidence/benchmark-remediation-2026-08-12.md`](./evidence/benchmark-remediation-2026-08-12.md).
It confirms flat Task Summary reads across 100–5,000 synthetic Executions on
that machine, but also records increasing Go client latency for a 50-row
Execution page. The latter remains a deployment-shaped tuning signal rather
than being hidden behind the Summary result.

It deliberately does not claim HTTP, PostgreSQL, Redis, BullMQ worker or
end-to-end throughput.

For a disposable PostgreSQL database, measure the embedded command/snapshot
path separately:

```bash
RHINOQ_TEST_DATABASE_URL=postgres://... \
RHINOQ_BENCH_ITERATIONS=1000 RHINOQ_BENCH_CONCURRENCIES=1,8,16,32 \
RHINOQ_BENCH_FANOUT_SIZES=10,100,500,1000 \
RHINOQ_BENCH_FANOUT_CONCURRENCIES=1,8,32 \
  npm --prefix sdks/node run benchmark:postgres
```

The runner installs/upgrades the Task-only schema, creates benchmark-owned
rows, measures create/read concurrency, and optionally probes growing fan-out
Snapshots before deleting those rows. It reports full Snapshot versus Summary
bytes/read latency and one complete 100-row keyset-page sweep for each size.
Never point it at a production database.

The 2026-08-01 local fan-out probe grew from about 2.3 KB at 10 Executions to
211 KB at 1,000. At 1,000, 100 reads with concurrency 16 recorded p95 95.8 ms
on that Windows/Docker/PostgreSQL 16 host. This demonstrates a current scaling
boundary, not a universal limit: the v1 Snapshot contains every Execution
summary. The `beta.5` benchmark additionally measures the execution-free
Summary and bounded pages; keep the compatibility full Snapshot intentionally
bounded and reproduce the matrix on the deployment-shaped environment.

On the same local Docker/PostgreSQL 16.14 host, the focused 1,000-Execution
probe recorded a 212,119-byte full Snapshot and a 324-byte Summary. Thirty
concurrent reads recorded p95 61.641 ms for the full Snapshot versus 4.243 ms
for Summary; walking all 1,000 Executions in ten 100-row pages took 64.547 ms.
These are local comparison numbers, not capacity claims. The raw focused run is
[`evidence/benchmark-task-summary-2026-08-01.json`](./evidence/benchmark-task-summary-2026-08-01.json).

## Go domain and memory adapter

```bash
go test ./tests/benchmarks -run '^$' -bench . -benchmem -count=5
```

This measures Task progress transitions, duplicate detection, parallel memory
reads and memory-store creation. Use `benchstat` on saved before/after output
when optimizing; do not promote a single run into README performance claims.

## Fault evidence

The normal Node test suite includes a fixed-seed 10,000-event disorder test and
32 concurrent deterministic seeds. They mix duplicates, out-of-order revisions
and injected transport loss, asserting the rendered Task never falls below the
maximum successful aggregate version. Fixed seeds make failures reproducible.

Real-database and end-to-end numbers remain a separate gate. Run the PostgreSQL
contract suite on the same host/configuration and record commit, runtime,
database version and benchmark parameters with every result.

The accompanying [GitHub adopter search](./evidence/github-adopter-search-2026-08-01.md)
records why the inspected public repositories were not valid code-reduction
probes instead of forcing an integration that could only add code.
