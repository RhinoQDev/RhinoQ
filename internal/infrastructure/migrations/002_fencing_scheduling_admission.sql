-- RhinoQ migration 002: lease fencing, priority scheduling, poison protection
-- and producer admission control. Expand only: every column is added with a
-- default, so an older binary keeps working against this schema.
SET search_path = public;

-- Fencing. lease_owner replaces the per-claim random lease_id: the owner says
-- who holds the job and lease_epoch says which execution, so a worker that lost
-- and re-acquired a job cannot be confused with the execution in between.
ALTER TABLE rhinoq_jobs
    ADD COLUMN IF NOT EXISTS lease_owner text,
    ADD COLUMN IF NOT EXISTS lease_epoch bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS class text NOT NULL DEFAULT 'standard',
    ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS crash_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS blocked_reason text;

-- Expand phase: lease_id keeps its data and is dropped in a later contract
-- migration, once no deployed binary reads it.
UPDATE rhinoq_jobs SET lease_owner = lease_id WHERE lease_owner IS NULL AND lease_id IS NOT NULL;

ALTER TABLE rhinoq_jobs
    DROP CONSTRAINT IF EXISTS rhinoq_jobs_class_check;
ALTER TABLE rhinoq_jobs
    ADD CONSTRAINT rhinoq_jobs_class_check
    CHECK (class IN ('critical', 'interactive', 'standard', 'batch', 'maintenance'));

ALTER TABLE rhinoq_jobs
    DROP CONSTRAINT IF EXISTS rhinoq_jobs_priority_check;
ALTER TABLE rhinoq_jobs
    ADD CONSTRAINT rhinoq_jobs_priority_check
    CHECK (priority BETWEEN -100 AND 100);

ALTER TABLE rhinoq_jobs
    DROP CONSTRAINT IF EXISTS rhinoq_jobs_blocked_reason_check;
ALTER TABLE rhinoq_jobs
    ADD CONSTRAINT rhinoq_jobs_blocked_reason_check
    CHECK (blocked_reason IS NULL OR state = 'blocked');

-- Claim ordering is priority first, then FIFO. The aging term in the ORDER BY
-- is not indexable, so the index covers the eligibility filter and leaves the
-- ranking to a sort over the already narrow candidate set.
DROP INDEX IF EXISTS rhinoq_jobs_claim_idx;
CREATE INDEX IF NOT EXISTS rhinoq_jobs_claim_idx
    ON rhinoq_jobs (not_before, priority DESC, created_at, id)
    WHERE state IN ('pending', 'retry_wait');

-- Admission control counts pending work per queue on every enqueue; without
-- this partial index that count would scan the whole queue.
CREATE INDEX IF NOT EXISTS rhinoq_jobs_pending_by_queue_idx
    ON rhinoq_jobs (name)
    WHERE state IN ('pending', 'retry_wait');

ALTER TABLE rhinoq_queue_controls
    ADD COLUMN IF NOT EXISTS admission_max_pending integer,
    ADD COLUMN IF NOT EXISTS admission_reserved_critical integer,
    ADD COLUMN IF NOT EXISTS admission_overflow_mode text,
    ADD COLUMN IF NOT EXISTS admission_delay_ms bigint,
    ADD COLUMN IF NOT EXISTS admission_retry_after_ms bigint;

ALTER TABLE rhinoq_queue_controls
    DROP CONSTRAINT IF EXISTS rhinoq_queue_controls_admission_check;
ALTER TABLE rhinoq_queue_controls
    ADD CONSTRAINT rhinoq_queue_controls_admission_check
    CHECK (
        admission_max_pending IS NULL
        OR (
            admission_max_pending > 0
            AND admission_reserved_critical >= 0
            AND admission_reserved_critical < admission_max_pending
            AND admission_overflow_mode IN ('reject', 'delay')
        )
    );

-- The effect ledger records which execution opened each entry, so a confirmed
-- effect can always be traced back to the attempt that caused it.
ALTER TABLE rhinoq_effects
    ADD COLUMN IF NOT EXISTS lease_epoch bigint NOT NULL DEFAULT 0;
