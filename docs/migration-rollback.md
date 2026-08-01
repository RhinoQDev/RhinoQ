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
