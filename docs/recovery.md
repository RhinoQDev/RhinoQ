# Recovery

RhinoQ separates `Retry`, `Resume`, and `Repair`. The current public recovery API implements a guarded full-handler replay for dead or blocked jobs. Resume checkpoints and business-state repair are not implemented yet.

## Needs Attention

`ListAttention` derives an operational view from current authoritative records:

```go
items, err := queue.ListAttention(ctx, "provider-sync", 0, 100)
```

Current finding kinds:

| Kind | Source |
|---|---|
| `dead_job` | job exhausted its execution policy |
| `execution_blocked` | unknown/unclassified execution requires a decision |
| `effect_uncertain` | Effect Ledger cannot prove whether an effect happened |
| `outcome_mismatch` | declared business outcome is mismatched or unverifiable |

This is currently a derived read model. Persistent finding lifecycle—acknowledge, resolve, regress, assign—is still pending.

## Guarded replay

Replay requires an actor and a non-empty operational reason:

```go
job, audit, err := queue.ReplayJob(
    ctx,
    jobID,
    "operator@example.com",
    "provider incident resolved",
)
```

Replay is allowed only for `dead` or `blocked` jobs. It fails closed when the job has:

- a `confirmed` effect—use Resume when checkpoint support is available;
- an `uncertain` effect—an operator must decide what happened first;
- a `pending` effect—the effect is unresolved.

Effects explicitly recorded as `not_happened` or `rejected` do not block replay.

Replay returns the job to `pending`, clears lease/cancellation fields, and preserves the attempt counter. Preserving attempts avoids deleting execution evidence; append-only attempt rows remain a separate pending capability.

## Audit trail

Every accepted replay writes an audit row in the same storage transaction as the job transition:

```go
records, err := queue.AuditTrail(ctx, jobID, 0, 100)
```

Audit rows form a per-job SHA-256 hash chain through `prev_hash` and `row_hash`. This is tamper-evident, not immutable: a database owner can still rewrite the table and recompute hashes. Signed checkpoints or WORM export are required for stronger external evidence.
