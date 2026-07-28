-- RhinoQ migration 008: authorize the login that invoked rhinoq.enqueue().
--
-- rhinoq.enqueue() is SECURITY DEFINER so it can write the queue tables
-- without granting producers direct table access. Inside a SECURITY DEFINER
-- function current_user is the function owner, not the application login.
-- Authorization must therefore use session_user or every call would be
-- evaluated using the owner's role membership.

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
    SELECT * INTO allowed
    FROM rhinoq.job_allowlist entry
    WHERE entry.job_name = enqueue.job_name;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'RHINOQ_JOB_NOT_ALLOWED: job name % is not registered in rhinoq.job_allowlist', job_name
            USING HINT = 'INSERT INTO rhinoq.job_allowlist (job_name) VALUES (''' || job_name || ''');';
    END IF;

    IF allowed.producer_role IS NOT NULL
       AND NOT pg_has_role(session_user, allowed.producer_role, 'MEMBER') THEN
        RAISE EXCEPTION 'RHINOQ_JOB_FORBIDDEN: role % may not enqueue %', session_user, job_name
            USING HINT = 'A service should only be able to enqueue jobs of its own domain.';
    END IF;

    IF payload IS NULL THEN
        RAISE EXCEPTION 'RHINOQ_PAYLOAD_REQUIRED: payload must not be null';
    END IF;

    encoded := convert_to(payload::text, 'UTF8');
    IF octet_length(encoded) > allowed.max_payload_bytes THEN
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

    INSERT INTO public.rhinoq_jobs
        (id, name, payload, state, class, priority, idempotency_key, correlation_id, not_before)
    VALUES
        (job_id, job_name, encoded, 'pending', use_class, use_prio,
         idempotency_key, correlation_id, now() + COALESCE(run_after, interval '0'))
    ON CONFLICT ON CONSTRAINT rhinoq_jobs_idempotency_unique
    DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO job_id;

    RETURN job_id;
END;
$$;

COMMENT ON FUNCTION rhinoq.enqueue IS
    'Transactional enqueue for any language. Authorizes the invoking login and validates job name, payload size, schema, class and priority.';

-- A producer must be granted both schema visibility and execution explicitly.
-- The function remains SECURITY DEFINER, so producers never need direct table
-- privileges.
REVOKE ALL ON FUNCTION rhinoq.enqueue(
    text, jsonb, text, text, integer, text, interval, text
) FROM PUBLIC;
