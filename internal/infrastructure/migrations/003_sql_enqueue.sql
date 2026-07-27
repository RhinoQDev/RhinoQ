-- RhinoQ migration 003: the SQL enqueue function.
--
-- This is the cheapest way to use RhinoQ from a language that has no SDK yet:
-- any ORM can call it inside its own transaction, so the business write and the
-- job intent commit together and there is no dual write.
--
--   BEGIN;
--   INSERT INTO scans (...) VALUES (...);
--   SELECT rhinoq.enqueue(
--       job_name        => 'settle-scan-credit',
--       payload         => '{"scanId":"SCAN-9218"}'::jsonb,
--       idempotency_key => 'scan:SCAN-9218');
--   COMMIT;
--
-- An unrestricted enqueue(any_name, any_json) would let one compromised service
-- create work for every other domain, so the function validates instead of
-- trusting its caller (specification 53.3).

CREATE SCHEMA IF NOT EXISTS rhinoq;

-- gen_random_bytes() comes from pgcrypto, so it has to exist before the
-- function that uses it.
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN insufficient_privilege OR undefined_file THEN
    RAISE NOTICE 'pgcrypto is unavailable; rhinoq.enqueue() needs it for id generation';
END;
$$;

-- The allowlist is the permission boundary. A job name that is not registered
-- cannot be enqueued, no matter which role is connected.
CREATE TABLE IF NOT EXISTS rhinoq.job_allowlist (
    job_name          text PRIMARY KEY,
    -- producer_role restricts who may enqueue this job. NULL means any role
    -- that can execute the function.
    producer_role     text,
    payload_schema    text,
    max_payload_bytes integer NOT NULL DEFAULT 1048576
        CHECK (max_payload_bytes > 0 AND max_payload_bytes <= 1048576),
    default_class     text NOT NULL DEFAULT 'standard'
        CHECK (default_class IN ('critical', 'interactive', 'standard', 'batch', 'maintenance')),
    default_priority  integer NOT NULL DEFAULT 0
        CHECK (default_priority BETWEEN -100 AND 100),
    created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE rhinoq.job_allowlist IS
    'Job names that rhinoq.enqueue() accepts. Registering a job is a deliberate act.';

CREATE OR REPLACE FUNCTION rhinoq.enqueue(
    job_name        text,
    payload         jsonb,
    idempotency_key text DEFAULT NULL,
    correlation_id  text DEFAULT NULL,
    priority        integer DEFAULT NULL,
    job_class       text DEFAULT NULL,
    run_after       interval DEFAULT NULL,
    payload_schema  text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rhinoq, public
AS $$
DECLARE
    allowed    rhinoq.job_allowlist%ROWTYPE;
    encoded    bytea;
    job_id     text;
    use_class  text;
    use_prio   integer;
BEGIN
    SELECT * INTO allowed FROM rhinoq.job_allowlist entry WHERE entry.job_name = enqueue.job_name;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RHINOQ_JOB_NOT_ALLOWED: job name % is not registered in rhinoq.job_allowlist', job_name
            USING HINT = 'INSERT INTO rhinoq.job_allowlist (job_name) VALUES (''' || job_name || ''');';
    END IF;

    IF allowed.producer_role IS NOT NULL AND NOT pg_has_role(current_user, allowed.producer_role, 'MEMBER') THEN
        RAISE EXCEPTION 'RHINOQ_JOB_FORBIDDEN: role % may not enqueue %', current_user, job_name
            USING HINT = 'A service should only be able to enqueue jobs of its own domain.';
    END IF;

    IF payload IS NULL THEN
        RAISE EXCEPTION 'RHINOQ_PAYLOAD_REQUIRED: payload must not be null';
    END IF;

    encoded := convert_to(payload::text, 'UTF8');
    IF octet_length(encoded) > allowed.max_payload_bytes THEN
        -- Rejecting here keeps an oversized payload out of the table entirely.
        RAISE EXCEPTION 'RHINOQ_PAYLOAD_TOO_LARGE: % bytes exceeds the % byte limit for %',
            octet_length(encoded), allowed.max_payload_bytes, job_name
            USING HINT = 'Store the body elsewhere and enqueue a reference to it.';
    END IF;

    IF payload_schema IS NOT NULL AND allowed.payload_schema IS NOT NULL
       AND payload_schema <> allowed.payload_schema THEN
        RAISE EXCEPTION 'RHINOQ_PAYLOAD_SCHEMA_MISMATCH: % expects %, caller sent %',
            job_name, allowed.payload_schema, payload_schema;
    END IF;

    IF correlation_id IS NOT NULL AND length(correlation_id) > 128 THEN
        RAISE EXCEPTION 'RHINOQ_CORRELATION_INVALID: correlation id must be at most 128 characters';
    END IF;

    use_class := COALESCE(job_class, allowed.default_class);
    IF use_class NOT IN ('critical', 'interactive', 'standard', 'batch', 'maintenance') THEN
        RAISE EXCEPTION 'RHINOQ_CLASS_INVALID: % is not a job class', use_class;
    END IF;

    use_prio := COALESCE(priority, allowed.default_priority);
    IF use_prio < -100 OR use_prio > 100 THEN
        RAISE EXCEPTION 'RHINOQ_PRIORITY_INVALID: priority must be between -100 and 100';
    END IF;

    job_id := 'job_' || encode(gen_random_bytes(16), 'hex');

    INSERT INTO rhinoq_jobs
        (id, name, payload, state, class, priority, idempotency_key, correlation_id, not_before)
    VALUES
        (job_id, job_name, encoded, 'pending', use_class, use_prio,
         idempotency_key, correlation_id, now() + COALESCE(run_after, interval '0'))
    ON CONFLICT (name, idempotency_key)
    DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO job_id;

    RETURN job_id;
END;
$$;

COMMENT ON FUNCTION rhinoq.enqueue IS
    'Transactional enqueue for any language. Validates the job name, payload size, schema, class and priority before writing.';
