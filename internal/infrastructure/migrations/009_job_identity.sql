-- RhinoQ migration 009: split the overloaded job name into a four-part identity.
--
-- rhinoq_jobs.name meant four things at once: the execution lane, the handler
-- contract, the rate-limit key and the admission key. That forced two unrelated
-- handlers to share a rate limit in order to share a worker pool, and stopped
-- one handler from running in more than one lane.
--
-- Expand then contract, in this order, so the statements below never depend on
-- a column they just dropped:
--   1. add queue_name, job_name, group_key
--   2. backfill both names from the old name
--   3. enforce NOT NULL and the new identity constraints
--   4. move the idempotency scope from (name) to (queue_name)
--   5. rename class to resource_class
--   6. drop name last
--
-- There is no published release, so this migration does not keep a compatibility
-- view. An older binary must not run against this schema.
SET search_path = public;

-- 1. Expand.
ALTER TABLE rhinoq_jobs
    ADD COLUMN IF NOT EXISTS queue_name text,
    ADD COLUMN IF NOT EXISTS job_name text,
    ADD COLUMN IF NOT EXISTS group_key text;

-- 2. Backfill. Every existing job used one string for lane and contract, so the
-- only truthful migration is to copy it into both. group_key stays NULL: there
-- is no tenant information to recover, and inventing one would be worse than an
-- empty partition.
UPDATE rhinoq_jobs
SET queue_name = COALESCE(queue_name, name),
    job_name   = COALESCE(job_name, name)
WHERE queue_name IS NULL OR job_name IS NULL;

-- 3. Constrain.
ALTER TABLE rhinoq_jobs
    ALTER COLUMN queue_name SET NOT NULL,
    ALTER COLUMN job_name SET NOT NULL;

ALTER TABLE rhinoq_jobs
    DROP CONSTRAINT IF EXISTS rhinoq_jobs_identity_check;
ALTER TABLE rhinoq_jobs
    ADD CONSTRAINT rhinoq_jobs_identity_check
    CHECK (
        btrim(queue_name) <> ''
        AND btrim(job_name) <> ''
        AND length(queue_name) <= 128
        AND length(job_name) <= 128
        AND (group_key IS NULL OR length(group_key) <= 128)
    );

-- 4. Re-scope idempotency from the handler contract to the execution lane.
-- Enqueueing the same key twice into one lane still returns the first job; the
-- same key in a different lane is a different job.
ALTER TABLE rhinoq_jobs
    DROP CONSTRAINT IF EXISTS rhinoq_jobs_idempotency_unique;
ALTER TABLE rhinoq_jobs
    ADD CONSTRAINT rhinoq_jobs_idempotency_unique UNIQUE (queue_name, idempotency_key);

-- 5. Rename class. resource_class says what the column decides: which share of
-- a lane's admission budget the job may draw, and what is shed first under
-- pressure.
ALTER TABLE rhinoq_jobs RENAME COLUMN class TO resource_class;

ALTER TABLE rhinoq_jobs
    DROP CONSTRAINT IF EXISTS rhinoq_jobs_class_check;
ALTER TABLE rhinoq_jobs
    DROP CONSTRAINT IF EXISTS rhinoq_jobs_resource_class_check;
ALTER TABLE rhinoq_jobs
    ADD CONSTRAINT rhinoq_jobs_resource_class_check
    CHECK (resource_class IN ('critical', 'interactive', 'standard', 'batch', 'maintenance'));

-- 6. Indexes follow the lane, not the contract. Claim, admission and pause all
-- filter by queue_name; only dispatch cares about job_name.
DROP INDEX IF EXISTS rhinoq_jobs_pending_by_queue_idx;
CREATE INDEX IF NOT EXISTS rhinoq_jobs_pending_by_queue_idx
    ON rhinoq_jobs (queue_name)
    WHERE state IN ('pending', 'retry_wait');

DROP INDEX IF EXISTS rhinoq_jobs_claim_idx;
CREATE INDEX IF NOT EXISTS rhinoq_jobs_claim_idx
    ON rhinoq_jobs (queue_name, not_before, priority DESC, created_at, id)
    WHERE state IN ('pending', 'retry_wait');

