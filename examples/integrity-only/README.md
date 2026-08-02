# The detector

Detect a completed report whose output file is missing — from a database you
only have SELECT on.

This starts no queue, worker, claim loop, heartbeat, retry scheduler or recovery
executor. It applies no migration to your database and creates no RhinoQ table
in it. In the default mode it writes nothing anywhere: Rules and Findings live
in memory for the length of the command and are printed before it exits.

## Try it against a disposable database

```bash
docker compose -f examples/integrity-only/docker-compose.yml run --rm detect
```

Compose starts a throwaway PostgreSQL that stands in for your application,
seeds three reports (one of them broken), creates a `rhinoq_readonly` role and
runs the detector against it.

```text
RULE                         OBSERVED  PASSED  VIOLATED  UNKNOWN
completed-report-has-output  3         2       1         0

1 open Finding(s)
  open report/report_missing  seen=1  since=2026-08-02T06:47:36Z
    evidence {"status": "completed", "outputKey": null}

A Finding states that something is wrong. RhinoQ does not repair the row.
```

The captured transcript of this run, including proof that the role cannot
write and that no RhinoQ table was created, is in
[evidence](../../docs/evidence/detector-first-finding-2026-08-02.md).

> **Which image.** `detect` is newer than the newest published tag
> (`v0.1.0-beta.7`, whose image still entrypoints the Gateway).
> `ghcr.io/madebyduy/rhinoq:next` will carry it from the next tag onward. Until
> that tag is cut, build the image from this checkout:
>
> ```bash
> docker build -t ghcr.io/madebyduy/rhinoq:next .
> ```

## Point it at your own database

Two steps, and only the first one touches your database.

**1. Create the read-only role.** Everything RhinoQ needs is in
[`readonly-role.sql`](./readonly-role.sql): `CONNECT`, `USAGE` and `SELECT`,
plus `default_transaction_read_only` so a mistaken grant later still cannot make
it a writer. Narrow the `GRANT` to the tables your Rules name once you know
what they are.

**2. Write one Rule and run it.**

```bash
docker run --rm \
  -e RHINOQ_SUBJECT_DATABASE_URL='postgres://rhinoq_readonly:...@host:5432/app?sslmode=disable' \
  -v "$PWD/rules.json:/etc/rhinoq/rules.json:ro" \
  ghcr.io/madebyduy/rhinoq:next detect --rules /etc/rhinoq/rules.json
```

Start a Rule file from the built-in template:

```bash
docker run --rm ghcr.io/madebyduy/rhinoq:next detect --example > rules.json
```

## What a Rule looks like

```json
{
  "id": "completed-report-has-output",
  "name": "Completed reports have an output object",
  "subjectType": "report",
  "baselineWithin": "24h",
  "maxRows": 100,
  "statementTimeout": "3s",
  "query": "SELECT id::text AS subject_id, ... AS violated, jsonb_build_object(...) AS evidence FROM public.reports WHERE updated_at >= $1 AND (($4::text = '' AND id::text > $2) OR id::text = $4) ORDER BY id::text LIMIT $3"
}
```

A Rule query returns three columns and takes four parameters:

| Column | Meaning |
|---|---|
| `subject_id` | the business thing being checked |
| `violated` | `true`, `false`, or `NULL` for "could not decide" |
| `evidence` | JSON kept with the Finding so a person can act on it |

| Parameter | Meaning |
|---|---|
| `$1` | baseline timestamp — how far back this Rule looks |
| `$2` | cursor: the last `subject_id` of the previous page |
| `$3` | page size |
| `$4` | optional single-subject filter, `''` during a full walk |

`NULL` for `violated` is the point of the third column. A check that could not
reach a provider is counted as `unknown`, never folded into `passed`, because
that is exactly how drift hides.

Before a Rule ever runs, `EXPLAIN` gates it on plan cost, estimated rows and
sequential scans. A Rule that would table-scan your largest table is rejected
with the reason, not run slowly.

## Make Findings survive the process

The default is ephemeral on purpose: the first run should need no provisioning
decision from whoever owns the database. When you want history, give RhinoQ a
database **of its own** — never the application's — and add `--store`:

```bash
docker run --rm \
  -e RHINOQ_SUBJECT_DATABASE_URL='postgres://rhinoq_readonly:...@host:5432/app?sslmode=disable' \
  -e RHINOQ_DATABASE_URL='postgres://rhinoq:...@host:5432/rhinoq?sslmode=disable' \
  -v "$PWD/rules.json:/etc/rhinoq/rules.json:ro" \
  ghcr.io/madebyduy/rhinoq:next \
  detect --rules /etc/rhinoq/rules.json --store --watch 5m
```

`--store` migrates RhinoQ's own database itself. Findings then deduplicate by
invariant key across runs, keep an occurrence count, resolve themselves when the
data is fixed and reopen as `regressed` if it breaks again. `--watch` re-scans
on an interval instead of exiting.

With a store you can also inspect Findings without re-scanning:

```bash
rhinoq findings list --rule completed-report-has-output
rhinoq workbench
```

## In CI

`--fail-on-finding` turns the detector into a check:

```bash
docker run --rm \
  -e RHINOQ_SUBJECT_DATABASE_URL="$STAGING_READONLY_URL" \
  -v "$PWD/rules.json:/etc/rhinoq/rules.json:ro" \
  ghcr.io/madebyduy/rhinoq:next \
  detect --rules /etc/rhinoq/rules.json --json --fail-on-finding
```

## From the Go library instead

The same detector is the library's smallest surface. `rhinoq.NewDetector`
takes the subject pool and, optionally, a store pool; pass `nil` for the store
to get the same ephemeral behaviour as the command:

```go
detector, err := rhinoq.NewDetector(subjects, nil)
summary, err := detector.Scan(ctx, rhinoq.ScanRequest{RuleID: "completed-report-has-output"})
```

[`main.go`](./main.go) is a complete version: it registers the Rule, passes it
through the Explain gate, scans and prints the Findings.

```bash
export RHINOQ_SUBJECT_DATABASE_URL='postgres://rhinoq_readonly:...@localhost:5432/app?sslmode=disable'
go run ./examples/integrity-only
```

## Evaluate on demand instead of on a schedule

A scan is the fallback, not the only trigger. An application that knows a
subject just changed can ask about that one row:

```go
_, err := detector.Changed(ctx, rhinoq.ChangeRequest{
    Subject: rhinoq.SubjectRef{Type: "report", ID: "report_missing"},
})
```

`Changed()` persists the signal first and evaluates only this report, using the
Rule's optional `$4` filter. The periodic scan remains the safety net if the
application misses a signal.

## What it will not do

RhinoQ does not repair the business row from a scan. Fix the data:

```sql
UPDATE public.rhinoq_example_reports
SET output_key = 'reports/report_missing.pdf', updated_at = now()
WHERE id = 'report_missing';
```

and run the detector again. The passing observation resolves the Finding.
Guarded repair exists, needs a registered application callback and a second
approver, and is a separate decision: see [Safe repair](../../docs/safe-repair.md).
