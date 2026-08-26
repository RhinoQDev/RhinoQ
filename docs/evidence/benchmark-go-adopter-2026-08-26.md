# Go adopter-shaped PostgreSQL benchmark — 2026-08-26

Environment: Windows amd64, Go 1.26.6, Intel Core Ultra 5 225U and disposable
PostgreSQL 16.15 in Docker Desktop. Each case ran 20 iterations.

Command shape:

```powershell
$env:RHINOQ_TEST_DATABASE_URL='postgres://rhinoq:rhinoq@localhost:55432/rhinoq?sslmode=disable'
go test -run '^$' -bench BenchmarkAdopter -benchtime 20x -benchmem -count=1 .
```

| Operation | Fan-out | ns/op | B/op | allocs/op |
|---|---:|---:|---:|---:|
| Task Summary polling | 100 | 604,180 | 4,408 | 78 |
| Task Summary polling | 1,000 | 432,510 | 4,432 | 80 |
| Task Summary polling | 5,000 | 582,550 | 4,424 | 81 |
| First 50-row Execution page | 100 | 1,485,430 | 57,728 | 838 |
| First 50-row Execution page | 1,000 | 2,169,020 | 58,076 | 885 |
| First 50-row Execution page | 5,000 | 4,392,000 | 58,819 | 933 |

Task Summary allocation and latency remained broadly flat across the measured
fan-out sizes. The Execution page became slower as total fan-out grew despite
returning the same 50 rows, so it remains a tuning target rather than a bounded
performance claim.

This is a synthetic single-machine regression probe, not an adopter or
production capacity measurement.
