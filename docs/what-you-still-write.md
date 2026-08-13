# What RhinoQ does, and what you still write

A library that lists only what it gives you is asking to be believed. This is
the other list. It exists because someone building on RhinoQ assembled it
themselves, one surprise at a time, and every item on it is cheaper to know on
day one than on day four.

## RhinoQ owns

| | Where |
|---|---|
| The Task/attempt/waitpoint state machines, fenced in SQL | `rhinoq_task` schema, isolated Task tables |
| Per-item attempt history across runtime retries | `retryProjection: 'new-attempt'` |
| "Every item has finished", delivered exactly once | `settleTaskItems()` / `onItemsSettled` |
| Fan-out progress, recomputed without a read-modify-write | `sync_item_progress` |
| Item counts separate from attempt counts | `TaskSummary.itemCounts` |
| One projector per runtime scope, released on failover | `PostgresProjectorLease` |
| One-mount owner API, Task Center and operator Workbench | `app.http({ operatorToken })` |
| A record of every projection it could not write down | `PostgresProjectionFailureSink` |
| A sweep for batches that stopped moving | `TaskReconciler`, on by default via `rhinoq()` |
| Bounded waitpoint expiry | `WaitpointExpiryScheduler`; escalation policy remains application-owned |
| Snapshot-convergent live delivery | owner-scoped SSE plus polling fallback |
| Cancellation as an axis separate from state | `cancellation.status`, including `too_late` |
| Rules over your own PostgreSQL, gated by `EXPLAIN` before they run | `docs/rules.md` |

## You still write

**Your business table.** The Task profile stores the *lifecycle* of an item, not
what the item is. The URL, the customer, the file name, the metadata: yours.
`itemKey` is the join.

**The realtime transport, if you keep your own HTTP contract.** RhinoQ's Task
API and Task Center use owner-scoped SSE with snapshot-convergent polling as a
fallback. If you take Door 2 and expose your own endpoints, the transport and
reconnect behavior for those endpoints remain yours.

**Going and looking, for anything outside PostgreSQL.** A Rule is SQL in a
`READ ONLY` transaction under a role that is required not to have network or
filesystem functions (`docs/rules.md:110`). No Rule can HEAD an object in a
bucket or read a provider back. RhinoQ ships the loop —
`objectExists`, `httpReadBack`, `rowMatches` in `@rhinoq/node` — and a table to
put the answers in, but the pass runs in your process, on your schedule, with
your credentials. RhinoQ stores and classifies findings; it does not go and get
them.

**Your retry policy.** BullMQ's `attempts` and `backoff` are yours. RhinoQ
records what happened; it does not decide how many times.

**What a stuck batch means.** The reconciler finds batches that stopped moving.
Whether one that has not moved in three days should be failed, re-dispatched, or
left for a person is a business decision and RhinoQ will not guess it.

**Authentication and tenant authorization at the HTTP edge.** RhinoQ carries
the tenant and owner selected by `tenantFromRequest` and `ownerFromRequest`
through every owner-scoped Task SQL predicate, and can require an explicit
deny-by-default `authorize` hook. Your application must still derive those
identities from its authenticated session and decide tenant membership; RhinoQ
does not authenticate end users or invent organization/RBAC policy. The full Go
Gateway remains a separate operator boundary and is not a public tenant-wide
RBAC surface. See `docs/tenancy.md`.

## Things that used to be on this list

Kept here because a list like this is only trustworthy if it shrinks in public.

- **The reconciliation sweep.** Was something you had to remember to configure,
  and a batch whose events were missed sat `running` forever until you did. Now
  on by default through `rhinoq()`.
- **The idempotency fence for a job's business writes.** Was two stores and no
  shared transaction. `onceForItem()` claims a named effect and your writes in
  one PostgreSQL transaction.
- **The "which items does the queue think finished but RhinoQ does not" join.**
  Was forty lines written under pressure while a batch was stuck. Now
  `app.audit(taskId)`.
- **Real cancellation.** Was: fetch the job IDs yourself, remove each one
  yourself, transition each Execution yourself, close the Task yourself. Now
  `app.cancel(taskId)`, which stops what can be stopped and says plainly which
  job could not be.
