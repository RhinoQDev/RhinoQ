-- The compose-only variant of readonly-role.sql: same privileges, a throwaway
-- password, and idempotent so a re-created volume does not fail the init.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhinoq_readonly') THEN
        CREATE ROLE rhinoq_readonly WITH LOGIN PASSWORD 'readonly';
    END IF;
END
$$;

GRANT CONNECT ON DATABASE app TO rhinoq_readonly;
GRANT USAGE ON SCHEMA public TO rhinoq_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO rhinoq_readonly;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO rhinoq_readonly;

ALTER ROLE rhinoq_readonly SET default_transaction_read_only = on;
ALTER ROLE rhinoq_readonly SET statement_timeout = '10s';
ALTER ROLE rhinoq_readonly SET idle_in_transaction_session_timeout = '30s';
