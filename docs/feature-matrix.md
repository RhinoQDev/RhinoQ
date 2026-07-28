# Feature matrix

| Capability | BullMQ reference model | RhinoQ status |
|---|---|---|
| Queue persistence | Redis | PostgreSQL adapter and migrations covered by a real-database contract/integrity suite |
| Batch claim | Redis atomic operations | PostgreSQL `SKIP LOCKED`, one bulk lease statement plus one rate reservation per queue |
| Lease/heartbeat | stalled job recovery | implemented, fenced by owner and epoch on all seven write paths |
| Concurrency | worker concurrency | implemented; batch claim follows free slots and a prefetch factor |
| Delayed jobs | delayed/repeatable jobs | `not_before` claim boundary implemented |
| Retry/backoff | fixed/exponential + jitter | classified exponential retry with bounded jitter implemented |
| Priority | priority queue | implemented: priority, FIFO inside a priority, and aging against starvation |
| Pause/resume | supported | implemented for job-name queues |
| Job cancellation | worker/job control | pending jobs cancel immediately; leased jobs use cooperative cancellation |
| Rate limiter | global per queue | durable fixed-window limit implemented for memory and PostgreSQL; workers wake when the window reopens |
| Graceful shutdown | worker close | six-step stop implemented; prefetched work is handed back with its attempt |
| Attempt history | job attempts/events | append-only claimed/terminal/expired timeline, atomically written with PostgreSQL job transitions |
| Stalled/poison protection | `maxStalledCount` | crash budget per job implemented; distinct-worker tracking pending |
| Producer backpressure | not native | admission control with reserved critical budget implemented; `route` and `sample` overflow modes pending |
| Job getters/counts | status filters + pagination | queue filter, state filter, counts and bounded pagination implemented |
| DLQ / Needs Attention | failed-job and operational views | dead/blocked/effect/outcome derived attention view and finding domain lifecycle implemented; persistent finding store/API pending |
| Manual replay | retry failed work | guarded dead/blocked replay with effect safety checks and transactional audit |
| Audit trail | operational events | replay events use a per-job SHA-256 hash chain; signed checkpoints pending |
| Flow/dependency graph | supported | intentionally not v0.1 |
| Effect uncertainty | not external-effect aware by default | Effect Ledger implemented |
| Business outcome | not native | Outcome contract implemented |
| Metrics export | Prometheus exporters | `/metrics` text format implemented, no client library dependency |
| Health probes | not applicable | `/health/live` and `/health/ready` implemented separately |
| Polyglot workers | Node only | Agent HTTP surface with protocol negotiation and a language-neutral error envelope implemented |
| Transactional enqueue from any language | not applicable | `rhinoq.enqueue()` SQL function with job allowlist implemented and executed by the PostgreSQL suite |
| UI | separate product | not implemented |

BullMQ is a mature Redis-based queue with worker, events, delayed jobs, concurrency and operational features. RhinoQ should match basic queue ergonomics before adding higher-level integrity behavior. See the [BullMQ repository](https://github.com/taskforcesh/bullmq) for the reference model.