-- group_key has no engine behaviour yet. The index exists so a tenant timeline
-- and per-tenant fairness can be added later without rewriting the hot table.
CREATE INDEX IF NOT EXISTS rhinoq_jobs_group_key_idx
    ON rhinoq_jobs (group_key, created_at DESC)
    WHERE group_key IS NOT NULL;

-- 7. Contract: drop the overloaded column last.
ALTER TABLE rhinoq_jobs DROP COLUMN IF EXISTS name;

-- The SQL producer path carries the same split. queue_name is added to the
-- allowlist so a DBA decides which lane a contract may be enqueued into, rather
-- than the caller choosing its own lane.
ALTER TABLE rhinoq.job_allowlist
    ADD COLUMN IF NOT EXISTS queue_name text;

UPDATE rhinoq.job_allowlist
SET queue_name = COALESCE(queue_name, job_name)
WHERE queue_name IS NULL;

ALTER TABLE rhinoq.job_allowlist
    ALTER COLUMN queue_name SET NOT NULL;

-- Drop the previous signature before creating the new one. Adding an argument
-- creates an overload rather than replacing the function, and while both exist
-- every unqualified reference to rhinoq.enqueue is ambiguous. Dropping first
-- also removes the window in which a caller could reach the old identity path.
DROP FUNCTION IF EXISTS rhinoq.enqueue(
    text, jsonb, text, text, integer, text, interval, text
);

CREATE OR REPLACE FUNCTION rhinoq.enqueue(
    job_name        text,
    payload         jsonb,
    idempotency_key text DEFAULT NULL,
    correlation_id  text DEFAULT NULL,
    priority        integer DEFAULT NULL,
    job_class       text DEFAULT NULL,
    run_after       interval DEFAULT NULL,
    payload_schema  text DEFAULT NULL,
    group_key       text DEFAULT NULL
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
            USING HINT = 'INSERT INTO rhinoq.job_allowlist (job_name, queue_name) VALUES (''' || job_name || ''', ''<lane>'');';
    END IF;

    -- The invoking login is what must be authorized. Inside SECURITY DEFINER
    -- current_user is the function owner, so session_user is the only correct
    -- subject here.
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

    IF group_key IS NOT NULL AND length(group_key) > 128 THEN
        RAISE EXCEPTION 'RHINOQ_GROUP_KEY_INVALID: group key must be at most 128 characters';
    END IF;

    use_class := COALESCE(job_class, allowed.default_class);
    IF use_class NOT IN ('critical', 'interactive', 'standard', 'batch', 'maintenance') THEN
        RAISE EXCEPTION 'RHINOQ_CLASS_INVALID: % is not a resource class', use_class;
    END IF;

    use_prio := COALESCE(priority, allowed.default_priority);
    IF use_prio < -100 OR use_prio > 100 THEN
        RAISE EXCEPTION 'RHINOQ_PRIORITY_INVALID: priority must be between -100 and 100';
    END IF;

    job_id := 'job_' || encode(gen_random_bytes(16), 'hex');

    INSERT INTO public.rhinoq_jobs
        (id, queue_name, job_name, group_key, payload, state, resource_class,
         priority, idempotency_key, correlation_id, not_before)
    VALUES
        (job_id, allowed.queue_name, enqueue.job_name, group_key, encoded,
         'pending', use_class, use_prio, idempotency_key, correlation_id,
         now() + COALESCE(run_after, interval '0'))
    ON CONFLICT ON CONSTRAINT rhinoq_jobs_idempotency_unique
    DO UPDATE SET job_name = EXCLUDED.job_name
    RETURNING id INTO job_id;

    RETURN job_id;
END;
$$;

COMMENT ON FUNCTION rhinoq.enqueue(
    text, jsonb, text, text, integer, text, interval, text, text
) IS
    'Transactional enqueue for any language. Authorizes the invoking login and validates job name, payload size, schema, resource class, priority and group key. The execution lane comes from the allowlist, not the caller.';

REVOKE ALL ON FUNCTION rhinoq.enqueue(
    text, jsonb, text, text, integer, text, interval, text, text
) FROM PUBLIC;
