# Task profile operations

## Durable verification notification handoff

Task schema v10 adds `rhinoq_task.notification_outbox`. A mismatch recorded
through `recordTaskVerificationChain()` writes the verification, lets the
application observe the Finding, then creates an idempotent outbox row with a
stable identity (`task-verification:{verificationId}`).

The outbox is a durable handoff, not a guessed email or webhook policy. A host
application can claim rows with `claimTaskNotification()`, deliver through its
own recipient adapter, and call `completeTaskNotification()` or
`failTaskNotification()`. Lease ownership and retry timing prevent two
delivery processes from treating the same row as theirs.

The Go Finding write and the Node Task database are separate stores, so no SDK
can honestly promise one ACID transaction across both. Re-running the chain is
safe through the verification and notification identities; an application that
needs strict cross-store atomicity must place both operations behind its own
transactional boundary.

## Tenant authorization

`createTaskRequestHandler()` always requires the host's `ownerFromRequest` and
tenant context when configured. `authorize()` is an optional second policy
gate for tenant-wide membership/RBAC. Set `requireTenantAuthorization: true`
to refuse construction unless the hook is present. Ownership and tenant SQL
predicates remain mandatory even when the hook allows a request; the hook never
replaces row-level isolation.

## Queue protection

The Go worker enables the read-only queue watchdog every 30 seconds by default.
`WorkerConfig` exposes explicit `QueueAtRiskAfter`, `QueueStuckAfter`,
`QueueBacklogGrowthAfter` and `QueueReaperTimeout` thresholds. Alerts are
transition-only and cover age, growth, no-ready-worker (when
`WorkerReady` is supplied) and reaper health.

Admission decisions for configured queues lock the queue-control row before
counting and inserting. Concurrent producers therefore cannot all observe the
same remaining budget and over-admit work. This protects admission; it does
not make a business handler idempotent or make an unknown external result safe
to retry.

`cmd/rhinoq-worker` is a recovery/health sidecar. It reaps expired leases and
observes named queues from `RHINOQ_WORKER_QUEUES`; application workers still
register handlers and call `Client.Run`.
