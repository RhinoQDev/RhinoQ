# Feature matrix

| Capability | BullMQ reference model | RhinoQ status |
|---|---|---|
| Queue persistence | Redis | PostgreSQL adapter implemented; DB integration evidence pending |
| Batch claim | Redis atomic operations | PostgreSQL `SKIP LOCKED` implemented |
| Lease/heartbeat | stalled job recovery | implemented |
| Concurrency | worker concurrency | implemented with bound |
| Delayed jobs | delayed/repeatable jobs | `not_before` claim boundary implemented |
| Retry/backoff | retry/backoff | classification + exponential policy implemented; jitter pending |
| Pause/resume | supported | implemented for job-name queues |
| Job cancellation | worker/job control | pending jobs cancel immediately; leased jobs use cooperative cancellation |
| Rate limiter | supported | not implemented |
| Flow/dependency graph | supported | intentionally not v0.1 |
| Effect uncertainty | not external-effect aware by default | Effect Ledger implemented |
| Business outcome | not native | Outcome contract implemented |
| UI | separate product | not implemented |

BullMQ is a mature Redis-based queue with worker, events, delayed jobs, concurrency and operational features. RhinoQ should match basic queue ergonomics before adding higher-level integrity behavior. See the [BullMQ repository](https://github.com/taskforcesh/bullmq) for the reference model.
