# Migration recovery

RhinoQ migrations are additive and checksum tracked. Never edit an applied SQL
file and never delete migration-history rows to make a deployment look healthy.

Before deployment:

1. run `rhinoq migrate plan` and archive `rhinoq migrate sql` with the release;
2. take a PostgreSQL backup and complete `scripts/restore-drill.sh`;
3. deploy expand-compatible schema before new application binaries.

If application rollout fails, roll back the binary while leaving additive
columns/tables in place. If a migration itself fails, stop writers, restore the
pre-migration backup into a new database, verify migration/Finding counts, then
switch traffic. Repair forward with a new migration; do not mutate history.

## 023_subject_outcome_hot_path

Unlike every migration before it, 023 changes existing rows and tightens a
constraint. Read this before applying it.

It does three things:

1. sets `evidence` to `NULL` on every `rhinoq_subject_outcomes` row whose status
   is `passed`, and adds a `CHECK` that keeps it that way;
2. drops the foreign key from `rhinoq_subject_outcomes` to `rhinoq_rules`;
3. adds a partial index on `last_observed_at` for retention.

**Apply it before the new binary, not after.** A binary from this release writes
no evidence for a passing subject, so it is compatible with the old schema. The
reverse is not true: an older binary against the new schema writes evidence for
a pass and the `CHECK` rejects the whole page, which fails the scan rather than
corrupting anything — but it fails every scan until one side is moved.

Step 1 rewrites rows. On a large deployment take the row count first
(`SELECT count(*) FROM rhinoq_subject_outcomes WHERE status = 'passed' AND
evidence IS NOT NULL`) and expect the `UPDATE` to be the long part of the
migration. It holds a row lock for its duration, so run it in a window where no
scan is writing.

**What is lost:** the last evidence recorded for subjects that currently pass.
Evidence for `violated` and `unknown` subjects, every Finding, every Finding's
`latest_evidence` and the whole lifecycle history are untouched. If that
passing-state evidence matters to you, export it before applying:

```sql
COPY (SELECT rule_id, rule_version, subject_type, subject_id, evidence,
             last_observed_at
      FROM rhinoq_subject_outcomes
      WHERE status = 'passed' AND evidence IS NOT NULL)
TO '/tmp/passing-evidence.csv' WITH CSV HEADER;
```

**Rolling back** means dropping the `CHECK` and restoring the foreign key. The
cleared evidence does not come back except from that export, so treat the export
as the rollback plan rather than the migration history.
