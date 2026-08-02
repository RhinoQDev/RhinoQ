# Evidence — the detector on a read-only role

Captured 2026-08-02 against PostgreSQL 17.4 on an isolated throwaway cluster,
using `rhinoq` built from this branch. Everything below is verbatim output.

The claim being tested is the one on the README's first screen: a first Finding
costs one command, one role with `SELECT`, no migration against the
application's schema and no RhinoQ table inside it.

## Setup

The application database is seeded with
[`examples/integrity-only/setup.sql`](../../examples/integrity-only/setup.sql) —
three reports, one of which is `completed` with no `output_key` — and the role
from
[`examples/integrity-only/compose-readonly-role.sql`](../../examples/integrity-only/compose-readonly-role.sql).

## The role cannot write

```text
$ psql -U rhinoq_readonly -d app -tAc \
    "select current_user, current_setting('default_transaction_read_only');"
rhinoq_readonly|on

$ psql -U rhinoq_readonly -d app -tAc "UPDATE public.rhinoq_example_reports SET status='x';"
ERROR:  cannot execute UPDATE in a read-only transaction

$ psql -U rhinoq_readonly -d app -tAc "CREATE TABLE nope(i int);"
ERROR:  cannot execute CREATE TABLE in a read-only transaction
```

## One command, one Finding, nothing written

```text
$ export RHINOQ_SUBJECT_DATABASE_URL='postgres://rhinoq_readonly:...@127.0.0.1:5432/app?sslmode=disable'
$ rhinoq detect --rules examples/integrity-only/rules.json
RULE                         OBSERVED  PASSED  VIOLATED  UNKNOWN
completed-report-has-output  3         2       1         0

1 open Finding(s)
  open report/report_missing  seen=1  since=2026-08-02T06:47:36Z
    evidence {"status": "completed", "outputKey": null}

A Finding states that something is wrong. RhinoQ does not repair the row.
```

No `RHINOQ_DATABASE_URL` was set and `--store` was not passed, so the Rule and
the Finding existed only in the process.

## No RhinoQ object was created in the application database

```text
$ psql -U postgres -d app -tAc \
    "select c.relname, c.relkind from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname like 'rhinoq%';"
rhinoq_example_reports|r
rhinoq_example_reports_pkey|i
```

Both belong to the seed fixture. The migration table
`rhinoq_schema_migrations` is absent, so no migration ran here.

## Machine-readable output and the CI exit code

```text
$ rhinoq detect --rules examples/integrity-only/rules.json --json --fail-on-finding
{
  "findings": [
    {
      "ruleId": "completed-report-has-output",
      "subjectType": "report",
      "subjectId": "report_missing",
      "invariantVersion": 1,
      "status": "open",
      "occurrenceCount": 1,
      "latestEvidence": "{\"status\": \"completed\", \"outputKey\": null}",
      ...
    }
  ],
  "rules": [
    { "ruleId": "completed-report-has-output", "observed": 3, "passed": 2, "violated": 1, "unknown": 0 }
  ]
}
$ echo $?
1
```

## Stored mode: deduplication, then resolution

With a *separate* RhinoQ database and `--store`, the command migrates its own
schema and Findings survive between passes.

```text
$ rhinoq detect --rules examples/integrity-only/rules.json --store
RhinoQ store schema 022/022 · 0 pending
...
  open report/report_missing  seen=1  since=2026-08-02T06:45:32Z

$ rhinoq detect --rules examples/integrity-only/rules.json --store
...
  open report/report_missing  seen=2  since=2026-08-02T06:45:32Z
```

The second pass increments the occurrence count instead of opening a second
Finding, and `rhinoq_rules` still holds exactly one enabled version:

```text
completed-report-has-output|1|enabled
```

Repairing the business row and re-running resolves it:

```text
$ psql -U postgres -d app -c "UPDATE public.rhinoq_example_reports
    SET output_key='reports/report_missing.pdf', updated_at=now()
    WHERE id='report_missing';"
UPDATE 1

$ rhinoq detect --rules examples/integrity-only/rules.json --store
RULE                         OBSERVED  PASSED  VIOLATED  UNKNOWN
completed-report-has-output  3         3       0         0

No open Findings.
```

## What this run does not show

- No throughput or latency figure. Three rows measure correctness, not cost.
- No Explain-gate rejection against a large table: a three-row fixture cannot
  produce a plan expensive enough to trip it. The gate's own tests cover that.
- No evidence about any code an adopter could delete. That measurement is
  specified in [Measuring plumbing](../measuring-plumbing.md) and is still
  unmeasured.
