-- Keep cancellation command outcome separate from the Task terminal state.
-- Existing Tasks did not record a cancellation operation, so they backfill to
-- `none` without changing lifecycle meaning.
SET search_path = public;

ALTER TABLE rhinoq_tasks
    ADD COLUMN IF NOT EXISTS cancellation_status text NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS cancellation_reason text;

ALTER TABLE rhinoq_tasks
    DROP CONSTRAINT IF EXISTS rhinoq_tasks_cancellation_status_check;

ALTER TABLE rhinoq_tasks
    ADD CONSTRAINT rhinoq_tasks_cancellation_status_check CHECK (
        cancellation_status IN (
            'none', 'requested', 'acknowledged', 'cancelled', 'too_late',
            'cannot_cancel_safely', 'failed'
        )
    );
