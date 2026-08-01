#!/usr/bin/env sh
set -eu

: "${RHINOQ_TEST_DATABASE_URL:?set RHINOQ_TEST_DATABASE_URL}"
: "${RHINOQ_RESTORE_DATABASE_URL:?set RHINOQ_RESTORE_DATABASE_URL to an empty drill database}"

archive="${TMPDIR:-/tmp}/rhinoq-restore-drill.dump"
pg_dump --format=custom --no-owner --no-acl "$RHINOQ_TEST_DATABASE_URL" --file "$archive"
pg_restore --exit-on-error --no-owner --no-acl --dbname "$RHINOQ_RESTORE_DATABASE_URL" "$archive"

source_versions=$(psql "$RHINOQ_TEST_DATABASE_URL" -Atc 'SELECT count(*) FROM rhinoq_schema_migrations')
restore_versions=$(psql "$RHINOQ_RESTORE_DATABASE_URL" -Atc 'SELECT count(*) FROM rhinoq_schema_migrations')
test "$source_versions" = "$restore_versions"

source_findings=$(psql "$RHINOQ_TEST_DATABASE_URL" -Atc 'SELECT count(*) FROM rhinoq_findings')
restore_findings=$(psql "$RHINOQ_RESTORE_DATABASE_URL" -Atc 'SELECT count(*) FROM rhinoq_findings')
test "$source_findings" = "$restore_findings"

echo "PASS restore drill: migrations=$restore_versions findings=$restore_findings"
