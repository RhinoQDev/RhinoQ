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

## 026_tenant_rbac and 027_tenant_row_level_security

These two introduce the tenant boundary. They add columns and policies rather
than rewriting rows, so they are cheap to apply — but they change the
*preconditions* for a working connection, and getting the order wrong takes
writes offline. Read this before applying them.

**Apply the connection change first, then the migrations.** Not the other way
round.

### Step 1 — put the tenant on the connection string, before touching schema

```
postgres://user:pass@host:5432/rhinoq?options=-c%20rhinoq.tenant_id%3Dtnt_system
```

`rhinoq.tenant_id` is a custom parameter. On the pre-026 schema nothing reads
it, so this deploy is a no-op and can go out on its own, ahead of any schema
change. `tnt_system` is the tenant 026 backfills every existing row into.

Doing this first is what makes the migrations expand-compatible. Every
`tenant_id` column is `NOT NULL` and defaults to the session tenant, so a
binary that predates this release keeps inserting normally throughout the
upgrade — it simply never mentions the column, and the default fills it. A
connection *without* the option gets `NULL` from the default and fails on the
`NOT NULL` constraint, which is why the order matters.

`tests/postgres/tenant_isolation_test.go` asserts that every one of those
columns still carries the default, so this property cannot be removed silently.

### Step 2 — apply 026 and 027

Apply them together. They are additive: new tables, a `tenant_id` column per
tenant-owned table, composite foreign keys and row-level policies.

### Step 3 — stop connecting as a superuser

This is the step most deployments will get wrong, and it fails silently.

PostgreSQL exempts **superusers** and roles with **BYPASSRLS** from row-level
security, `FORCE ROW LEVEL SECURITY` included. The official `postgres` Docker
image makes `POSTGRES_USER` a superuser. Connect as that role and every policy
these migrations install is ignored: all tenants share one dataset, nothing
errors, and your tests pass.

```sql
CREATE ROLE rhinoq_app LOGIN PASSWORD '...'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO rhinoq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rhinoq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rhinoq_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO rhinoq_app;
```

Migrations still run as the owner. The runtime must not.

Verify with `rhinoq doctor`, which reports this as a **FAIL** rather than a
warning — it is the one finding here that a running system gives no other
signal for:

```console
Tenant isolation
  FAIL tenant isolation is not in force
       the role "rhinoq" holds SUPERUSER, so PostgreSQL ignores every tenant
       policy and all tenants share one dataset
```

### Background jobs that cross tenants

Retention, the notification scheduler and recovery sweeps are legitimately
cross-tenant. They set `rhinoq.maintenance=on` instead of a tenant:

```
postgres://user:pass@host:5432/rhinoq?options=-c%20rhinoq.maintenance%3Don
```

This is not a security boundary. Any session may `SET` a custom parameter, and
PostgreSQL 16 offers no privilege that restricts one. It marks intent and keeps
cross-tenant work visible; it does not contain a compromised process.

### What changes for queue controls

`rhinoq_queue_controls` was keyed by `queue_name` alone, so pausing `exports`
paused it for every tenant using that name. The primary key is now
`(tenant_id, queue_name)`. A single-tenant deployment sees no behaviour change;
a deployment that shared one database between environments will find pauses no
longer leak between them, which is the fix rather than a regression.

**Rolling back** means dropping the policies (`ALTER TABLE ... NO FORCE ROW
LEVEL SECURITY`, `DROP POLICY`) and leaving the columns in place. The columns
are additive and harmless to an older binary as long as the defaults remain.
Do not drop `tenant_id`: it is referenced by the composite foreign keys that
prevent cross-tenant child rows.
