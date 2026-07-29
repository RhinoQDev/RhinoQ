-- RhinoQ migration 017: per-attempt outcome.
--
-- A Task holds one aggregate result reference. A fan-out needs one per item:
-- without it the application must keep a parallel per-item store, which is the
-- plumbing the Task layer exists to remove. Existing rows backfill to NULL,
-- which reads as "this attempt produced no recorded artifact" and changes no
-- lifecycle meaning.
SET search_path = public;

ALTER TABLE rhinoq_task_executions
    ADD COLUMN IF NOT EXISTS result_ref text,
    ADD COLUMN IF NOT EXISTS failure_reason text;

ALTER TABLE rhinoq_task_executions
    DROP CONSTRAINT IF EXISTS rhinoq_task_executions_result_ref_check;

ALTER TABLE rhinoq_task_executions
    ADD CONSTRAINT rhinoq_task_executions_result_ref_check CHECK (
        result_ref IS NULL OR btrim(result_ref) <> ''
    );

-- The reason is polled with the snapshot, so it is bounded in the domain and
-- the bound is enforced here too rather than trusted.
ALTER TABLE rhinoq_task_executions
    DROP CONSTRAINT IF EXISTS rhinoq_task_executions_failure_reason_check;

ALTER TABLE rhinoq_task_executions
    ADD CONSTRAINT rhinoq_task_executions_failure_reason_check CHECK (
        failure_reason IS NULL OR char_length(failure_reason) <= 513
    );
