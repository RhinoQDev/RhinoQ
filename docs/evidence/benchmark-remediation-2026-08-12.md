# Local benchmark baseline — remediation branch

Run on 2026-08-12 from the uncommitted remediation tree based on
`7c7e6b2e`, using Windows amd64, Intel Core i5-10500, Node 22.22.1, Go 1.26.5
and PostgreSQL 16.13 in a local Docker container.

This is regression evidence for this machine. It is not a production capacity,
latency, throughput or reliability claim.

## PostgreSQL Task workload

Command:

```powershell
$env:RHINOQ_TEST_DATABASE_URL = 'postgresql://rhinoq:rhinoq@127.0.0.1:55432/rhinoq?sslmode=disable&options=-c%20rhinoq.tenant_id%3Dtnt_system'
go test ./tests/postgres -run '^$' -bench BenchmarkAdopter -benchtime 200x -benchmem -count=3
```

| Operation | Fan-out | Observed range |
|---|---:|---:|
| Task Summary read | 100 | 0.561–0.671 ms/op |
| Task Summary read | 1,000 | 0.590–0.598 ms/op |
| Task Summary read | 5,000 | 0.583–0.608 ms/op |
| first 50-Execution page | 100 | 1.511–1.573 ms/op |
| first 50-Execution page | 1,000 | 2.295–2.630 ms/op |
| first 50-Execution page | 5,000 | 5.643–6.556 ms/op |

The Summary stayed approximately flat across these fixture sizes. The Go
client's first Execution-page measurement increased with fan-out and therefore
does not support a bounded-latency claim. A direct `EXPLAIN (ANALYZE, BUFFERS)`
for the 5,000-row first page used `rhinoq_task_executions_page_idx`, read 51
rows and reported 0.106 ms execution time; the larger client-observed result
includes driver/planning/round-trip and local-host effects. Treat the page
trend as an open tuning signal and measure it on the deployment-shaped
environment.

## Node in-process SDK overhead

`npm --prefix sdks/node run benchmark` ran 7 samples. Median results:

| Operation | Median |
|---|---:|
| accept newer Task snapshot | 3,638,825 ops/s |
| reject stale Task snapshot | 3,014,881 ops/s |
| map BullMQ count progress | 49,152,126 ops/s |
| map BullMQ percentage progress | 31,756,315 ops/s |

These paths do not include HTTP, PostgreSQL, Redis, BullMQ or handler work.

## Go domain and memory adapter

`go test ./tests/benchmarks -run '^$' -bench . -benchmem -count=3` recorded:

| Operation | Observed range |
|---|---:|
| apply Task progress | 59.65–65.83 ns/op |
| reject duplicate progress | 15.20–15.92 ns/op |
| parallel memory Task read | 46.28–48.78 ns/op |
| memory Task create | 649.1–743.6 ns/op |

Memory-adapter results do not describe the native PostgreSQL queue.

## Still required for a production capacity decision

- native PostgreSQL queue enqueue/claim/heartbeat/complete throughput under
  the application's handler-duration and payload distribution;
- multi-process worker contention and connection-budget behavior;
- sustained backlog/reaper recovery and database failover under load;
- p50/p95/p99 latency and saturation point on the intended production
  topology;
- an application-owned SLO and an explicit safety margin.

Until those measurements exist, this run can prevent regressions but cannot
select a production worker count, connection pool or throughput promise.
