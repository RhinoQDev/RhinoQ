# Runtime foundation and implementation matrix

This is an implementation inventory for RhinoQ's native runtime and optional
Verified Tasks foundation. It uses BullMQ as a queue-ergonomics reference; it
is not the product's buyer narrative. A narrow, implemented BullMQ lifecycle
bridge observes explicitly tracked jobs; it is not queue replacement or a full
adapter. Start with [Product positioning](./product-positioning.md) and
[Task Platform](./task-platform.md). See the [competitive
landscape](./competitive-landscape.md) for PostgreSQL queues and durable
execution platforms.

| Capability | Queue reference model | RhinoQ status |
|---|---|---|
| Queue persistence | Redis | PostgreSQL adapter plus checksum-tracked embedded migrations covered by a real-database contract/integrity suite |
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
| User-facing Task snapshot | application-specific | Snapshot v1 across Go/HTTP/Node with lifecycle, progress, native/external Execution binding, aggregate entity version and stale-write rejection |
| Task result availability | application-specific | version-fenced storage reference is read separately from polling Snapshot; payload proxy and tenant authorization pending |
| DLQ / Needs Attention | failed-job and operational views | one bounded inbox merges execution attention and live persistent Findings; resolved/suppressed Findings are excluded |
| Reverse reconciliation | application-specific | bounded `scan` plus durable `Changed()` signals; stable `(changed_at, subject_id, sequence)` cursor; scheduled scans remain the missed-signal fallback |
| Observe-only correlation | application-specific | external source/job/business-key and subject references implemented; reverse search by external execution remains pending |
| Manual replay | retry failed work | guarded dead/blocked replay with effect safety checks and transactional audit |
| Audit trail | operational events | replay events use a per-job SHA-256 hash chain; signed checkpoints pending |
| Flow/dependency graph | supported | intentionally not v0.1 |
| Effect uncertainty | not external-effect aware by default | Effect Ledger implemented |
| Business outcome | not native | canonical per-Rule/per-subject Outcome implemented; Findings are its operational projection, with stale-observation protection and unknown grace escalation |
| Integrity Rules | application-specific | integrity-only facade, versioned job/table SQL contract, tri-state read-only evaluator, Explain gate, bounded CLI scan and fenced periodic scheduler implemented |
| Metrics export | Prometheus exporters | `/metrics` text format implemented, no client library dependency |
| Health probes | not applicable | `/health/live` and `/health/ready` implemented separately |
| Embedded operation | application-specific | Go library and direct PostgreSQL CLI are the default; no RhinoQ server, AI agent or LLM is required |
| Node.js producer | Node ecosystem | `PostgresProducer` preview uses the application's pool/transaction and the guarded SQL enqueue function; CI covers commit and rollback through real `pg` |
| Polyglot workers | Node only | Node worker preview adds protocol negotiation, handler-filtered claim, heartbeat, cancellation and graceful shutdown through the optional HTTP gateway |
| Transactional enqueue from any language | not applicable | `rhinoq.enqueue()` SQL function with job allowlist implemented and executed by the PostgreSQL suite |
| Migration/diagnostics CLI | application-specific | read-only plan/status/SQL, explicit checksum-locked apply and database-aware doctor implemented |
| Developer UI | separate product | embedded loopback-only Workbench preview implemented: payload-free jobs, Needs Attention, Findings, Rules, evidence, subject recheck and opt-in guarded repair; no remote hosting |

## Task profiles are not equivalent

The Node SDK reaches Tasks two ways, and they do not carry the same per-item
guarantees. The difference is easy to miss because the TypeScript types are
shared: fields the Gateway never populates are simply optional there.

| Capability | Embedded PostgreSQL client | Gateway (Go engine) |
|---|---|---|
| `itemKey` on an Execution | yes — `UNIQUE (task_id, item_key, attempt)` | **no** — executions are `UNIQUE (task_id, attempt)`, so attempts are numbered per Task |
| Per-item attempt history | yes — a retry opens attempt *n+1* for the same item | no — a retry cannot be distinguished from a new item |
| `settleTaskItems` / `onItemsSettled` | yes — decided by one `items_settled_at IS NULL` UPDATE | no |
| Bulk read of runtime job IDs | `listTaskExecutionRuntimeRefs`, one query | no — one lookup per Execution |

Runtime job identity stays off `TaskSnapshot` on both profiles. The snapshot is
polled and the owner-scoped routes serve it to a browser, so it carries no more
infrastructure identity than it carries storage references. The embedded client
exposes it through a separate server-side read with no owner-scoped variant.

Both per-item gaps announce themselves rather than failing silently:
`BullMQTaskBridge` warns when `onItemsSettled` is configured against a client
that cannot settle, and `RhinoQClient.createTaskExecution` warns the first time
an `itemKey` is supplied that the Gateway will discard. Neither is a substitute
for choosing the right profile: **per-item idempotency requires the embedded
PostgreSQL client.**

BullMQ is a mature Redis-based queue with worker, events, delayed jobs,
concurrency and operational features. RhinoQ uses it as one runtime reference;
the lifecycle bridge must not claim queue replacement or feature parity. The
current bridge observes explicitly tracked jobs only; dispatch, retry, cancel
and outage-wide reconciliation remain unfinished. See the
[BullMQ repository](https://github.com/taskforcesh/bullmq) for the queue
reference model.
