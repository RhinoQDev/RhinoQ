# Integrity-only example

This example detects a completed report whose output is missing. It starts no
queue, worker, claim loop, heartbeat, retry scheduler or recovery executor.

Prepare a disposable PostgreSQL database:

```bash
export RHINOQ_DATABASE_URL='postgres://postgres:postgres@localhost:5432/app?sslmode=disable'

go run ./cmd/rhinoq migrate plan
go run ./cmd/rhinoq migrate apply
psql "$RHINOQ_DATABASE_URL" -f examples/integrity-only/setup.sql
```

Run the example:

```bash
go run ./examples/integrity-only
```

Expected shape:

```text
observed=3 passed=2 violated=1 unknown=0 findings=1
finding subject=report_missing status=open evidence=...
```

Inspect the same persistent Finding without running the example again:

```bash
go run ./cmd/rhinoq findings list --rule completed-report-has-output
go run ./cmd/rhinoq workbench
```

Change `report_missing` so it has an output and scan again:

```sql
UPDATE public.rhinoq_example_reports
SET output_key = 'reports/report_missing.pdf',
    updated_at = now()
WHERE id = 'report_missing';
```

```bash
go run ./cmd/rhinoq scan completed-report-has-output
```

The passing observation resolves the existing Finding. RhinoQ does not repair
the business row itself.

In an application, the same Rule can run immediately after this update because
its query accepts the optional `$4` subject filter:

```go
_, err := integrity.Changed(ctx, rhinoq.ChangeRequest{
    Subject: rhinoq.SubjectRef{Type: "report", ID: "report_missing"},
})
```

`Changed()` persists the signal first and evaluates only this report. The
periodic scan remains the fallback if the application misses a signal.
