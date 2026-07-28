-- RhinoQ migration 011: correlate effects to a business subject and to
-- whichever system actually ran the work.
--
-- rhinoq_effects.job_id was NOT NULL and the dedup key, so the Effect Ledger
-- only worked for executions RhinoQ itself performed. That excluded the case it
-- is most needed for: a team already running BullMQ, Temporal, cron or a
-- hand-written worker has no RhinoQ job to attach to. Requiring them to migrate
-- their queue before they can check whether their data is correct inverts the
-- order in which trust is earned.
--
-- A job id becomes one kind of execution reference. Expand, backfill, re-key,
-- then relax, so no statement depends on a column state it has not reached yet.
SET search_path = public;

-- 1. Expand.
ALTER TABLE rhinoq_effects
    ADD COLUMN IF NOT EXISTS source_system text,
    ADD COLUMN IF NOT EXISTS source_id text,
    ADD COLUMN IF NOT EXISTS subject_type text,
    ADD COLUMN IF NOT EXISTS subject_id text,
    ADD COLUMN IF NOT EXISTS business_key text;

-- 2. Backfill. Every existing effect was produced by a RhinoQ job, so that is
-- its execution reference. Subject stays NULL: there is no business subject to
-- recover, and inventing one would be worse than an honest absence.
UPDATE rhinoq_effects
SET source_system = COALESCE(source_system, 'rhinoq'),
    source_id     = COALESCE(source_id, job_id)
WHERE source_system IS NULL OR source_id IS NULL;

-- 3. Constrain the new identity.
ALTER TABLE rhinoq_effects
    ALTER COLUMN source_system SET NOT NULL,
    ALTER COLUMN source_id SET NOT NULL;

ALTER TABLE rhinoq_effects
    DROP CONSTRAINT IF EXISTS rhinoq_effects_correlation_check;
ALTER TABLE rhinoq_effects
    ADD CONSTRAINT rhinoq_effects_correlation_check
    CHECK (
        btrim(source_system) <> ''
        AND btrim(source_id) <> ''
        AND length(source_system) <= 64
        AND length(source_id) <= 256
        -- A subject is optional, but half a subject is a bug: type without id
        -- cannot be looked up and id without type cannot be disambiguated.
        AND ((subject_type IS NULL AND subject_id IS NULL)
             OR (btrim(subject_type) <> '' AND btrim(subject_id) <> ''))
        AND (subject_type IS NULL OR length(subject_type) <= 64)
        AND (subject_id IS NULL OR length(subject_id) <= 256)
        AND (business_key IS NULL OR length(business_key) <= 256)
        -- A RhinoQ execution must carry its job id in both places, so the
        -- foreign key and the correlation cannot disagree about who ran it.
        AND (source_system <> 'rhinoq' OR job_id = source_id)
    );

-- 4. Re-key deduplication onto the execution reference. Keying on job_id would
-- stop deduplicating the moment job_id is allowed to be NULL, because NULLs are
-- distinct from each other: the same external effect could then be recorded
-- twice.
ALTER TABLE rhinoq_effects
    DROP CONSTRAINT IF EXISTS rhinoq_effects_job_id_name_idempotency_key_key;
ALTER TABLE rhinoq_effects
    DROP CONSTRAINT IF EXISTS rhinoq_effects_execution_unique;
ALTER TABLE rhinoq_effects
    ADD CONSTRAINT rhinoq_effects_execution_unique
    UNIQUE (source_system, source_id, name, idempotency_key);

-- 5. Relax. job_id stays a real foreign key when it is present, so runtime
-- fencing and cascade behaviour are unchanged for work RhinoQ ran.
ALTER TABLE rhinoq_effects
    ALTER COLUMN job_id DROP NOT NULL;

-- A subject timeline is the point of the whole model, so it gets an index
-- rather than a sequential scan over the ledger.
CREATE INDEX IF NOT EXISTS rhinoq_effects_subject_idx
    ON rhinoq_effects (subject_type, subject_id, created_at DESC)
    WHERE subject_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS rhinoq_effects_business_key_idx
    ON rhinoq_effects (business_key, created_at DESC)
    WHERE business_key IS NOT NULL;

COMMENT ON COLUMN rhinoq_effects.source_system IS
    'Which system ran the execution that opened this effect: rhinoq, bullmq, temporal, cron, app. A RhinoQ job is one kind of execution reference, not a precondition.';
COMMENT ON COLUMN rhinoq_effects.job_id IS
    'Set only when source_system is rhinoq. Keeps the foreign key and lease fencing for work RhinoQ leased; NULL for external executions, which have no lease to fence against.';
