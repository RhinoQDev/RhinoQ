# Integrity Rules

Rules are the canonical verification contract in RhinoQ. Outcome checks and
table reconciliation do not have separate public DSLs.

## Scopes

- `job` evaluates one business subject after an execution. `$1` is the subject
  ID.
- `table` evaluates a bounded page of business subjects. `$1` is the baseline
  timestamp, `$2` is the last subject cursor, and `$3` is the maximum row count.

Every query returns three columns, plus an optional fourth:

```text
subject_id text | violated boolean NULL | evidence jsonb/text | unknown_reason text
```

`violated` is **nullable on purpose**. A check has three possible conclusions,
not two:

| `violated` | Meaning |
|---|---|
| `true` | the invariant is broken for this subject |
| `false` | the invariant holds |
| `NULL` | the check could not decide |

Return `NULL` when the provider timed out, the object could not be read, a
permission is missing, evidence has not arrived, or a confirmation deadline has
not passed. Do not guess. `false` means "this subject is fine", so answering
`false` because a dependency was unreachable silently closes real drift — that
is precisely the failure a boolean forces.

`unknown_reason` is optional and read only when `violated IS NULL`. It is what
makes an unknown actionable: `provider_timeout`, `permission_denied`,
`evidence_missing`, `awaiting_confirmation`. Omitting it records
`unspecified` rather than dropping the observation.

Table queries must return `subject_id` in strict ascending cursor order. RhinoQ
wraps the query with a hard `LIMIT`, even when the query already uses `$3`.

Example:

```sql
SELECT
    id::text AS subject_id,
    output_key IS NULL AS violated,
    jsonb_build_object('status', status, 'outputKey', output_key) AS evidence
FROM reports
WHERE created_at >= $1
  AND id::text > $2
ORDER BY id::text
LIMIT $3
```

## Lifecycle

Registering the same Rule ID creates an append-only version. A new version is
always `draft`; an enabled older version continues running until the new draft
passes Explain and is enabled.

```go
rule, err := queue.RegisterRule(ctx, rhinoq.RuleDefinition{
    ID:          "report-output-exists",
    Name:        "Completed report has an output object",
    Scope:       rhinoq.RuleScopeTable,
    SubjectType: "report",
    Query:       query,
    BaselineAt:  enabledAt,
    Every:       10 * time.Minute,
})

rule, explanation, err := queue.EnableRule(ctx, rule.ID)
```

Enabling one version disables the previously enabled version atomically.
Disable prevents future claims; it does not pretend to cancel a page that was
already claimed. That in-flight page may finish under its original immutable
version, and its Finding key records that version.

## Explain gate

Explain runs against PostgreSQL in a read-only transaction with:

- a per-Rule statement timeout;
- a hard result limit;
- exact result-column validation;
- plan-cost budget;
- a large sequential-scan budget;
- persisted query hash and plan evidence.

An unsafe explanation leaves the Rule in `draft`.

```bash
export RHINOQ_DATABASE_URL=postgres://...
rhinoq explain report-output-exists
```

The CLI uses the embedded Go client and connects directly to PostgreSQL. If
`RHINOQ_AGENT_URL` is deliberately set, it can use the optional HTTP gateway
instead.

The SQL syntax guard is not a security sandbox. Production Rules must use a
restricted read-only database role. Extensions or functions that can access the
network or filesystem must not be granted to that role.

## Evaluation and Findings

Manual evaluation is available through embedded Go and the optional HTTP
Gateway:

```go
page, err := queue.EvaluateRule(ctx, ruleID, "", cursor)
cursor = page.NextCursor
```

For every observation:

- `violated = true` opens or deduplicates a persistent Finding;
- `violated = false` auto-resolves an existing Finding and appends a `passed`
  event;
- `violated IS NULL` follows the Rule's `OnUnknown` policy;
- a healthy subject without a Finding creates no record.

An unknown **never** resolves a Finding. `OnUnknown` chooses between:

| `OnUnknown` | Behaviour |
|---|---|
| `retry` (default) | record the observation, open nothing, ask again next evaluation |
| `finding` | open a Finding whose evidence records `unknown` and the reason |

The default is `retry` because most unknowns are transient, and an alert per
transient failure teaches operators to ignore alerts. Choose `finding` when not
knowing is itself the problem — a permission RhinoQ will not regain on its own,
for instance.

```go
_, err := integrity.RegisterRule(ctx, rhinoq.RuleDefinition{
    // …
    OnUnknown: rhinoq.UnknownOpensFinding,
})
```

`rhinoq scan` reports unknown as its own count, never folded into passed.

> [!NOTE]
> There is no escalation after a grace period yet: a subject that stays unknown
> under `retry` stays unknown indefinitely and never becomes a Finding on its
> own. Tracking how long a subject has been inconclusive needs storage that does
> not exist, so it is deliberately absent rather than half-built.

Periodic table evaluation uses a durable cursor and an owner/epoch-fenced
schedule lease. A crash leaves the last completed page cursor in PostgreSQL;
after lease expiry another scheduler resumes there. A completed full scan
clears the cursor and schedules the next run from the Rule's `Every` interval.

```go
err := queue.RunRuleScheduler(ctx, rhinoq.RuleSchedulerConfig{
    Owner:        "integrity-1",
    PollInterval: time.Second,
    Lease:        time.Minute,
    ClaimBatch:   4,
})
```

The same runtime can be kept as a separate manual process without introducing
an application server or LLM:

```bash
RHINOQ_DATABASE_URL=postgres://... \
  rhinoq rules run --owner integrity-1 --batch 4 --lease 1m
```

Each claim evaluates one bounded page. Failures release the lease with a
backoff, while a stale owner or epoch cannot advance or complete the schedule.
The claimed immutable Rule version is evaluated even if a newer draft is
registered or enabled while that page is in flight. Scheduler fencing protects
cursor progression; Rule evaluation remains at-least-once and Finding
deduplication is the idempotency boundary.

## Verifying work RhinoQ did not run

An Effect Ledger entry used to require a RhinoQ job id, which excluded the case
it is most needed for: a team already running BullMQ, Temporal, cron or a
hand-written worker has no RhinoQ job to attach to.

A job id is now one kind of execution reference:

```go
integrity, _ := rhinoq.NewIntegrity(db)

_, err := integrity.RecordExternalEffect(ctx, rhinoq.ExternalEffectRequest{
    Execution:      rhinoq.ExecutionRef{SourceSystem: "bullmq", SourceID: job.id},
    Subject:        rhinoq.SubjectRef{Type: "report", ID: reportID},
    Name:           "upload-report",
    IdempotencyKey: reportID + ":pdf",
    ExternalRef:    objectKey,
})
```

and read back by subject, not by job:

```go
effects, err := integrity.SubjectEffects(ctx, rhinoq.SubjectRef{
    Type: "report", ID: reportID,
}, 0, 50)
```

### This path is weaker than the runtime path, on purpose

| | RhinoQ execution | External execution |
|---|---|---|
| Recorded through | the worker's lease | `RecordExternalEffect` |
| Fenced against a lost lease | yes, by `lease_epoch` | **no** |
| Deduplicated by | `(job, name, key)` | `(source system, source id, name, key)` |

There is no lease for work RhinoQ did not run, so nothing can prove the caller
still owns it. Deduplication on the execution reference plus the idempotency key
is the guarantee an external caller can actually provide, and claiming more
would be worse than saying so.

Recording a RhinoQ execution through `RecordExternalEffect` is refused rather
than silently accepted: the runtime has a fence, and skipping it would throw
away the protection the job already had.
