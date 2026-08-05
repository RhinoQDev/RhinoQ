#!/bin/sh
# Create the replication role and let the replica connect. This runs once, on
# the primary, before it accepts application traffic.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
	CREATE ROLE ${REPLICATION_USER} WITH REPLICATION LOGIN PASSWORD '${REPLICATION_PASSWORD}';

	-- The application role RhinoQ is meant to run as. It is created here
	-- rather than by a migration because roles are cluster-wide, and because
	-- the attributes are the point: without NOSUPERUSER and NOBYPASSRLS,
	-- PostgreSQL ignores every tenant policy migration 027 installs.
	CREATE ROLE rhinoq_app LOGIN PASSWORD 'rhinoq_app'
	    NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
SQL

# pg_hba is appended rather than rewritten so the image's own rules survive.
cat >> "$PGDATA/pg_hba.conf" <<-HBA
	host replication ${REPLICATION_USER} all scram-sha-256
	host all         rhinoq_app          all scram-sha-256
HBA
