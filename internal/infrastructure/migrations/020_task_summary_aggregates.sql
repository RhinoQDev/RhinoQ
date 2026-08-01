-- Bounded Task summaries and an explicit unknown real-world outcome.
SET search_path = public;

ALTER TABLE rhinoq_tasks
    DROP CONSTRAINT IF EXISTS rhinoq_tasks_state_check;
ALTER TABLE rhinoq_tasks
    ADD CONSTRAINT rhinoq_tasks_state_check CHECK (state IN (
        'pending', 'queued', 'running', 'uncertain', 'succeeded',
        'failed', 'cancel_requested', 'cancelled'
    ));

ALTER TABLE rhinoq_tasks
    ADD COLUMN IF NOT EXISTS execution_total bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS execution_pending_dispatch bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS execution_dispatched bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS execution_running bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS execution_succeeded bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS execution_failed bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS execution_stalled bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS execution_cancelled bigint NOT NULL DEFAULT 0;

WITH counts AS (
    SELECT task_id,
           count(*) AS total,
           count(*) FILTER (WHERE state='pending_dispatch') AS pending_dispatch,
           count(*) FILTER (WHERE state='dispatched') AS dispatched,
           count(*) FILTER (WHERE state='running') AS running,
           count(*) FILTER (WHERE state='succeeded') AS succeeded,
           count(*) FILTER (WHERE state='failed') AS failed,
           count(*) FILTER (WHERE state='stalled') AS stalled,
           count(*) FILTER (WHERE state='cancelled') AS cancelled
    FROM rhinoq_task_executions GROUP BY task_id
)
UPDATE rhinoq_tasks AS task
SET execution_total=counts.total,
    execution_pending_dispatch=counts.pending_dispatch,
    execution_dispatched=counts.dispatched,
    execution_running=counts.running,
    execution_succeeded=counts.succeeded,
    execution_failed=counts.failed,
    execution_stalled=counts.stalled,
    execution_cancelled=counts.cancelled
FROM counts WHERE counts.task_id=task.id;

ALTER TABLE rhinoq_tasks
    ADD CONSTRAINT rhinoq_tasks_execution_counts_check CHECK (
        execution_total >= 0 AND execution_pending_dispatch >= 0 AND
        execution_dispatched >= 0 AND execution_running >= 0 AND
        execution_succeeded >= 0 AND execution_failed >= 0 AND
        execution_stalled >= 0 AND execution_cancelled >= 0 AND
        execution_total = execution_pending_dispatch + execution_dispatched +
            execution_running + execution_succeeded + execution_failed +
            execution_stalled + execution_cancelled
    );
