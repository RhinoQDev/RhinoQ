-- The only change RhinoQ's detector needs in an application database.
--
-- It grants SELECT and nothing else. RhinoQ creates no table here, applies no
-- migration here and holds no role that could write here, so the blast radius
-- of the evaluation is bounded by this file rather than by trust.
--
-- Before running this anywhere real: replace the password, replace `app` with
-- your database name, and narrow the GRANT to the tables your Rules actually
-- name once you know what they are.

CREATE ROLE rhinoq_readonly WITH LOGIN PASSWORD 'change-me';

GRANT CONNECT ON DATABASE app TO rhinoq_readonly;
GRANT USAGE ON SCHEMA public TO rhinoq_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO rhinoq_readonly;

-- Tables created after this role exists would otherwise be invisible to it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO rhinoq_readonly;

-- Belt and braces: even a mistaken GRANT later cannot turn this role into a
-- writer, because the session itself refuses to start a writing transaction.
ALTER ROLE rhinoq_readonly SET default_transaction_read_only = on;

-- A Rule that runs away is bounded by its own statement timeout, but the role
-- keeps a ceiling of its own so a bad Rule cannot hold a connection open.
ALTER ROLE rhinoq_readonly SET statement_timeout = '10s';
ALTER ROLE rhinoq_readonly SET idle_in_transaction_session_timeout = '30s';
