# Integrity Rules

Rules are the canonical verification contract in RhinoQ. Outcome checks and
table reconciliation do not have separate public DSLs.

## Scopes

- `job` evaluates one business subject after an execution. `$1` is the subject
  ID.
- `table` evaluates a bounded page of business subjects. `$1` is the baseline
  timestamp, `$2` is the last subject cursor, and `$3` is the maximum row count.

Every query returns exactly:

```text
subject_id text | violated boolean | evidence jsonb/text
```

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
export RHINOQ_AGENT_URL=http://localhost:8080
export RHINOQ_AGENT_TOKEN=...
rhinoq explain report-output-exists
```

The SQL syntax guard is not a security sandbox. Production Rules must use a
restricted read-only database role. Extensions or functions that can access the
network or filesystem must not be granted to that role.

## Evaluation and Findings

Manual evaluation is available through Go and Agent HTTP:

```go
page, err := queue.EvaluateRule(ctx, ruleID, "", cursor)
cursor = page.NextCursor
```

For every observation:

- `violated = true` opens or deduplicates a persistent Finding;
- `violated = false` auto-resolves an existing Finding and appends a `passed`
  event;
- a healthy subject without a Finding creates no record.

The current implementation exposes bounded manual pages. Persistent scheduler
cursors, periodic execution and crash recovery between pages are still pending.
